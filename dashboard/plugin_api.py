"""Provider Usage: backend half.

FastAPI router mounted at ``/api/plugins/provider-usage/`` by the Hermes
dashboard server. Serves one aggregate JSON payload for the desktop status
bar; provider API calls happen here, on the user's machine.

Providers appear only when their credentials are usable; unconfigured
providers are omitted (never rendered as errors). Credential handling is
read-only throughout: no writes, no token refresh, no browser cookies, no
credential CLIs.

Credential sources (read-only):

- OpenCode Zen: no metered-spend HTTP endpoint exists, so cost comes
  read-only from the local OpenCode CLI ledger
  (``~/.local/share/opencode/opencode.db``, ``session.cost`` sums for
  provider ``opencode``, calendar month to date).
- OpenCode Go: ``OPENCODE_GO_API_KEY`` from the Hermes secret scope,
  falling back to the ``opencode-go`` entry of
  ``~/.local/share/opencode/auth.json`` (never the Zen key); a 403
  means no Go subscription and hides the provider.
- OpenAI Codex: Hermes' Codex sign-in via the account-usage helper, falling
  back to ``~/.codex/auth.json`` (expired token surfaces as unavailable;
  re-auth in the Codex CLI).
- OpenRouter: ``OPENROUTER_API_KEY`` from the Hermes secret scope, with a
  read-only fallback to ``$HERMES_HOME/.env``.
- Anthropic / Nous: resolved by Hermes' own read-only account-usage helpers
  (the user's existing Hermes sign-ins).
- DeepSeek / Kimi / Z.AI / MiniMax / GitHub Copilot: provider keys from the
  Hermes secret scope (never ``os.environ``), read-only.

Endpoints hit (GET, machine credentials attached):

- https://opencode.ai/zen/go/v1/usage (Go only; Zen cost is read from the local ledger)
- https://chatgpt.com/backend-api/wham/usage
- https://openrouter.ai/api/v1/key and https://openrouter.ai/api/v1/credits
- https://api.anthropic.com/api/oauth/usage (via Hermes)
- https://api.deepseek.com/user/balance
- https://api.kimi.com/coding/v1/usages, https://api.moonshot.cn/v1/users/me/balance
- https://api.z.ai/api/monitor/usage/quota/limit
- https://api.minimax.io/v1/api/openplatform/coding_plan/remains
- https://api.github.com/copilot_internal/user

All provider HTTPS calls use httpx in-process; no subprocesses are spawned.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter

router = APIRouter()

TTL = 300.0
HOME = Path.home()

_lock = threading.Lock()
_cache = {"at": 0.0, "payload": None}


class _Skip(Exception):
    """Provider has no usable credentials -> omitted from the payload."""

PROVIDER_META = {
    "opencode-zen": {"name": "OpenCode Zen", "tag": "API"},
    "opencode-go": {"name": "OpenCode Go", "tag": "Plan"},
    "openai-codex": {"name": "OpenAI Codex", "tag": "Plus"},
    "openrouter": {"name": "OpenRouter", "tag": "Credits"},
    "anthropic": {"name": "Anthropic", "tag": "Claude Code"},
    "copilot": {"name": "GitHub Copilot", "tag": "Quota"},
    "nous": {"name": "Nous", "tag": "Portal"},
    "zai": {"name": "Z.AI", "tag": "GLM"},
    "kimi-coding": {"name": "Kimi", "tag": "Coding"},
    "minimax": {"name": "MiniMax", "tag": "Coding"},
    "deepseek": {"name": "DeepSeek", "tag": "Balance"},
}

# Display and fetch order for the panel.
FETCH_ORDER = (
    "opencode-zen", "opencode-go",
    "openai-codex",
    "openrouter",
    "anthropic",
    "copilot",
    "nous",
    "zai",
    "kimi-coding",
    "minimax",
    "deepseek",
)


def _hermes_env_value(name):
    """Read-only fallback: the profile's own .env (never os.environ)."""
    try:
        from hermes_constants import get_hermes_home
        env_path = get_hermes_home() / ".env"
    except Exception:
        env_path = Path.home() / ".hermes" / ".env"
    try:
        for line in env_path.read_text().splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def _secret(*names):
    """First resolvable credential among ``names`` through Hermes' secret
    scope, falling back to the profile's .env. Read-only, no os.environ."""
    for name in names:
        try:
            from agent.secret_scope import get_secret
            value = get_secret(name)
            if value:
                return value
        except Exception:
            pass
        value = _hermes_env_value(name)
        if value:
            return value
    return None


