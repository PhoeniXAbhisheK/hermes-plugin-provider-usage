"""Provider Usage: backend half.

FastAPI router mounted at ``/api/plugins/provider-usage/`` by the Hermes
dashboard server. Serves one aggregate JSON payload for the desktop status
bar; provider API calls happen here, on the user's machine.

Providers appear only when their credentials are usable; unconfigured
providers are omitted (never rendered as errors). Credential handling is
read-only throughout: no writes, no token refresh, no browser cookies, no
credential CLIs.

Credential sources (read-only):

- OpenCode Go: ``OPENCODE_GO_API_KEY`` from the Hermes secret scope, falling
  back to the ``opencode-go`` entry of ``~/.local/share/opencode/auth.json``
  (the OpenCode CLI's store; never the Zen key). A 403 on the usage endpoint
  means the account has no Go plan: the provider stays hidden.
- OpenAI Codex: Hermes' Codex sign-in via the account-usage helper, falling
  back to ``~/.codex/auth.json`` (expired token surfaces as unavailable;
  re-auth in the Codex CLI).
- OpenRouter: ``OPENROUTER_API_KEY`` from the Hermes secret scope, with a
  read-only fallback to ``$HERMES_HOME/.env``.
- Anthropic: resolved by Hermes' own read-only account-usage helper, falling
  back to the Claude Code OAuth token in ``~/.claude/.credentials.json`` when
  the helper returns nothing (the desktop plugin host). A refused helper read
  keeps the last reading for up to six hours, marked stale.
- Nous: resolved by Hermes' own read-only account-usage helper.
- DeepSeek / Kimi / Z.AI / MiniMax / GitHub Copilot: provider keys from the
  Hermes secret scope (never ``os.environ``), read-only.

Endpoints hit (GET, machine credentials attached):

- https://opencode.ai/zen/go/v1/usage
- https://chatgpt.com/backend-api/wham/usage
- https://openrouter.ai/api/v1/key and https://openrouter.ai/api/v1/credits
- https://api.anthropic.com/api/oauth/usage (via Hermes, else the Claude Code token)
- https://api.deepseek.com/user/balance
- https://api.kimi.com/coding/v1/usages, https://api.moonshot.ai/v1/users/me/balance
  (then api.moonshot.cn)
- https://api.z.ai/api/monitor/usage/quota/limit
- https://api.minimaxi.com/v1/token_plan/remains (CN) or https://api.minimax.io
  /v1/token_plan/remains (global): M Plan subscription keys are region-bound
- https://api.github.com/copilot_internal/user

All provider HTTPS calls use httpx in-process; no subprocesses are spawned.

Rate limits: a provider that answers 429 with ``retry-after`` is paused until then;
while held, the last reading is served marked ``stale`` and the endpoint is not polled.
"""
from __future__ import annotations

import copy
import contextvars
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx
from fastapi import APIRouter

router = APIRouter()

TTL = 300.0
RATE_LIMIT_DEFAULT = 900.0  # seconds held when a 429 carries no Retry-After
RATE_LIMIT_MAX = 21600.0  # clamp: never hold a provider longer than six hours
CACHE_FRESH_S = 240.0  # a core snapshot younger than this answers without a helper call
CACHE_STALE_MAX_S = 21600.0  # serve the last reading at most six hours after it was taken
HELPER_COOLDOWN_S = 300.0  # wait after an empty helper read before trying the helper again
HOME = Path.home()

_lock = threading.Lock()
_cache = {"at": 0.0, "payload": None}
_holds = {}      # provider id -> epoch when a 429 hold expires
_last_good = {}  # provider id -> last ok payload (served while held)
_helper_cooldown = {}  # provider id -> epoch when the account-usage helper may be tried again


class _Skip(Exception):
    """Provider has no usable credentials -> omitted from the payload."""


class _RateLimited(Exception):
    """Provider answered 429: do not call it again before ``reset_at`` (epoch)."""

    def __init__(self, reset_at):
        self.reset_at = float(reset_at)
        super().__init__(
            "rate limited until "
            + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.reset_at))
        )

