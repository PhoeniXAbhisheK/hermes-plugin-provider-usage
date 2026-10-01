"""Provider Usage: backend half.

FastAPI router mounted at ``/api/plugins/provider-usage/`` by the Hermes
dashboard server. Serves one aggregate JSON payload for the desktop status
bar; provider API calls happen here, on the user's machine.

Providers appear only when their credentials are usable; unconfigured
providers are omitted (never rendered as errors). Credential handling is
read-only throughout: no writes, no token refresh, no browser cookies beyond
an explicitly user-supplied read-only console session (OpenCode Zen balance),
no credential CLIs.

Credential sources (read-only):

- OpenCode Zen: live balance scraped read-only from the login-gated console
  RPC (``GET https://opencode.ai/_server``, cookie-authed via
  ``OPENCODE_CONSOLE_COOKIE``); with no/failed cookie it falls back to the
  local ledger spend (``~/.local/share/opencode/opencode.db``,
  ``session.cost`` sums for provider ``opencode``, calendar month to date).
  Workspace id auto-discovered from ``opencode.db`` (override:
  ``OPENCODE_WORKSPACE_ID``).
- OpenCode Go: ``OPENCODE_GO_API_KEY`` from the Hermes secret scope,
  falling back to the ``opencode-go`` entry of
  ``~/.local/share/opencode/auth.json`` (never the Zen key); a 403
  means no Go subscription and hides the provider.
- OpenAI Codex: Hermes' Codex sign-in via the account-usage helper, falling
  back to ``~/.codex/auth.json`` (expired token surfaces as unavailable;
  re-auth in the Codex CLI).
- OpenRouter: ``OPENROUTER_API_KEY`` from the Hermes secret scope, with a
  read-only fallback to ``$HERMES_HOME/.env``.
- Anthropic: Hermes' read-only account-usage helper (the user's existing
  Hermes sign-in), falling back to the Claude Code OAuth token in
  ``~/.claude/.credentials.json`` when Hermes' helper cannot run (desktop
  plugin host); a missing/malformed credentials file surfaces as an error,
  never an exception that blanks the panel.
- Nous: resolved by Hermes' own read-only account-usage helper.
- DeepSeek / Kimi / Z.AI / MiniMax / GitHub Copilot: provider keys from the
  Hermes secret scope (never ``os.environ``), read-only.

Endpoints hit (GET, machine credentials attached):

- https://opencode.ai/_server (Zen balance, cookie-authed; GET only)
- https://opencode.ai/zen/go/v1/usage (Go only; Zen cost falls back to the local ledger)
- https://chatgpt.com/backend-api/wham/usage
- https://openrouter.ai/api/v1/key and https://openrouter.ai/api/v1/credits
- https://api.anthropic.com/api/oauth/usage (via Hermes, or the Claude Code
  OAuth token when Hermes' helper is unavailable)
- https://api.deepseek.com/user/balance
- https://api.kimi.com/coding/v1/usages, https://api.moonshot.ai/v1/users/me/balance
  (international region first; falls back to api.moonshot.cn)
- https://api.z.ai/api/monitor/usage/quota/limit
- https://api.minimax.io/v1/api/openplatform/coding_plan/remains
- https://api.github.com/copilot_internal/user

All provider HTTPS calls use httpx in-process; no subprocesses are spawned.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter

router = APIRouter()
_log = logging.getLogger(__name__)

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

    The body is NOT echoed into the error. _collect() turns exceptions into
    {"error": str(exc)[:160]} and the panel renders that, so a provider that
    reflects a rejected credential back ("unknown key sk-...") would put a
    live secret in the UI. Report the shape only; the response never leaves
    this function.
    """
    text = (resp.text or "").lstrip()
    if not text.startswith(("{", "[")):
        raise ValueError(
            "non-JSON response (HTTP %d, %d bytes, starts %r)"
            % (resp.status_code, len(text), text[:12])
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


def _ro_uri(db):
    """Read-only SQLite URI for a path (spaces percent-encoded; sqlite URIs
    reject raw spaces and backslashes on Windows)."""
    return "file:" + db.as_posix().replace(" ", "%20") + "?mode=ro"


def _opencode_db_uri():
    db = HOME / ".local/share/opencode/opencode.db"
    if not db.exists():
        return None
    return _ro_uri(db)


def _hermes_home():
    """Hermes home directory (state.db lives here). Indirection so tests can
    relocate it; the installed layout is not under $HOME."""
    try:
        from hermes_constants import get_hermes_home
        return get_hermes_home()
    except Exception:
        return HOME / ".hermes"


def _hermes_state_db_uri():
    """Read-only URI for the Hermes state.db ledger, or None when absent.

    This is the ledger that actually records Zen usage: ``session_model_usage``
    carries per-model tokens plus billing_provider = 'opencode-zen'.  The
    OpenCode CLI ledger (opencode.db) only sees CLI sessions, so reading it
    alone reported $0 for real Hermes Zen traffic.
    """
    for db in (HOME / "state.db", _hermes_home() / "state.db"):
        if db.exists():
            return _ro_uri(db)
    return None


def _month_start_ms():
    """Epoch milliseconds at 00:00 local time on the first of this month."""
    return datetime.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000


OPENCODE_CONSOLE_BASE = "https://opencode.ai"
# queryBillingInfo server-fn content-hash, captured 2026-04-30 from a console
# HAR (same value openusage pins). Rotates on OpenCode backend deploys: when
# the RPC stops returning a balance the card silently falls back to ledger
# spend. Re-capture: log into https://opencode.ai/workspace/<id>/billing,
# DevTools -> Network, copy the ?id= hash of the /_server request whose
# response contains "balance".
OPENCODE_BILLING_FN_ID = (
    "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d"
)
_BALANCE_RE = re.compile(r'"balance"\s*:\s*(\d+)')

# Token columns tracked in the OpenCode CLI ledger (kept in one place so new
# token kinds only need adding here).
_TOKEN_COLS = (
    "tokens_input",
    "tokens_output",
    "tokens_reasoning",
    "tokens_cache_read",
    "tokens_cache_write",
)

# Same idea for Hermes' session_model_usage table. The order must match the
# unpack in _zen_estimated_cost: input, output, reasoning, cache_read, cache_write.
_HERMES_TOKEN_COLS = (
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
)


def _seroval_args(*args):
    """SolidStart server-fn args envelope (seroval tagged unions).

    Strings serialize as {t:1,s:value}, numbers as {t:0,s:value}; matches the
    payload the console browser sends (port of openusage console_rpc.go).
    """
    parts = [
        {"t": 1, "s": a} if isinstance(a, str) else {"t": 0, "s": a}
        for a in args
    ]
    call = {"t": 0, "i": 0, "l": len(parts), "a": parts, "o": 0}
    return json.dumps({"t": call, "f": 0, "m": []}, separators=(",", ":"))


def _zen_balance_from_text(text):
    """USD balance from a console billing body, or None.

    The console carries balance as an integer micro-dollar value (divide by
    1e8). Regex over the raw body on purpose: the envelope is a minified JS
    serialization that changes between deploys, and a miss degrades to the
    spend fallback instead of crashing.
    """
    m = _BALANCE_RE.search(text or "")
    if m is None:
        return None
    try:
        return int(m.group(1)) / 1e8
    except ValueError:
        return None


def _zen_workspace_id():
    """Console workspace id: OPENCODE_WORKSPACE_ID secret, else local CLI db."""
    ws = _secret("OPENCODE_WORKSPACE_ID")
    if ws:
        return ws
    uri = _opencode_db_uri()
    if uri is None:
        return None
    try:
        con = sqlite3.connect(uri, uri=True, timeout=2.0)
        try:
            row = con.execute(
                "select id from workspace order by time_created limit 1"
            ).fetchone()
            return row[0] if row else None
        finally:
            con.close()
    except sqlite3.Error as exc:
        _log.debug("zen ledger %s unreadable: %s", uri, exc)
        return None


def _zen_console_balance():
    """USD balance via the cookie-authed console RPC, or None (never raises).

    Zen has no key-auth balance endpoint (anomalyco/opencode#10447/#10448/
    #44189); the only live number sits behind opencode.ai's login-gated
    SolidStart server functions. The user supplies their console session
    cookie as OPENCODE_CONSOLE_COOKIE; this is a read-only GET to opencode.ai
    and nothing else. Any failure (missing cookie, expired session, rotated
    fn hash, changed envelope) returns None so the caller falls back to the
    local ledger.
    """
    cookie = _secret("OPENCODE_CONSOLE_COOKIE")
    ws = _zen_workspace_id()
    if not cookie or not ws:
        return None
    url = "%s/_server?id=%s&args=%s" % (
        OPENCODE_CONSOLE_BASE,
        OPENCODE_BILLING_FN_ID,
        urllib.parse.quote(_seroval_args(ws), safe=""),
    )
    try:
        with httpx.Client(timeout=12.0, follow_redirects=True) as client:
            resp = client.get(url, headers={"Cookie": "auth=" + cookie})
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    return _zen_balance_from_text(resp.text)


# In-memory cache for Models.dev pricing (refreshed on first use per process).
_models_dev_cache = {"at": 0.0, "catalog": None}
_models_dev_lock = threading.Lock()
_MODELS_DEV_TTL = 900.0  # 15 min


def _fetch_models_dev_catalog():
    """Fetch Models.dev pricing catalog; return dict or None."""
    now = time.time()
    with _models_dev_lock:
        if _models_dev_cache["catalog"] is not None and (now - _models_dev_cache["at"]) < _MODELS_DEV_TTL:
            return _models_dev_cache["catalog"]
    try:
        with httpx.Client(timeout=15.0, follow_redirects=True) as client:
            resp = client.get("https://models.dev/api.json?type=all")
        if resp.status_code != 200:
            return None
        data = resp.json()
        with _models_dev_lock:
            _models_dev_cache["catalog"] = data
            _models_dev_cache["at"] = now
        return data
    except (httpx.HTTPError, OSError, ValueError):
        # Network, transport, or JSON-parse failures fall back to stale cache;
        # anything else (a bug in this file) must surface.
        with _models_dev_lock:
            return _models_dev_cache["catalog"]  # stale fallback


def _model_price(model_id, oc_models):
    """Models.dev cost row for a model, tolerating Zen's ``-free`` /
    ``-contributor-free`` / ``-sol`` suffixes.  End-only stripping keeps a
    model whose name merely contains a suffix (e.g. "x-free-y") intact."""
    price = oc_models.get(model_id, {}).get("cost", {})
    if price:
        return price
    for suffix in ("-free", "-contributor-free", "-sol"):
        alt = model_id.removesuffix(suffix)
        if alt != model_id and alt in oc_models:
            return oc_models[alt].get("cost", {})
    return {}


def _price_tokens(inp, out, rea, cr, cw, price):
    """USD for one model's token row, from per-1M rates."""
    cost = (inp or 0) * price.get("input", 0)
    cost += (out or 0) * price.get("output", 0)
    cost += (rea or 0) * price.get("reasoning", price.get("output", 0))
    cost += (cr or 0) * price.get("cache_read", 0)
    cost += (cw or 0) * price.get("cache_write", 0)
    return cost / 1_000_000.0


def _zen_ledger_rows(since_ms=None):
    """Per-model token rows for Zen spend.

    Two disjoint ledgers, merged: Hermes' own ``session_model_usage`` (every
    turn Hermes makes, the bulk of real traffic) and the opencode CLI's
    ``session`` table (sessions run outside Hermes).  Session ids do not
    overlap, so summing them does not double-count.

    Returns [(model, source, inp, out, reasoning, cache_read, cache_write, seen_ms)].
    """
    rows = []
    uri = _hermes_state_db_uri()
    if uri is not None:
        con = sqlite3.connect(uri, uri=True, timeout=2.0)
        try:
            cols_sql = ", ".join(f"coalesce(sum({c}), 0)" for c in _HERMES_TOKEN_COLS)
            sql = (
                "select model, " + cols_sql + ", last_seen * 1000"
                + " from session_model_usage"
                + " where billing_provider = 'opencode-zen'"
            )
            params = ()
            if since_ms is not None:
                sql += " and last_seen >= ?"
                params = (since_ms / 1000.0,)
            # Retain timestamps for splitting month/all-time from one scan;
            # grouping also keeps an empty window from returning a NULL row.
            sql += " group by model, last_seen"
            rows += [(m, "hermes") + tuple(v) for m, *v in con.execute(sql, params)]
        except sqlite3.Error as exc:
            _log.debug("zen ledger %s unreadable: %s", uri, exc)
            pass
        finally:
            con.close()

    uri = _opencode_db_uri()
    if uri is not None:
        con = sqlite3.connect(uri, uri=True, timeout=2.0)
        try:
            cols_sql = ", ".join(f"coalesce(sum({c}), 0)" for c in _TOKEN_COLS)
            sql = (
                "select json_extract(model, '$.id'), " + cols_sql + ", time_created"
                + " from session"
                + " where json_extract(model, '$.providerID') = 'opencode'"
            )
            params = ()
            if since_ms is not None:
                sql += " and time_created >= ?"
                params = (since_ms,)
            sql += " group by 1, time_created"
            rows += [(m, "opencode-cli") + tuple(v) for m, *v in con.execute(sql, params)]
        except sqlite3.Error as exc:
            _log.debug("zen ledger %s unreadable: %s", uri, exc)
            pass
        finally:
            con.close()
    return rows


def _zen_estimated_cost(ledger):
    """Estimated USD Zen spend from local ledgers * Models.dev pricing.

    Takes rows from both local ledgers (see ``_zen_ledger_rows``) and prices each
    model's token counts with public Models.dev rates.  Hermes' own
    ``estimated_cost_usd`` is not usable: it has no pricing entry for
    ``opencode-zen`` and stores 0 for every such row.

    Returns (cost_usd, details_dict) or (None, None) when no ledger or no
    catalog is reachable.  ``details`` breaks the cost down per model and
    per source.  The caller selects the window from the supplied rows.
    """
    catalog = _fetch_models_dev_catalog()
    if catalog is None:
        return None, None
    oc_models = catalog.get("opencode", {}).get("models", {})
    if not ledger:
        return None, None

    total = 0.0
    details = {}
    for model_id, source, inp, out, rea, cr, cw, seen_ms in ledger:
        model_id = model_id or "unknown"
        price = _model_price(model_id, oc_models)
        cost = _price_tokens(inp, out, rea, cr, cw, price)
        total += cost
        key = "%s [%s]" % (model_id, source)
        detail = details.setdefault(key, {
            "source": source,
            "model": model_id,
            "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0},
            "price": {k: v for k, v in price.items() if isinstance(v, (int, float))},
            "cost_usd": 0.0,
        })
        for token, value in zip(detail["tokens"], (inp, out, rea, cr, cw)):
            detail["tokens"][token] += value or 0
        detail["cost_usd"] += cost
    for detail in details.values():
        detail["cost_usd"] = round(detail["cost_usd"], 4)
    return round(total, 2), details


def fetch_opencode_zen():
    """OpenCode Zen = metered API -> live Balance when possible, else estimated cost.

    A live dollar balance is only available behind the cookie-authed console RPC
    (_zen_console_balance); when it resolves we return the same
    {"label": "Balance", ...} money row the panel renders for Kimi.

    Fallback 1: If the console cookie is missing, estimate spend from the
    local ledgers using Models.dev pricing: tokens * price_per_1M / 1_000_000
    for each model.  This is grounded in real token counts and public
    pricing, not fabricated.  Reads Hermes' own state.db and the opencode
    CLI's opencode.db, which are disjoint (no shared session ids).  Scans
    all history once and selects the current month when it has Zen tokens,
    widening to all history when the month is empty or its estimate is None.

    Fallback 2: If Models.dev is unreachable, fall back to raw token counts.

    Limitation (documented in README "Spend tracking"): without the console
    cookie this is cumulative SPEND, not a remaining balance.  Read-only by
    design; do not change the source.
    """
    balance = _zen_console_balance()
    if balance is not None:
        return {
            "id": "opencode-zen",
            "status": "ok",
            "money": [{"label": "Balance", "left": round(float(balance), 2), "cur": "USD"}],
        }

    # Fallback 1: estimated cost from Models.dev pricing, month then all-time
    ledger = _zen_ledger_rows(None)
    month_start = _month_start_ms()
    month_rows = [row for row in ledger if row[-1] is not None and row[-1] >= month_start]
    def _token_sum(rows):
        return sum(sum(v or 0 for v in row[2:-1]) for row in rows)

    month_tokens = _token_sum(month_rows)
    est, details = _zen_estimated_cost(month_rows)
    window = "month"
    # Free tokens are real usage even when their estimated cost is zero.
    if month_tokens <= 0 or est is None:
        est, details = _zen_estimated_cost(ledger)
        window = "all-time"
    if est is not None:
        return {
            "id": "opencode-zen",
            "status": "ok",
            "money": [{"label": "Balance", "left": est, "cur": "USD"}],
            "meta": {"source": "models.dev estimate (%s)" % window, "models": details},
        }

    # Fallback 2: raw token counts, same month then all-time widening
    if _hermes_state_db_uri() is None and _opencode_db_uri() is None:
        raise _Skip("opencode-zen")
    tokens = month_tokens
    if not tokens:
        tokens = _token_sum(ledger)
    if not tokens:
        raise _Skip("opencode-zen")
    return {
        "id": "opencode-zen",
        "status": "ok",
        "money": [{"label": "Balance", "left": int(tokens), "cur": "tokens"}],
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


CLAUDE_CREDENTIALS_ERROR = "Claude Code credentials not found"


def _claude_code_oauth_token():
    """Claude Code OAuth access token from ~/.claude/.credentials.json.

    The file is written by `claude login`: claudeAiOauth.accessToken is the
    OAuth token the Claude Code client itself sends to api.anthropic.com.
    Returns None when the file is missing, malformed, or carries no token;
    the token is never logged, echoed, or stored.
    """
    try:
        d = json.loads((HOME / ".claude" / ".credentials.json").read_text())
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

    Hermes' account-usage helper returns None inside the desktop plugin
    host, which used to hide the card entirely. Claude Code keeps its own
    OAuth token on disk, so GET /api/oauth/usage (anthropic-beta:
    oauth-2025-04-20) answers with ratio windows even when Hermes' fetcher
    is unavailable. The response is plan-quota ratios, not meters:
    five_hour / seven_day each carry utilization percent and resets_at;
    windows render like the Copilot ratio rows (no cap, no money).
    """
    payload = _hermes_usage("anthropic")
    if payload is not None:
        return payload
    token = _claude_code_oauth_token()
    if not token:
        # Surfaces in-band as an error card ("no exception" is _collect's
        # job); the module omits genuinely unconfigured providers via _Skip.
        raise RuntimeError(CLAUDE_CREDENTIALS_ERROR)
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
            continue  # missing metric: never render a fabricated 0% bar
        resets = w.get("resets_at")
        windows.append({
            "label": label,
            "percent": round(max(0.0, min(100.0, percent)), 1),
            "resets_at": resets if isinstance(resets, str) else None,
            "status": "ok",
        })
    if not windows:
        raise _Skip("anthropic")  # answered, but no ratio window to show
    return {"id": "anthropic", "status": "ok", "windows": windows}


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


def _kimi_balance(payload):
    """Available CNY from a Moonshot balance body.

    Live shape (verified against the international platform): the number is
    nested under data.available_balance; the legacy flat "available" key is
    kept as a fallback. Returns None when the body carries no usable number.
    """
    data = payload.get("data")
    if isinstance(data, dict):
        value = _num(data.get("available_balance"))
        if value is not None:
            return value
    return _num(payload.get("available"))


# Account region decides which host answers: keys are never valid across
# regions (an .ai key gets 401 from api.moonshot.cn and vice versa). Hermes'
# config.yaml points this deployment at the international platform, so probe
# .ai first and fall back to the China endpoint.
_MOONSHOT_BALANCE_URLS = (
    "https://api.moonshot.ai/v1/users/me/balance",
    "https://api.moonshot.cn/v1/users/me/balance",
)


def _fetch_moonshot_balance(headers):
    last_error = None
    for url in _MOONSHOT_BALANCE_URLS:
        try:
            payload = _http_json(url, headers)
        except Exception as exc:
            # 401/403: the key belongs to the other region; 404: the endpoint
            # is not offered there; anything else (transport, non-JSON body)
            # is region-agnostic too. Any failure only rules out THIS host.
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