def _iso_dt(dt):
    if isinstance(dt, datetime):
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return None


def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _decode_json_body(resp):
    """Parse a provider body, refusing non-JSON payloads.

    Some OpenCode endpoints are catch-alls: HTTP 200 with the literal
    text "Not Found". resp.json() on that raises a bare JSONDecodeError;
    we surface a clear provider error instead.
    """
    text = (resp.text or "").lstrip()
    if not text.startswith(("{", "[")):
        raise ValueError("non-JSON response (HTTP %d): %s" % (resp.status_code, text[:60] or "<empty>"))
    return json.loads(text) or {}


def _http_json(url, headers, *, timeout=12.0):
    with httpx.Client(timeout=timeout) as client:
        resp = client.get(url, headers=headers)
        if resp.status_code in (401, 403):
            # 403 covers both a rejected credential and a missing plan
            # entitlement (e.g. OpenCode Go without a subscription).
            raise PermissionError("HTTP %d: credential rejected or entitlement missing" % resp.status_code)
        if resp.status_code == 404:
            raise FileNotFoundError("HTTP 404: endpoint not offered for this account")
        resp.raise_for_status()
        return _decode_json_body(resp)


def fetch_opencode_go():
    """OpenCode Go = subscription plan -> quota windows.

    Key resolution must NEVER fall back to the Zen API key (auth.json
    entry 'opencode'): the Go endpoint answers those requests with
    403 EntitlementError, which used to render a red error card for
    every Zen-only user. No Go credential, or 403 with one, means
    'no Go subscription' -> hide the provider (module contract:
    unconfigured providers are omitted, never shown as errors).
    """
    key = _secret("OPENCODE_GO_API_KEY")
    if not key:
        try:
            d = json.loads((HOME / ".local/share/opencode/auth.json").read_text())
            entry = d.get("opencode-go")
            if isinstance(entry, dict):
                key = entry.get("key")
        except (OSError, ValueError):
            pass
    if not key:
        raise _Skip("opencode-go")
    try:
        d = _http_json(
            "https://opencode.ai/zen/go/v1/usage",
            {"Authorization": "Bearer " + key, "Accept": "application/json"},
        )
    except PermissionError:
        raise _Skip("opencode-go")  # entitlement error: no Go plan on this account
    u = d.get("usage") or {}
    windows = []
    for wid, label in (("rolling", "5h"), ("weekly", "7d"), ("monthly", "Monthly")):
        w = u.get(wid) or {}
        percent = _num(w.get("percent"))
        if percent is None:
            continue  # missing metric: never render a fabricated 0% bar
        windows.append({
            "label": label,
            "percent": percent,
            "resets_at": w.get("resetsAt"),
            "status": w.get("status", "ok"),
        })
    if not windows:
        raise _Skip("opencode-go")
    return {"id": "opencode-go", "status": "ok", "windows": windows}


def _opencode_db_uri():
    """Read-only URI for the OpenCode CLI ledger (spaces percent-encoded;
    sqlite URIs reject raw spaces and backslashes on Windows)."""
    db = HOME / ".local/share/opencode/opencode.db"
    if not db.exists():
        return None
    return "file:" + db.as_posix().replace(" ", "%20") + "?mode=ro"


def _month_start_ms():
    """Epoch milliseconds at 00:00 local time on the first of this month."""
    return datetime.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000