PROVIDER_META = {
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
    "opencode-go",
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


def _read_text(path):
    """UTF-8 text from a small config file, tolerating undecodable bytes.

    Without an explicit encoding, read_text uses the platform locale: on a
    GBK/cp936 Windows any non-ASCII byte in these files raised
    UnicodeDecodeError, which turned every .env-keyed provider into an
    error row (the .env handler only caught OSError).
    """
    return path.read_text(encoding="utf-8", errors="replace")


def _hermes_env_value(name):
    """Read-only fallback: the profile's own .env (never os.environ)."""
    try:
        from hermes_constants import get_hermes_home
        env_path = get_hermes_home() / ".env"
    except Exception:
        env_path = Path.home() / ".hermes" / ".env"
    try:
        for line in _read_text(env_path).splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except (OSError, ValueError):
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


def _iso_epoch(epoch):
    """Epoch seconds -> the payload's ISO-8601 UTC form."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _retry_after_seconds(value):
    """Seconds to wait from a Retry-After header (delta-seconds or HTTP-date)."""
    text = str(value or "").strip()
    if not text:
        return RATE_LIMIT_DEFAULT
    try:
        return max(60.0, min(RATE_LIMIT_MAX, float(text)))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(text)
        if when is not None:
            if when.tzinfo is None:  # RFC 7231 -0000 means UTC, not local time
                when = when.replace(tzinfo=timezone.utc)
            return max(60.0, min(RATE_LIMIT_MAX, when.timestamp() - time.time()))
    except (TypeError, ValueError, OverflowError):
        pass
    return RATE_LIMIT_DEFAULT


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

    Some gateways answer HTTP 200 with the literal text "Not Found", and a
    plain resp.json() turns that into a bare JSONDecodeError. Report a clear,
    shape-only error instead.

    The response never leaves this function: _collect() turns exceptions into
    {"error": str(exc)[:160]} and the panel renders that, so a provider that
    reflects a rejected credential back in its body must not reach the UI.
    """
    text = (resp.text or "").lstrip()
    if not text.startswith(("{", "[")):
        raise ValueError(
            "non-JSON response (HTTP %d, %d bytes)"
            % (resp.status_code, len(text))
        )
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
        if resp.status_code == 429:
            # Retry-After is seconds or an HTTP-date; hold the provider for that
            # window instead of polling inside it (each poll refreshes the penalty).
            raise _RateLimited(time.time() + _retry_after_seconds(resp.headers.get("retry-after")))
        resp.raise_for_status()
        return _decode_json_body(resp)


def fetch_opencode_go():
    """OpenCode Go (subscription plan) quota windows.

    Key resolution must never fall back to the Zen API key (auth.json entry
    "opencode"): the Go endpoint answers those requests with 403, which used
    to render a hard error card for every Zen-only user. No Go credential,
    or a 403 with one, means "no Go plan on this account": the provider
    stays hidden (module contract: unconfigured providers are omitted).
    """
    key = _secret("OPENCODE_GO_API_KEY")
    if not key:
        try:
            d = json.loads(_read_text(HOME / ".local/share/opencode/auth.json"))
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
        raise _Skip("opencode-go")  # 401/403: no usable Go plan
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
        d = json.loads(_read_text(HOME / ".codex/auth.json"))
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


def _cached_snapshot(provider):
    """Hermes' in-process account-usage snapshot for provider, when there is one.

    ``fetch_account_usage`` remembers every successful read in this process, so
    the panel's own earlier reads show up here. The gateway's per-turn
    ``session.usage`` reads live in another process and are not visible.
    """
    try:
        from agent.account_usage_cache import cached_account_usage
    except ImportError:
        return None
    try:
        return cached_account_usage(provider)
    except Exception:
        return None


def _snapshot_age(snap):
    """Seconds since the snapshot was taken, or None when it carries no usable time."""
    fetched = getattr(snap, "fetched_at", None)
    if not isinstance(fetched, datetime):
        return None
    try:
        if fetched.tzinfo is None:
            fetched = fetched.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - fetched.astimezone(timezone.utc)).total_seconds())
    except (OverflowError, OSError, ValueError):
        return None