def fetch_opencode_zen():
    """OpenCode Zen = metered API -> actual dollar spend, nothing else.

    Zen exposes no spend/usage HTTP endpoint (all zen/v1 paths are 403
    or a 'Not Found' catch-all; upstream anomalyco/opencode#44189 tracks
    an official balance API). The OpenCode CLI's local SQLite ledger is
    the grounded source: session.cost is the metered price OpenCode
    charged per session, and its provider model JSON carries
    providerID 'opencode' == Zen. Free Zen models have cost 0.0, so the
    sum is real spend -- $0.00 here is measured, never fabricated.
    """
    uri = _opencode_db_uri()
    if uri is None:
        raise _Skip("opencode-zen")
    month_start = _month_start_ms()
    con = sqlite3.connect(uri, uri=True, timeout=2.0)
    try:
        spend = con.execute(
            "select coalesce(sum(cost), 0.0) from session "
            "where json_extract(model, '$.providerID') = 'opencode' "
            "and time_created >= ?",
            (month_start,),
        ).fetchone()[0]
    except sqlite3.Error as exc:
        raise RuntimeError("OpenCode ledger unreadable: %s" % exc)
    finally:
        con.close()
    return {
        "id": "opencode-zen",
        "status": "ok",
        "money": [{"label": "Spend (month)", "left": round(float(spend), 2), "cur": "USD"}],
    }


def fetch_openai_codex():
    # Hermes sign-in first (auth store + credential pool), then the Codex CLI store.
    payload = _hermes_usage("openai-codex")
    if payload is not None:
        # Hermes labels the Codex windows Session / Weekly; keep our usual 5h / 7d.
        for w in payload.get("windows") or []:
            label = str(w.get("label") or "").strip().lower()
            if label == "session":
                w["label"] = "5h"
            elif label == "weekly":
                w["label"] = "7d"
        return payload
    tok = None
    try:
        d = json.loads((HOME / ".codex/auth.json").read_text())
        tok = (d.get("tokens") or {}).get("access_token") or d.get("OPENAI_API_KEY")
    except (OSError, ValueError):
        pass
    if not tok:
        raise _Skip("openai-codex")
    d = _http_json("https://chatgpt.com/backend-api/wham/usage", {"Authorization": "Bearer " + tok, "Accept": "application/json"})
    rl = d.get("rate_limit") or {}
    now = time.time()
    windows = []
    for w, label in ((rl.get("primary_window"), "5h"), (rl.get("secondary_window"), "7d")):
        if not isinstance(w, dict):
            continue
        ra = w.get("reset_after_seconds")
        resets_at = None
        if isinstance(ra, (int, float)):
            resets_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + ra))
        windows.append({
            "label": label,
            "percent": w.get("used_percent"),
            "resets_at": resets_at,
            "status": "ok",
        })
    plan = (d.get("plan_type") or "").strip()
    return {"id": "openai-codex", "status": "ok", "plan": plan or None, "windows": windows}


def fetch_openrouter():
    key = _secret("OPENROUTER_API_KEY")
    if not key:
        raise _Skip("openrouter")
    hdr = {"Authorization": "Bearer " + key, "Accept": "application/json"}
    k = (_http_json("https://openrouter.ai/api/v1/key", hdr).get("data") or {})
    c = (_http_json("https://openrouter.ai/api/v1/credits", hdr).get("data") or {})
    money = []
    total, used = c.get("total_credits"), c.get("total_usage")
    if isinstance(total, (int, float)) and isinstance(used, (int, float)):
        money.append({"label": "Balance", "left": round(total - used, 2), "total": round(total, 2), "cur": "USD"})
    limit, cap_used = k.get("limit"), k.get("usage")
    if isinstance(limit, (int, float)) and isinstance(cap_used, (int, float)):
        money.append({"label": "Key cap", "left": round(limit - cap_used, 2), "total": round(limit, 2), "cur": "USD"})
    return {"id": "openrouter", "status": "ok", "money": money}


# --------------------------------------------------------------------------- #
# Fetchers: providers resolved by Hermes' read-only account-usage helpers
# --------------------------------------------------------------------------- #


def _hermes_usage(provider):
    """Map a Hermes AccountUsageSnapshot onto our payload schema; None when
    the provider is not usable from this machine."""
    try:
        from agent.account_usage import fetch_account_usage
    except ImportError:
        return None
    snap = fetch_account_usage(provider)
    if snap is None or not snap.available:
        return None
    windows = []
    for w in snap.windows or ():
        used = w.used_percent
        if not isinstance(used, (int, float)):
            continue
        windows.append({
            "label": str(w.label or "Window"),
            "percent": round(float(used), 1),
            "resets_at": _iso_dt(w.reset_at),
            "status": "ok",
        })
    if not windows:
        return None
    return {"id": provider, "status": "ok", "windows": windows}