def _snap_payload(provider, snap):
    """Map a core snapshot onto our payload schema; None without a usable window."""
    if snap is None or not getattr(snap, "available", False):
        return None
    windows = []
    for w in getattr(snap, "windows", None) or ():
        used = getattr(w, "used_percent", None)
        if not isinstance(used, (int, float)):
            continue
        windows.append({
            "label": str(getattr(w, "label", None) or "Window"),
            "percent": round(float(used), 1),
            "resets_at": _iso_dt(getattr(w, "reset_at", None)),
            "status": "ok",
        })
    if not windows:
        return None
    return {"id": provider, "status": "ok", "windows": windows}


def _last_reading(provider, snap):
    """The cached snapshot as a stale payload, or None past its freshness ceiling."""
    age = _snapshot_age(snap) if snap is not None else None
    if age is None or age > CACHE_STALE_MAX_S:
        return None
    payload = _snap_payload(provider, snap)
    if payload is None:
        return None
    payload["stale"] = True
    payload["fetched_at"] = _iso_dt(getattr(snap, "fetched_at", None))
    return payload


def _fetch_usage(provider):
    """One account-usage read. A helper failure is not a card error."""
    try:
        from agent.account_usage import fetch_account_usage
    except ImportError:
        return None
    try:
        return fetch_account_usage(provider)
    except Exception:
        return None


def _hermes_usage(provider):
    """Map a Hermes AccountUsageSnapshot onto our payload schema.

    The helper returns None on any failure, including a 429 it swallows, so a
    missing snapshot must not read as a card error. Answers in order: a fresh
    in-process snapshot (no call), one live read, then the last reading within
    CACHE_STALE_MAX_S. An empty read puts the helper on a short cooldown so a
    refusing endpoint is not probed on every poll.
    """
    now = time.time()
    cached = _cached_snapshot(provider)
    age = _snapshot_age(cached) if cached is not None else None
    if age is not None and age <= CACHE_FRESH_S:
        payload = _snap_payload(provider, cached)
        if payload is not None:
            return payload
    if _helper_cooldown.get(provider, 0.0) <= now:
        payload = _snap_payload(provider, _fetch_usage(provider))
        if payload is not None:
            _helper_cooldown.pop(provider, None)
            return payload
        _helper_cooldown[provider] = now + HELPER_COOLDOWN_S
        cached = _cached_snapshot(provider)
    return _last_reading(provider, cached)


def _claude_code_oauth_token():
    """Claude Code OAuth access token from ~/.claude/.credentials.json.

    The file is written by ``claude login``: claudeAiOauth.accessToken is the
    token the Claude Code client itself sends to api.anthropic.com. Returns
    None when the file is missing, malformed, or carries no token; the token
    is never logged, echoed, or stored.
    """
    try:
        d = json.loads(_read_text(HOME / ".claude" / ".credentials.json"))
    except (OSError, ValueError):
        return None
    entry = d.get("claudeAiOauth")
    if not isinstance(entry, dict):
        return None
    token = entry.get("accessToken")
    if not isinstance(token, str) or not token:
        return None
    return token


def fetch_anthropic():
    """Anthropic quota windows: Hermes sign-in first, Claude Code fallback.

    Hermes' account-usage helper can return nothing inside the desktop plugin
    host, which used to hide the card entirely. Claude Code keeps its own
    OAuth token on disk, so GET /api/oauth/usage (anthropic-beta:
    oauth-2025-04-20) answers with ratio windows even then. No Hermes data
    and no Claude Code credentials means the provider is unconfigured and
    stays hidden.
    """
    payload = _hermes_usage("anthropic")
    if payload is not None:
        return payload
    token = _claude_code_oauth_token()
    if not token:
        raise _Skip("anthropic")
    d = _http_json(
        "https://api.anthropic.com/api/oauth/usage",
        {
            "Authorization": "Bearer " + token,
            "anthropic-beta": "oauth-2025-04-20",
            "Accept": "application/json",
        },
    )
    windows = []
    for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
        w = d.get(key)
        if not isinstance(w, dict):
            continue
        percent = _num(w.get("utilization"))
        if percent is None:
            continue  # missing metric: skip the row, never a fabricated 0%
        resets = w.get("resets_at")
        windows.append({
            "label": label,
            "percent": round(max(0.0, min(100.0, percent)), 1),
            "resets_at": resets if isinstance(resets, str) else None,
            "status": "ok",
        })
    if not windows:
        raise _Skip("anthropic")
    return {"id": "anthropic", "status": "ok", "windows": windows}


def _nous_credit_rows(info):
    """Money rows for the Nous Portal credit balance (USD), or [] when the
    account exposes no numeric credit fields.

    Mirrors the amounts Hermes' account-usage snapshot reports in its details:
    the total usable credits headline first (what the status-bar chip shows),
    then the top-up / subscription split only when it adds information.
    """
    access = getattr(info, "paid_service_access_info", None)
    if access is None:
        return []
    total = _num(getattr(access, "total_usable_credits", None))
    purchased = _num(getattr(access, "purchased_credits_remaining", None))
    subscription = _num(getattr(access, "subscription_credits_remaining", None))
    rows = []
    if total is not None:
        rows.append({"label": "Balance", "left": round(total, 2), "cur": "USD"})
    if purchased is not None and purchased > 0 and (total is None or abs(purchased - total) > 0.005):
        rows.append({"label": "Top-up credits", "left": round(purchased, 2), "cur": "USD"})
    if subscription is not None and subscription > 0:
        rows.append({"label": "Subscription credits", "left": round(subscription, 2), "cur": "USD"})
    return rows


def fetch_nous():
    try:
        from agent.account_usage import build_nous_credits_snapshot
        from hermes_cli.nous_account import get_nous_portal_account_info
    except ImportError:
        raise _Skip("nous")
    with ThreadPoolExecutor(max_workers=1) as pool:
        # Same context copy as _collect(): this nested pool must not drop the
        # caller's profile scope either.
        info = pool.submit(contextvars.copy_context().run, get_nous_portal_account_info, force_fresh=True).result(timeout=10.0)
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
    if windows:
        return {"id": "nous", "status": "ok", "windows": windows}

    # No subscription percentage window (a free plan, or prepaid top-up
    # credits only) used to hide the whole card. The Portal still exposes an
    # absolute credit balance then, so surface it as money rows instead of
    # dropping the provider.
    money = _nous_credit_rows(info)
    if not money:
        raise _Skip("nous")
    return {"id": "nous", "status": "ok", "money": money}


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


def _kimi_balance(payload):
    """Available CNY from a Moonshot balance body.

    Live shape: the number sits under data.available_balance; the legacy
    flat "available" key is kept as a fallback. Returns None when the body
    carries no usable number.
    """
    data = payload.get("data")
    if isinstance(data, dict):
        value = _num(data.get("available_balance"))
        if value is not None:
            return value
    return _num(payload.get("available"))


# Moonshot accounts are region-scoped: keys are never valid across regions
# (an .ai key gets 401 from api.moonshot.cn and vice versa). Probe the
# international host first, then the China endpoint.
_MOONSHOT_BALANCE_URLS = (
    "https://api.moonshot.ai/v1/users/me/balance",
    "https://api.moonshot.cn/v1/users/me/balance",
)


def _fetch_moonshot_balance(headers):
    last_error = None
    for url in _MOONSHOT_BALANCE_URLS:
        try:
            payload = _http_json(url, headers)
        except _RateLimited:
            raise
        except Exception as exc:
            # 401/403: the key belongs to the other region; 404: the endpoint
            # is not offered there; anything else (transport, non-JSON body)
            # rules this host out too. Any failure only rules out THIS host.
            last_error = exc
            continue
        available = _kimi_balance(payload)
        if available is None:
            # The host answered and understood the key; a body without a
            # number is a contract break, not a region mismatch.
            raise RuntimeError("Moonshot balance response carried no available_balance")
        return available
    raise last_error if last_error is not None else RuntimeError("Moonshot balance unreachable")