def _fetch_hermes(provider):
    payload = _hermes_usage(provider)
    if payload is None:
        raise _Skip(provider)
    return payload


def fetch_anthropic():
    return _fetch_hermes("anthropic")


def fetch_nous():
    try:
        from agent.account_usage import build_nous_credits_snapshot
        from hermes_cli.nous_account import get_nous_portal_account_info
    except ImportError:
        raise _Skip("nous")
    with ThreadPoolExecutor(max_workers=1) as pool:
        info = pool.submit(get_nous_portal_account_info, force_fresh=True).result(timeout=10.0)
    snap = build_nous_credits_snapshot(info)
    if snap is None or not snap.available:
        raise _Skip("nous")
    windows = []
    for w in snap.windows or ():
        used = w.used_percent
        if not isinstance(used, (int, float)):
            continue
        windows.append({
            "label": str(w.label or "Credits"),
            "percent": round(float(used), 1),
            "resets_at": _iso_dt(w.reset_at),
            "status": "ok",
        })
    if not windows:
        raise _Skip("nous")
    return {"id": "nous", "status": "ok", "windows": windows}


def fetch_copilot():
    try:
        from hermes_cli.copilot_auth import resolve_copilot_token
    except ImportError:
        raise _Skip("copilot")
    try:
        token, _ = resolve_copilot_token()
    except Exception:
        token = None
    if not token:
        raise _Skip("copilot")
    payload = _http_json(
        "https://api.github.com/copilot_internal/user",
        {
            "Authorization": "token " + str(token),
            "Accept": "application/json",
            "Editor-Version": "vscode/1.96.2",
            "Editor-Plugin-Version": "copilot-chat/0.23.0",
            "User-Agent": "GitHubCopilotChat/0.23.0",
        },
    )
    snapshots = payload.get("quota_snapshots") or {}
    reset_at = payload.get("quota_reset_date") or payload.get("limited_user_reset_date")
    windows = []
    for key, label in (("premium_interactions", "Premium requests"), ("chat", "Chat"), ("completions", "Completions")):
        entry = snapshots.get(key) or {}
        if not isinstance(entry, dict) or entry.get("unlimited"):
            continue
        entitlement = entry.get("entitlement")
        if isinstance(entitlement, (int, float)) and entitlement <= 0:
            continue
        remaining = entry.get("percent_remaining")
        if not isinstance(remaining, (int, float)):
            continue
        windows.append({
            "label": label,
            "percent": round(max(0.0, min(100.0, 100.0 - float(remaining))), 1),
            "resets_at": reset_at if isinstance(reset_at, str) else None,
            "status": "ok",
        })
    if not windows:
        raise _Skip("copilot")
    return {"id": "copilot", "status": "ok", "windows": windows}


# --------------------------------------------------------------------------- #
# Fetchers: direct provider APIs (key-gated, read-only)
# --------------------------------------------------------------------------- #


def fetch_deepseek():
    key = _secret("DEEPSEEK_API_KEY")
    if not key:
        raise _Skip("deepseek")
    payload = _http_json("https://api.deepseek.com/user/balance", {"Authorization": "Bearer " + key})
    money = []
    for info in payload.get("balance_infos") or []:
        if not isinstance(info, dict):
            continue
        total = _num(info.get("total_balance"))
        if total is None:
            continue
        money.append({"label": "Balance", "left": round(total, 2), "cur": str(info.get("currency") or "USD")[:8]})
    if not money:
        raise RuntimeError("DeepSeek returned no balance rows")
    return {"id": "deepseek", "status": "ok", "money": money}