def fetch_kimi():
    # Kimi Coding keys and Moonshot open-platform keys are the same product
    # line; users set whichever their setup provisioned.
    key = _secret("KIMI_API_KEY", "MOONSHOT_API_KEY")
    if not key:
        raise _Skip("kimi-coding")
    headers = {"Authorization": "Bearer " + key, "Accept": "application/json"}
    # Coding-plan quota first; fall back to the Moonshot open-platform balance.
    payload = None
    try:
        payload = _http_json("https://api.kimi.com/coding/v1/usages", headers)
    except _RateLimited:
        raise
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
    available = _fetch_moonshot_balance(headers)
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
    if not isinstance(payload, dict):
        raise RuntimeError("Z.AI returned no parseable quota limits")
    # Z.ai wraps the result in a {code, msg, success, data} envelope and the
    # quota limits live under data.limits, so reading them off the top level
    # always found nothing and blanked the card. A bare, unwrapped payload is
    # still accepted in case the envelope is ever dropped.
    data = payload.get("data")
    envelope = data if isinstance(data, dict) else payload
    windows = []
    for item in envelope.get("limits") or []:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("type") or "").upper()
        unit = item.get("unit")
        number = _num(item.get("number"))
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
        elif unit == 3:
            # hour-based credit window: the coding plan's rolling session
            label = "Session (%gh)" % number if number else "Session (5h)"
        elif unit == 6:
            # day-based credit window: the coding plan's weekly cap
            label = "Weekly" if not number or number <= 1 else "Weekly (%gd)" % number
        else:
            label = kind.replace("_", " ").title() or "Limit"
        # Only some windows carry nextResetTime (the daily one usually does not).
        resets_at = None
        reset_ms = item.get("nextResetTime")
        if isinstance(reset_ms, (int, float)) and reset_ms > 0:
            resets_at = _iso_epoch(reset_ms / 1000.0)
        windows.append({
            "label": label,
            "percent": round(max(0.0, min(100.0, float(percent))), 1),
            "resets_at": resets_at,
            "status": "ok",
        })
    if not windows:
        message = payload.get("msg") or payload.get("message")
        if isinstance(message, str) and message.strip():
            raise RuntimeError("Z.AI: %s" % message.strip())
        raise RuntimeError("Z.AI returned no parseable quota limits")
    return {"id": "zai", "status": "ok", "windows": windows}


MINIMAX_CN_URLS = (
    "https://api.minimaxi.com/v1/token_plan/remains",
    "https://www.minimax.cn/v1/token_plan/remains",
)
MINIMAX_GLOBAL_URLS = (
    "https://api.minimax.io/v1/token_plan/remains",
    "https://www.minimax.io/v1/token_plan/remains",
)


def _minimax_credentials():
    """MiniMax credentials in probe order, each paired with its host families.

    A mainland key is useless on the intl hosts and the other way round, so
    every configured credential probes the family matching its region first and
    the other one second. The CN key is tried before the global one, and both
    are probed when both are configured.
    """
    credentials = []
    for name, urls in (
        ("MINIMAX_CN_API_KEY", MINIMAX_CN_URLS + MINIMAX_GLOBAL_URLS),
        ("MINIMAX_API_KEY", MINIMAX_GLOBAL_URLS + MINIMAX_CN_URLS),
    ):
        key = _secret(name)
        if key and key not in [known for known, _urls in credentials]:
            credentials.append((key, urls))
    return credentials