def fetch_kimi():
    key = _secret("KIMI_API_KEY")
    if not key:
        raise _Skip("kimi-coding")
    headers = {"Authorization": "Bearer " + key, "Accept": "application/json"}
    # Coding-plan quota first; fall back to the Moonshot open-platform balance.
    payload = None
    try:
        payload = _http_json("https://api.kimi.com/coding/v1/usages", headers)
    except Exception:
        payload = None
    if isinstance(payload, dict):
        windows = []
        usage = payload.get("usage") or {}
        used, limit = _num(usage.get("used")), _num(usage.get("limit"))
        if used is not None and limit:
            windows.append({
                "label": "Weekly",
                "percent": round(max(0.0, min(100.0, used / limit * 100.0)), 1),
                "resets_at": usage.get("resetTime") if isinstance(usage.get("resetTime"), str) else None,
                "status": "ok",
            })
        for entry in payload.get("limits") or []:
            if not isinstance(entry, dict):
                continue
            percent = _num(entry.get("percentage"))
            if percent is None:
                continue
            windows.append({
                "label": str(entry.get("window") or entry.get("name") or "Limit"),
                "percent": round(max(0.0, min(100.0, percent)), 1),
                "resets_at": entry.get("resetTime") or entry.get("reset_time"),
                "status": "ok",
            })
        if windows:
            return {"id": "kimi-coding", "status": "ok", "windows": windows}
    balance = _http_json("https://api.moonshot.cn/v1/users/me/balance", headers)
    available = _num(balance.get("available"))
    if available is None:
        raise RuntimeError("Kimi returned no usage windows or balance")
    return {"id": "kimi-coding", "status": "ok",
            "money": [{"label": "Balance", "left": round(available, 2), "cur": "CNY"}]}


def fetch_zai():
    key = _secret("ZAI_API_KEY", "GLM_API_KEY")
    if not key:
        raise _Skip("zai")
    payload = _http_json(
        "https://api.z.ai/api/monitor/usage/quota/limit",
        {"Authorization": "Bearer " + key, "Accept": "application/json"},
    )
    windows = []
    for item in payload.get("limits") or []:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("type") or "").upper()
        percent = _num(item.get("percentage"))
        total, current, usage_value = item.get("total"), item.get("currentValue"), item.get("usage")
        if percent is None:
            base = total if isinstance(total, (int, float)) else usage_value
            if isinstance(current, (int, float)) and isinstance(base, (int, float)) and base:
                percent = float(current) / float(base) * 100.0
        if percent is None:
            continue
        if kind == "TOKENS_LIMIT":
            label = "Session (5h)"
        elif kind == "TIME_LIMIT":
            label = "Tool quota"
        elif item.get("unit") == 6:
            label = "Weekly"
        else:
            label = kind.replace("_", " ").title() or "Limit"
        windows.append({
            "label": label,
            "percent": round(max(0.0, min(100.0, float(percent))), 1),
            "resets_at": None,
            "status": "ok",
        })
    if not windows:
        raise RuntimeError("Z.AI returned no parseable quota limits")
    return {"id": "zai", "status": "ok", "windows": windows}


def fetch_minimax():
    key = _secret("MINIMAX_API_KEY")
    if not key:
        raise _Skip("minimax")
    headers = {"Authorization": "Bearer " + key, "Accept": "application/json"}
    payload = None
    last_error = None
    for url in (
        "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
        "https://www.minimax.io/v1/api/openplatform/coding_plan/remains",
    ):
        try:
            payload = _http_json(url, headers)
            break
        except Exception as exc:
            last_error = exc
    if not isinstance(payload, dict):
        raise RuntimeError("MiniMax quota probe failed: %s" % (last_error or "no endpoint"))
    windows = []
    for row in payload.get("model_remains") or []:
        if not isinstance(row, dict):
            continue
        model_name = str(row.get("model_name") or "Model")[:24]
        for total_key, used_key, label in (
            ("current_interval_total_count", "current_interval_usage_count", "5h"),
            ("current_weekly_total_count", "current_weekly_usage_count", "weekly"),
        ):
            total, used = row.get(total_key), row.get(used_key)
            if isinstance(total, (int, float)) and total > 0 and isinstance(used, (int, float)):
                used_clamped = min(max(used, 0), total)
                windows.append({
                    "label": "%s · %s" % (model_name, label),
                    "percent": round(used_clamped / total * 100.0, 1),
                    "resets_at": None,
                    "status": "ok",
                })
    if not windows:
        raise RuntimeError("MiniMax returned no parseable coding-plan rows")
    return {"id": "minimax", "status": "ok", "windows": windows}


FETCHERS = {
    "opencode-zen": fetch_opencode_zen,
    "opencode-go": fetch_opencode_go,
    "openai-codex": fetch_openai_codex,
    "openrouter": fetch_openrouter,
    "anthropic": fetch_anthropic,
    "copilot": fetch_copilot,
    "nous": fetch_nous,
    "zai": fetch_zai,
    "kimi-coding": fetch_kimi,
    "minimax": fetch_minimax,
    "deepseek": fetch_deepseek,
}

# --------------------------------------------------------------------------- #
# Burn-rate history: every fresh collection records (time, value) samples, and
# windows / money rows gain a projected time to 100% / exhaustion when a
# positive trend is visible (at least 30 min of history within the last 6 h).
# In-memory only; a restart just pauses projections until samples reaccumulate.
# --------------------------------------------------------------------------- #

_history = {}  # (provider id, row key) -> [[t, value], ...]
_history_lock = threading.Lock()
_HISTORY_WINDOW = 6 * 3600
_HISTORY_MIN_SPAN = 1800
_HISTORY_MAX_AGE = 24 * 3600


def _record(key, value, now):
    with _history_lock:
        samples = _history.setdefault(key, [])
        if samples and value < samples[-1][1] - 0.001:
            samples.clear()  # the window reset: start a fresh cycle
        if not samples or now - samples[-1][0] >= 60:
            samples.append([now, value])
        while samples and now - samples[0][0] > _HISTORY_MAX_AGE:
            del samples[0]
        del samples[:-400]


def _project(key, current, target, now):
    """Seconds until ``target`` at the observed rate, or None when unknown."""
    with _history_lock:
        samples = list(_history.get(key) or ())
    window = [s for s in samples if now - s[0] <= _HISTORY_WINDOW]
    if len(window) < 2:
        return None
    t0, v0 = window[0]
    t1, v1 = window[-1]
    if t1 - t0 < _HISTORY_MIN_SPAN:
        return None
    rate = (v1 - v0) / (t1 - t0)
    if rate <= 0:
        return None
    remaining = target - current
    if remaining <= 0:
        return 0
    eta = remaining / rate
    if eta <= 0 or eta > 60 * 86400:
        return None
    return round(eta)


def _decorate(pid, p, now):
    for w in p.get("windows") or []:
        v = w.get("percent")
        if not isinstance(v, (int, float)):
            continue
        key = (pid, str(w.get("label") or "?"))
        _record(key, float(v), now)
        eta = _project(key, float(v), 100.0, now)
        if eta is not None:
            w["eta_seconds"] = eta
    for m in p.get("money") or []:
        total = m.get("total")
        left = m.get("left")
        if not isinstance(total, (int, float)) or not isinstance(left, (int, float)) or total <= 0:
            continue
        used = float(total) - float(left)
        key = (pid, "money:" + str(m.get("label") or "?"))
        _record(key, used, now)
        eta = _project(key, used, float(total), now)
        if eta is not None:
            m["depletes_in_seconds"] = eta


def _collect():
    results = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(FETCHERS[pid]): pid for pid in FETCH_ORDER}
        for future in as_completed(futures):
            pid = futures[future]
            try:
                results[pid] = future.result()
            except _Skip:
                continue
            except Exception as exc:  # one provider must never blank the others
                results[pid] = {"id": pid, "status": "error", "error": str(exc)[:160]}

    providers = []
    now = time.time()
    for pid in FETCH_ORDER:
        p = results.get(pid)
        if p is None:
            continue
        meta = PROVIDER_META[pid]
        p.setdefault("name", meta["name"])
        p.setdefault("tag", meta["tag"])
        if p.get("status") == "ok":
            _decorate(pid, p, now)
        providers.append(p)
    return {"fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "providers": providers}


def payload(fresh=False):
    """Cached aggregate payload; ``fresh=True`` forces a provider round-trip."""
    with _lock:
        now = time.time()
        if not fresh and _cache["payload"] is not None and now - _cache["at"] < TTL:
            return _cache["payload"]
        result = _collect()
        _cache["at"] = now
        _cache["payload"] = result
        return result


@router.get("/usage")
def get_usage(fresh: bool = False):
    """Aggregate usage payload; per-provider failures are isolated in-band."""
    return payload(fresh=fresh)


@router.get("/health")
def get_health():
    return {"ok": True}