def fetch_minimax():
    """MiniMax plan quota windows, M Plan subscriptions included.

    Subscription keys (the ``sk-cp-`` ones) are region-bound: a mainland key
    only answers on the CN hosts and a global key only on the intl ones, so
    each configured credential probes the family matching its region first and
    the other one second (``MINIMAX_CN_API_KEY`` before ``MINIMAX_API_KEY``).
    The M Plan meter is percentage based: its ``*_total_count`` fields stay 0
    and only ``*_remaining_percent`` carries the reading, so a present percent
    field is authoritative. The count fields are a fallback for payloads
    without one, where they keep their legacy meaning (used over total).
    """
    credentials = _minimax_credentials()
    if not credentials:
        raise _Skip("minimax")
    payload = None
    last_error = None
    for key, urls in credentials:
        headers = {"Authorization": "Bearer " + key, "Accept": "application/json"}
        for url in urls:
            try:
                candidate = _http_json(url, headers)
            except _RateLimited:
                raise
            except Exception as exc:
                last_error = exc
                continue
            if isinstance(candidate, dict) and candidate.get("model_remains"):
                payload = candidate
                break
            # A reachable host serving the other region answers 200 with a
            # base_resp error and no rows: remember it, keep probing.
            msg = None
            if isinstance(candidate, dict):
                msg = (candidate.get("base_resp") or {}).get("status_msg")
            last_error = RuntimeError(str(msg or "no quota rows"))
        if payload is not None:
            break
    if not isinstance(payload, dict):
        raise RuntimeError("MiniMax quota probe failed: %s" % (last_error or "no endpoint"))
    windows = []
    for row in payload.get("model_remains") or []:
        if not isinstance(row, dict):
            continue
        model_name = str(row.get("model_name") or "")
        # The M Plan reports a single aggregate row named "general".
        prefix = "" if model_name in ("", "general") else model_name[:24] + " · "
        for total_key, used_key, pct_key, end_key, label in (
            (
                "current_interval_total_count",
                "current_interval_usage_count",
                "current_interval_remaining_percent",
                "end_time",
                "5h",
            ),
            (
                "current_weekly_total_count",
                "current_weekly_usage_count",
                "current_weekly_remaining_percent",
                "weekly_end_time",
                "weekly",
            ),
        ):
            # The meter is authoritative when present. On token_plan/remains the
            # count fields hold quota left (the legacy coding_plan payloads
            # counted consumed quota), so preferring them would invert the
            # reading of any payload that carries both.
            remaining = _num(row.get(pct_key))
            percent = None
            if remaining is not None:
                percent = 100.0 - remaining
            else:
                total, used = row.get(total_key), row.get(used_key)
                if isinstance(total, (int, float)) and total > 0 and isinstance(used, (int, float)):
                    percent = min(max(used, 0), total) / total * 100.0
            if percent is None:
                continue
            resets_at = None
            end_ms = row.get(end_key)
            if isinstance(end_ms, (int, float)) and end_ms > 0:
                resets_at = _iso_epoch(end_ms / 1000.0)
            windows.append({
                "label": prefix + label,
                "percent": round(max(0.0, min(100.0, float(percent))), 1),
                "resets_at": resets_at,
                "status": "ok",
            })
    if not windows:
        raise RuntimeError("MiniMax returned no parseable plan rows")
    return {"id": "minimax", "status": "ok", "windows": windows}


FETCHERS = {
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
    """Collect every provider. Callers hold ``_lock`` (``payload()`` does)."""
    results = {}
    now = time.time()
    held = {pid: until for pid, until in _holds.items() if pid in FETCH_ORDER and until > now}
    to_fetch = [pid for pid in FETCH_ORDER if pid not in held]
    with ThreadPoolExecutor(max_workers=6) as pool:
        # Pool workers do not inherit contextvars; under a multiplexed host the
        # profile secret scope and profile home live in the caller's context,
        # so run every task in a copy of it (the core's tools/daemon_pool.py
        # uses the same pattern).
        futures = {pool.submit(contextvars.copy_context().run, FETCHERS[pid]): pid for pid in to_fetch}
        for future in as_completed(futures):
            pid = futures[future]
            try:
                results[pid] = future.result()
            except _Skip:
                _holds.pop(pid, None)
                _last_good.pop(pid, None)
                continue
            except _RateLimited as exc:
                _holds[pid] = exc.reset_at
                held[pid] = exc.reset_at
            except Exception as exc:  # one provider must never blank the others
                results[pid] = {"id": pid, "status": "error", "error": str(exc)[:160]}
            else:
                _holds.pop(pid, None)
                _last_good[pid] = copy.deepcopy(results[pid])

    for pid, until in held.items():
        last = _last_good.get(pid)
        if last is not None:
            stale = copy.deepcopy(last)
            stale["stale"] = True
            stale["hold_until"] = _iso_epoch(until)
            results[pid] = stale
        else:
            results[pid] = {
                "id": pid,
                "status": "error",
                "error": "rate limited until %s" % time.strftime("%H:%M", time.localtime(until)),
            }

    providers = []
    for pid in FETCH_ORDER:
        p = results.get(pid)
        if p is None:
            continue
        meta = PROVIDER_META[pid]
        p.setdefault("name", meta["name"])
        p.setdefault("tag", meta["tag"])
        if p.get("status") == "ok" and not p.get("stale"):
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
