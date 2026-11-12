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
  back to the OAuth access token in ``~/.codex/auth.json``. The
  ``OPENAI_API_KEY`` entry in that file is never read (an expired token
  surfaces as unavailable; re-auth in the Codex CLI).
- OpenRouter: ``OPENROUTER_API_KEY`` from the Hermes secret scope, with a
  read-only fallback to ``$HERMES_HOME/.env``.
- Anthropic: resolved by Hermes' own read-only account-usage helper, then by
  the ``claude-subscription-directsdk-experimental`` provider when Nous'
  claude-subscription-directsdk plugin is installed (it asks Claude Code for
  its plan limits; the token never reaches this plugin), then by the Claude
  Code OAuth token in ``~/.claude/.credentials.json``. A refused helper read
  keeps the last reading for up to six hours, marked stale.
- Nous: resolved by Hermes' own read-only account-usage helper.
- DeepSeek / Kimi / Z.AI / MiniMax / GitHub Copilot: provider keys from the
  Hermes secret scope (never ``os.environ``), read-only.

Endpoints hit (GET, machine credentials attached):

- https://opencode.ai/zen/go/v1/usage
- https://chatgpt.com/backend-api/wham/usage
- https://openrouter.ai/api/v1/key and https://openrouter.ai/api/v1/credits
- https://api.anthropic.com/api/oauth/usage (via Hermes, then DirectSDK, else the Claude Code token)
- https://portal.nousresearch.com/api/oauth/account (via Hermes' Nous sign-in)
- https://api.deepseek.com/user/balance
- https://api.kimi.com/coding/v1/usages, https://api.moonshot.ai/v1/users/me/balance
  (then api.moonshot.cn)
- https://api.z.ai/api/monitor/usage/quota/limit
- https://api.minimaxi.com and https://www.minimax.cn /v1/token_plan/remains
  (CN), or https://api.minimax.io and https://www.minimax.io (global): M Plan
  subscription keys are region-bound
- https://api.github.com/copilot_internal/user

All provider HTTPS calls use httpx in-process; this plugin spawns no
subprocesses. The DirectSDK provider's own usage hook runs the Claude Code CLI
behind a zero-inference admission gate; that is the provider's code.

Rate limits: a provider that answers 429 with ``retry-after`` is paused until then;
while held, the last reading is served marked ``stale`` and the endpoint is not polled.
"""

from __future__ import annotations

import copy
import contextvars
import json
import logging
import math
import os
import re
import tempfile
import threading
import time
import unicodedata
from concurrent.futures import (
    FIRST_COMPLETED,
    ThreadPoolExecutor,
    TimeoutError as FutureTimeoutError,
    wait,
)
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
HELPER_TIMEOUT_S = 10.0  # one account-usage helper read, wall clock
DEADLINE_S = 30.0  # one collection, wall clock
PROVIDER_BUDGET_S = 12.0  # one provider inside that collection, wall clock
ANTHROPIC_LIMITS_READ_S = 900.0  # extra per-model limits read, at most once per 15 min
ANTHROPIC_LIMITS_CACHE_S = 3600.0  # keep parsed limit rows for one hour without a success
ANTHROPIC_LIMITS_MIN_LEFT_S = 0.5  # do not start the extra read with less budget than this
HOME = Path.home()

# Wall-clock budget for the provider currently running. Workers copy the caller's
# context, so a value set per worker stays inside that worker.
_deadline = contextvars.ContextVar("provider_deadline", default=None)
# The collection a worker belongs to; late workers must not write shared state.
_collection = contextvars.ContextVar("provider_collection", default=None)
# Manual refresh: skip the fresh-snapshot shortcut on the helper path.
_refresh_flag = contextvars.ContextVar("provider_refresh", default=False)


class _Timeout(Exception):
    """The provider ran out of its wall-clock budget."""


def _time_left():
    """Seconds left in this worker's budget, or None when unset."""
    deadline = _deadline.get(None)
    if deadline is None:
        return None
    return deadline - time.monotonic()


class _Run:
    """One collection: its result, its error, and whether it is still open."""

    def __init__(self):
        self.closed = False
        self.done = threading.Event()
        self.payload = None
        self.error = None


def _run_closed():
    """True when the collection this worker belongs to has already returned."""
    run = _collection.get(None)
    return run is not None and run.closed


_HELPER_INFLIGHT = {}  # helper key -> Event set when its last call returned


def _helper_call(fn, timeout=HELPER_TIMEOUT_S, key="helper"):
    """Run a blocking helper call with a real timeout.

    ``future.result(timeout=...)`` only bounds the wait when the executor is not
    left through ``with``: exiting the block joins the worker, which is why the
    old 10s cap waited for the whole call. The worker is abandoned instead, and a
    second call is refused while the first one is still alive.
    """
    event = _HELPER_INFLIGHT.get(key)
    if event is not None and not event.is_set():
        raise _Timeout("timeout")
    event = threading.Event()
    _HELPER_INFLIGHT[key] = event
    pool = ThreadPoolExecutor(max_workers=1)
    future = pool.submit(contextvars.copy_context().run, fn)
    future.add_done_callback(lambda _f, ev=event: ev.set())
    try:
        return future.result(timeout=timeout)
    except FutureTimeoutError:
        raise _Timeout("timeout") from None
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


# Every host this module can reach, tagged with the role of the caller: "plugin"
# for a request made here with a provider credential, "helper" for a Hermes core
# helper that resolves or reads the account server-side. The README provider
# table is the public copy of this list; tests/test_privacy.py keeps them equal.
ALLOWED_HOSTS = {
    "opencode.ai": {"plugin"},
    "chatgpt.com": {"plugin", "helper"},
    "openrouter.ai": {"plugin"},
    "api.anthropic.com": {"plugin", "helper"},
    "api.deepseek.com": {"plugin"},
    "api.kimi.com": {"plugin"},
    "api.moonshot.ai": {"plugin"},
    "api.moonshot.cn": {"plugin"},
    "api.z.ai": {"plugin"},
    "api.minimaxi.com": {"plugin"},
    "api.minimax.io": {"plugin"},
    "www.minimax.cn": {"plugin"},
    "www.minimax.io": {"plugin"},
    "api.github.com": {"plugin"},
    "portal.nousresearch.com": {"helper"},
}

ERROR_MAX_CHARS = 120  # payload error text: one line, no credential, short
WARN_PCT = 80  # row contract: the desktop's amber threshold, copied here
_LOG_DETAIL_MAX = 500  # server-side log detail keeps more context
_TOKEN_SHAPED = re.compile(
    r"(?:sk-[A-Za-z0-9_-]{8,}"
    r"|github_pat_[A-Za-z0-9_]{16,}"
    r"|gh[pousr]_[A-Za-z0-9]{20,}"
    r"|Bearer\s+[A-Za-z0-9._~+/=-]{8,}"
    r"|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}"
    r"|[A-Za-z0-9._~+/=-]{32,})"
)

_lock = threading.Lock()
_cache = {"at": 0.0, "payload": None}
_holds = {}  # provider id -> epoch when a 429 hold expires
_last_good = {}  # provider id -> last ok payload (served while held)
_helper_cooldown = {}  # provider id -> epoch when the account-usage helper may be tried again
_anthropic_limits = {  # extra per-model limits read state
    "at": 0.0,  # last successful read
    "rows": {},  # parsed model rows, keyed by model slug
    "attempt": 0.0,  # last attempt, successful or not
    "hold": 0.0,  # a 429 reset_at for the extra read only
}
_running = {"run": None}  # the collection in flight, if any (guarded by _lock)
_inflight = {}  # provider id -> Event set when its last worker returned
_HOST_WINNERS = {}  # family -> last host that answered, tried first next time


def _prefer(family, urls):
    """Chain order for urls, with the family's last winning host first."""
    urls = tuple(urls)
    winner = _HOST_WINNERS.get(family)
    if winner in urls:
        return (winner,) + tuple(url for url in urls if url != winner)
    return urls


def _won(family, url):
    _HOST_WINNERS[family] = url


def _run_fetcher(pid, provider_deadline):
    """Run one fetcher inside its own budget. Runs in a copied context."""
    _deadline.set(provider_deadline)
    return FETCHERS[pid]()


def _timeout_result(pid):
    """A provider that ran out of time: last reading marked stale, or timeout."""
    last = _last_good.get(pid)
    if last is not None:
        return _as_stale(last)
    return {"id": pid, "status": "error", "error": "timeout"}


class _Skip(Exception):
    """Provider has no usable credentials -> omitted from the payload."""


class _RateLimited(Exception):
    """Provider answered 429: do not call it again before ``reset_at`` (epoch)."""

    def __init__(self, reset_at):
        self.reset_at = float(reset_at)
        super().__init__("rate limited until " + _iso_epoch(self.reset_at))


class _ProviderError(RuntimeError, ValueError):
    """A failure that carries provider text worth showing.

    ``_error_message`` sanitizes ``detail`` before it reaches the payload: one
    line, control characters stripped, capped, and the request's credential plus
    anything token-shaped replaced. Inherits ValueError as well as RuntimeError
    because callers have always caught one or the other.
    """

    def __init__(self, message, secret=None):
        super().__init__(message)
        self.detail = str(message)
        self.secret = secret


def _read_text(path):
    """UTF-8 text from a small config file, tolerating undecodable bytes.

    Without an explicit encoding, read_text uses the platform locale: on a
    GBK/cp936 Windows any non-ASCII byte in these files raised
    UnicodeDecodeError, which turned every .env-keyed provider into an
    error row (the .env handler only caught OSError).
    """
    return path.read_text(encoding="utf-8", errors="replace")


def _env_line_value(line, name):
    """The value for ``name`` on one .env line, or None when it is not that line."""
    text = line.strip()
    if not text or text.startswith("#"):
        return None
    if text.startswith("export") and len(text) > 6 and text[6] in " \t":
        text = text[6:].lstrip()
    if "=" not in text:
        return None
    key, raw = text.split("=", 1)
    if key.strip() != name:
        return None
    value = raw.strip()
    if value[:1] in ('"', "'"):
        quote = value[0]
        close = value.find(quote, 1)
        if close != -1:
            return value[1:close]
    for index, char in enumerate(raw):
        if char == "#" and index > 0 and raw[index - 1] in " \t":
            raw = raw[:index]
            break
    return raw.strip().strip('"').strip("'")


def _hermes_env_value(name):
    """Read-only fallback: the profile's own .env (never os.environ)."""
    try:
        from hermes_constants import get_hermes_home

        env_path = get_hermes_home() / ".env"
    except Exception:
        env_path = Path.home() / ".hermes" / ".env"
    try:
        for line in _read_text(env_path).splitlines():
            value = _env_line_value(line, name)
            if value is not None:
                return value
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


def _iso_from_epoch(epoch):
    """Epoch seconds -> ISO UTC rounded to the minute.

    Computed reset times drift by a few seconds between polls; rounding keeps the
    identity used for alert de-duplication stable across those polls.
    """
    return _iso_epoch(float(epoch) - float(epoch) % 60.0)


def _iso_from_ms(value):
    """A positive millisecond epoch as ISO UTC, or None for anything else."""
    number = _num(value)
    if number is not None and number > 0:
        return _iso_epoch(number / 1000.0)
    return None


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


def _as_utc(dt):
    """A datetime in UTC: a naive value is taken as UTC, an aware one converted."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _num(value):
    """A finite float, or None. Bools, NaN and infinities are not numbers here."""
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _limit_reset(value):
    """A reset from an ISO string or epoch seconds, or None when unusable."""
    if isinstance(value, str):
        text = value.strip()
        if not text or _epoch_from_iso(text) is None:
            return None
        return text
    if isinstance(value, bool):
        return None
    number = _num(value)
    if number is None:
        return None
    try:
        return _iso_epoch(number)
    except (OSError, OverflowError, ValueError):
        return None


_DURATION_TOLERANCE = 0.1
_DURATION_LABELS = (
    (5 * 3600, "5h", "5h"),
    (7 * 86400, "Weekly", "weekly"),
    (30 * 86400, "Monthly", "monthly"),
)


def _duration_match(seconds):
    """The shared label and key for a known window length, or None."""
    for target, label, key in _DURATION_LABELS:
        if abs(seconds - target) <= target * _DURATION_TOLERANCE:
            return label, key
    return None


def _duration_covering(seconds):
    """The smallest shared duration that can still cover ``seconds``, or None.

    A window that resets further out than its label allows cannot really be that
    short. The next standard length that covers the reset is the honest label.
    """
    for target, label, key in _DURATION_LABELS:
        if seconds <= target * (1 + _DURATION_TOLERANCE):
            return target, label, key
    return None


def _seconds_until(when):
    """Seconds from now until a datetime, or None when it is not a datetime."""
    if not isinstance(when, datetime):
        return None
    when = _as_utc(when)
    return (when - datetime.now(timezone.utc)).total_seconds()


def _window(label, percent, resets_at, status="ok", *, duration=None, scope="account", model=None):
    """One window row, or None when the percent isn't a usable number.

    The row always states its scope. A usable ``duration`` is recorded, and a
    known length replaces the caller's label with the shared one, so the direct
    path, the Hermes snapshot path and the panel all name the same window the
    same way. Rows the helper keys here carry that key through history and
    projections; everything else is keyed by the contract pass.
    """
    value = _num(percent)
    if value is None:
        return None
    row = {
        "label": label,
        "percent": round(max(0.0, min(100.0, value)), 1),
        "resets_at": resets_at,
        "status": status,
        "scope": scope,
    }
    seconds = _num(duration)
    match = _duration_match(seconds) if seconds is not None and seconds > 0 else None
    if scope == "model":
        # A model row keeps the caller's label; its own name is the stable part.
        row["key"] = _slug(label if model is None else model)
        if match is not None:
            row["key"] += ":" + match[1]
    if seconds is None or seconds <= 0:
        return row
    length = int(round(seconds))
    row["duration_seconds"] = length
    if scope != "model" and match is not None:
        row["label"] = match[0]
        row["key"] = match[1]
    elif scope != "model":
        row["key"] = "%ds" % length
    return row


def _redact(text, secret=None):
    """Replace the request's credential and anything token-shaped."""
    secrets = secret if isinstance(secret, (tuple, list, set)) else (secret,)
    for value in secrets:
        if value:
            text = text.replace(str(value), "[redacted]")
    return _TOKEN_SHAPED.sub("[redacted]", text)


def _clean_error_text(text, secret=None, cap=ERROR_MAX_CHARS):
    """One line, no invisible characters, no credential, capped.

    Unicode categories Cc (control) and Cf (format) are stripped first, so a
    zero-width or bidi character hidden inside a key cannot break the redaction
    match that follows.
    """
    text = "".join(ch for ch in str(text) if unicodedata.category(ch) not in ("Cc", "Cf"))
    text = " ".join(text.split())
    text = _redact(text, secret)
    if len(text) > cap:
        text = text[:cap].rstrip()
        cut = text.rfind("[")
        if cut != -1 and "[redacted]".startswith(text[cut:]):
            text = text[:cut].rstrip()  # never leave half a marker behind
    return text or "error"


def _error_message(exc):
    """The payload error string: allowlisted provider text, or shape only.

    Anything that is not a curated provider message becomes a shape (``timeout``,
    ``HTTP 500``), so provider-supplied text cannot reach the UI unless it is one
    of the fields this module deliberately reads.
    """
    if isinstance(exc, _ProviderError):
        return _clean_error_text(exc.detail, exc.secret)
    if isinstance(exc, _Timeout):
        return "timeout"
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    if isinstance(exc, httpx.HTTPStatusError):
        return "HTTP %d" % exc.response.status_code
    if isinstance(exc, httpx.RequestError):
        return "connection failed"
    if isinstance(exc, (PermissionError, FileNotFoundError)):
        text = str(exc)
        if text.startswith("HTTP "):
            return _clean_error_text(text)  # the fixed messages from _http_json
        return "permission denied" if isinstance(exc, PermissionError) else "not found"
    return "unexpected error"


def _log_provider_error(pid, exc):
    """Server-side detail for one failed provider, with credentials redacted.

    Only text whose shape is known gets logged: a curated provider message or an
    httpx error. A plain exception's message can carry provider or filesystem
    text, so only its type and the payload shape are recorded.
    """
    if isinstance(exc, _ProviderError):
        detail = _clean_error_text(exc.detail, exc.secret, cap=_LOG_DETAIL_MAX)
    elif isinstance(exc, httpx.HTTPError):
        detail = _clean_error_text(str(exc), None, cap=_LOG_DETAIL_MAX)
    else:
        detail = _error_message(exc)
    logging.getLogger(__name__).warning(
        "provider %s failed (%s): %s", pid, type(exc).__name__, detail
    )


def _decode_json_body(resp):
    """Parse a provider body, refusing non-JSON payloads.

    Some gateways answer HTTP 200 with the literal text "Not Found", and a
    plain resp.json() turns that into a bare JSONDecodeError. Report a clear,
    shape-only error instead.

    The body itself never leaves this function: the message carries only the
    status and the byte count, so a provider that reflects a rejected credential
    in its body cannot reach the UI through this path.
    """
    text = (resp.text or "").lstrip()
    if not text.startswith(("{", "[")):
        raise _ProviderError(
            "non-JSON response (HTTP %d, %d bytes)" % (resp.status_code, len(text))
        )
    return json.loads(text) or {}


def _http_json(url, headers, *, timeout=12.0):
    # A provider's chain shares one wall-clock budget: each request may use only
    # the time left, never a fresh timeout of its own.
    left = _time_left()
    if left is not None:
        if left <= 0.05:
            raise _Timeout("timeout")
        timeout = min(timeout, left)
    with httpx.Client(timeout=timeout) as client:
        resp = client.get(url, headers=headers)
        if resp.status_code in (401, 403):
            # 403 covers both a rejected credential and a missing plan
            # entitlement (e.g. OpenCode Go without a subscription).
            raise PermissionError(
                "HTTP %d: credential rejected or entitlement missing" % resp.status_code
            )
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
    for wid, label, duration in (
        ("rolling", "5h", 5 * 3600),
        ("weekly", "Weekly", 7 * 86400),
        ("monthly", "Monthly", 30 * 86400),
    ):
        w = u.get(wid) or {}
        row = _window(
            label,
            w.get("percent"),
            w.get("resetsAt"),
            w.get("status", "ok"),
            duration=duration,
        )
        if row is not None:
            windows.append(row)
    if not windows:
        raise _Skip("opencode-go")
    return {"id": "opencode-go", "status": "ok", "windows": windows}


def _codex_response_windows(payload, now=None):
    """Window rows from a Codex usage response; [] when it carries no window.

    The published limit_window_seconds names the window, so the snapshot path
    and the direct path read the same truth instead of guessing a length from
    time-to-reset. Position is only the fallback for a response that omits the
    length or sends one we do not recognise.
    """
    rate_limit = (payload or {}).get("rate_limit") or {}
    if not isinstance(rate_limit, dict):
        return []
    now = time.time() if now is None else now
    windows = []
    for w, fallback in (
        (rate_limit.get("primary_window"), "5h"),
        (rate_limit.get("secondary_window"), "Weekly"),
    ):
        if not isinstance(w, dict):
            continue
        ra = _num(w.get("reset_after_seconds"))
        resets_at = _iso_from_epoch(now + ra) if ra is not None else None
        seconds = _num(w.get("limit_window_seconds"))
        match = _duration_match(seconds) if seconds is not None else None
        label = match[0] if match is not None else fallback
        row = _window(label, w.get("used_percent"), resets_at, duration=seconds)
        if row is not None:
            windows.append(row)
    return windows


def _codex_direct():
    """One direct Codex read with the CLI store's OAuth token."""
    tok = None
    try:
        d = json.loads(_read_text(HOME / ".codex/auth.json"))
        # OAuth access token only: the OPENAI_API_KEY entry is a platform key for
        # the OpenAI API, never a credential for the ChatGPT backend.
        tok = (d.get("tokens") or {}).get("access_token")
    except (OSError, ValueError):
        pass
    if not tok:
        raise _Skip("openai-codex")
    d = _http_json(
        "https://chatgpt.com/backend-api/wham/usage",
        {"Authorization": "Bearer " + tok, "Accept": "application/json"},
    )
    windows = _codex_response_windows(d)
    plan = (d.get("plan_type") or "").strip()
    if not windows:
        # Nothing to render: an ok card with no rows would show a fabricated 0%.
        raise _Skip("openai-codex")
    payload = {"id": "openai-codex", "status": "ok", "plan": plan or None, "windows": windows}
    if plan:
        # The plan the token actually belongs to, not the meta default.
        payload["tag"] = plan.title()
    return payload


def fetch_openai_codex():
    return _helper_or_direct("openai-codex", _codex_direct)


def fetch_openrouter():
    key = _secret("OPENROUTER_API_KEY")
    if not key:
        raise _Skip("openrouter")
    hdr = {"Authorization": "Bearer " + key, "Accept": "application/json"}
    k = _http_json("https://openrouter.ai/api/v1/key", hdr).get("data") or {}
    denied = False
    try:
        c = _http_json("https://openrouter.ai/api/v1/credits", hdr).get("data") or {}
    except PermissionError:
        # /credits needs a management key; a normal key gets 403. Keep the key
        # cap from /key and drop only the balance row.
        denied = True
        c = {}
    money = []

    def money_row(label, total, used):
        total = _num(total)
        used = _num(used)
        if total is None or used is None:
            return None
        return {
            "label": label,
            "left": round(total - used, 2),
            "total": round(total, 2),
            "cur": "USD",
        }

    row = money_row("Balance", c.get("total_credits"), c.get("total_usage"))
    if row is not None:
        money.append(row)
    row = money_row("Key cap", k.get("limit"), k.get("usage"))
    if row is not None:
        money.append(row)
    if not money:
        if denied:
            raise _ProviderError("OpenRouter: balance needs a management key", secret=key)
        # No balance and no cap: an ok card with no rows would show a
        # fabricated 0%.
        raise _Skip("openrouter")
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
        fetched = _as_utc(fetched)
        return max(0.0, (datetime.now(timezone.utc) - fetched).total_seconds())
    except (OverflowError, OSError, ValueError):
        return None


# Provider profile registered by Nous' claude-subscription-directsdk plugin.
DIRECTSDK_PROVIDER = "claude-subscription-directsdk-experimental"

_ANTHROPIC_SNAP_WINDOWS = {
    "current session": ("5h", 5 * 3600, "account", None),
    "current week": ("Weekly", 7 * 86400, "account", None),
    "opus week": ("Opus", 7 * 86400, "model", "opus"),
    "sonnet week": ("Sonnet", 7 * 86400, "model", "sonnet"),
    "fable week": ("Fable", 7 * 86400, "model", "fable"),
}
_SNAP_WINDOWS = {
    "anthropic": _ANTHROPIC_SNAP_WINDOWS,
    DIRECTSDK_PROVIDER: _ANTHROPIC_SNAP_WINDOWS,
    "openai-codex": {
        "session": ("5h", 5 * 3600, "account", None),
        "weekly": ("Weekly", 7 * 86400, "account", None),
    },
}


def _snap_window(provider, w):
    """One snapshot window as our row, using the core label map when it is known."""
    label = str(getattr(w, "label", None) or "Window")
    scope = str(getattr(w, "scope", None) or "account")
    duration = None
    model = None
    raw_label = str(getattr(w, "label", None) or "").strip()
    known = _SNAP_WINDOWS.get(provider, {}).get(raw_label.lower())
    if known is not None:
        label, duration, scope, model = known
    else:
        match = re.match(r"^(?P<name>.+?)\s+week$", raw_label, re.IGNORECASE)
        if match is not None and match.group("name").strip():
            label = match.group("name").strip()
            duration = 7 * 86400
            scope = "model"
            model = _slug(label)
    reset_at = _iso_dt(getattr(w, "reset_at", None))
    if known is not None and duration:
        remaining = _seconds_until(getattr(w, "reset_at", None))
        if remaining is not None and remaining > duration * (1 + _DURATION_TOLERANCE):
            # The mapped length cannot hold this reset: the label is wrong for
            # this account. Use the smallest shared length that covers it, or
            # fall back to the core's own label with no duration at all.
            fit = _duration_covering(remaining)
            if fit is not None:
                duration = fit[0]
                if scope != "model":
                    # Account rows take the shared label. A model row keeps its
                    # model name ("Opus"); only its length and key change.
                    label = fit[1]
            else:
                label = str(getattr(w, "label", None) or "Window")
                duration = None
    return _window(
        label,
        getattr(w, "used_percent", None),
        reset_at,
        duration=duration,
        scope=scope,
        model=model,
    )


def _snap_payload(provider, snap):
    """Map a core snapshot onto our payload schema; None without a usable window."""
    if snap is None or not getattr(snap, "available", False):
        return None
    windows = []
    raw = getattr(snap, "raw", None)
    if provider == "openai-codex" and isinstance(raw, dict):
        # The Codex snapshot carries the exact provider body, so its
        # limit_window_seconds is the truth. Parse it with the direct path's
        # helper instead of guessing a length from the reset time.
        fetched = getattr(snap, "fetched_at", None)
        base = fetched.timestamp() if isinstance(fetched, datetime) else None
        windows = _codex_response_windows(raw, now=base)
    if not windows:
        for w in getattr(snap, "windows", None) or ():
            row = _snap_window(provider, w)
            if row is not None:
                windows.append(row)
    if not windows:
        return None
    payload = {"id": provider, "status": "ok", "windows": windows}
    if provider in ("anthropic", DIRECTSDK_PROVIDER) and isinstance(raw, dict):
        raw_limits = raw.get("limits")
        if isinstance(raw_limits, list):
            # A future core snapshot may carry the same limits[] body. Parse it
            # here so the helper path needs no extra request.
            limit_rows = _anthropic_limit_rows(raw_limits)
            existing = {
                str(w.get("model")) for w in windows if w.get("scope") == "model" and w.get("model")
            }
            for slug, row in limit_rows.items():
                if slug not in existing:
                    windows.append(row)
                    existing.add(slug)
            payload["_anthropic_limits_raw"] = True
    plan = getattr(snap, "plan", None)
    if isinstance(plan, str) and plan.strip():
        # The plan the reading belongs to, title-cased like the direct path.
        payload["tag"] = plan.strip().title()
    return payload


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
    # A scheduled poll may answer from a snapshot up to CACHE_FRESH_S old; a
    # manual refresh (refresh flag) goes to the helper instead.
    if age is not None and age <= CACHE_FRESH_S and not _refresh_flag.get(False):
        payload = _snap_payload(provider, cached)
        if payload is not None:
            return payload
    if _helper_cooldown.get(provider, 0.0) <= now:
        payload = _snap_payload(provider, _fetch_usage(provider))
        if payload is not None:
            if not _run_closed():
                _helper_cooldown.pop(provider, None)
            return payload
        if not _run_closed():
            # A worker abandoned by its collection must not leave a cooldown
            # behind for the next collection to inherit.
            _helper_cooldown[provider] = now + HELPER_COOLDOWN_S
        cached = _cached_snapshot(provider)
    return _last_reading(provider, cached)


STALE_DIRECT_AFTER_S = 600.0  # a reading this young needs no direct token attempt
_direct_cooldown = {}  # provider id -> epoch before which no direct attempt is made
_direct_readings = {}  # provider id -> (epoch, payload) of the last direct success


def _payload_age(payload):
    """Seconds since the payload's fetched_at, or None when it has no stamp."""
    text = payload.get("fetched_at") if isinstance(payload, dict) else None
    if not isinstance(text, str):
        return None
    try:
        when = _as_utc(datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ"))
    except ValueError:
        return None
    return max(0.0, (datetime.now(timezone.utc) - when).total_seconds())


def _has_rows(payload):
    """A payload with nothing to render is not a card."""
    return bool(isinstance(payload, dict) and (payload.get("windows") or payload.get("money")))


def _as_stale(payload):
    """A copy of an earlier reading, marked stale."""
    out = copy.deepcopy(payload)
    out["stale"] = True
    return out


def _newest_reading(provider, helper_payload):
    """The newest usable reading, from the helper or an earlier direct read.

    Returns ``(age_seconds, payload)``; the age is None when the helper payload
    carries no stamp. A remembered direct reading past CACHE_STALE_MAX_S is
    dropped instead of returned.
    """
    best = None
    if _has_rows(helper_payload):
        best = (_payload_age(helper_payload), helper_payload)
    hit = _direct_readings.get(provider)
    if hit is not None:
        age = max(0.0, time.time() - hit[0])
        if age > CACHE_STALE_MAX_S:
            _direct_readings.pop(provider, None)
        elif best is None or best[0] is None or age < best[0]:
            best = (age, hit[1])
    return best


def _helper_or_direct(provider, direct, normalize=None, helper=None):
    """Hermes helper first, then one direct token attempt once the reading is old.

    The decision uses the newest reading available: the helper's stale payload or
    the last successful direct read. A newest reading up to STALE_DIRECT_AFTER_S
    old is returned marked stale; past that, one direct attempt is made at most
    once per HELPER_COOLDOWN_S, and a failure returns the newest reading rather
    than an error. With no reading at all the direct token is the ordinary
    fallback. A helper payload with nothing to render is a skip, not a card.

    ``helper`` defaults to the account-usage helper for ``provider``. A provider
    with a second helper source passes its own callable; the cooldowns and the
    snapshot cache remain keyed by the providers that callable asks.
    """

    def finish(payload):
        return normalize(payload) if normalize is not None else payload

    if helper is None:
        helper_payload = _hermes_usage(provider)
    else:
        helper_payload = helper()
    if helper_payload is not None and not helper_payload.get("stale"):
        if not _has_rows(helper_payload):
            raise _Skip(provider)
        return finish(helper_payload)
    now = time.time()
    best = _newest_reading(provider, helper_payload)
    if best is None:
        return direct()
    age, reading = best
    if age is not None and age <= STALE_DIRECT_AFTER_S:
        return finish(_as_stale(reading))
    if _direct_cooldown.get(provider, 0.0) > now:
        return finish(_as_stale(reading))
    if not _run_closed():
        # Reserve the attempt before making it: a failure must not open the door
        # to a retry on the next poll.
        _direct_cooldown[provider] = now + HELPER_COOLDOWN_S
    try:
        result = direct()
    except _RateLimited as exc:
        if not _run_closed():
            _direct_cooldown[provider] = max(_direct_cooldown.get(provider, 0.0), exc.reset_at)
        return finish(_as_stale(reading))
    except _Skip:
        return finish(_as_stale(reading))
    except Exception as exc:
        _log_provider_error(provider, exc)
        return finish(_as_stale(reading))
    if not _run_closed():
        stored = copy.deepcopy(result)
        stored["fetched_at"] = _iso_epoch(time.time())
        _direct_readings[provider] = (time.time(), stored)
    return finish(result)


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


def _anthropic_headers(token):
    """The Claude Code OAuth request headers, shared by both Anthropic reads."""
    return {
        "Authorization": "Bearer " + token,
        "anthropic-beta": "oauth-2025-04-20",
        "Accept": "application/json",
    }


def _anthropic_request(token):
    """One Anthropic usage request with the Claude Code OAuth token."""
    return _http_json(
        "https://api.anthropic.com/api/oauth/usage",
        _anthropic_headers(token),
    )


def _anthropic_helper():
    """Hermes anthropic reading, then the DirectSDK provider.

    A fresh anthropic reading wins without asking DirectSDK. Otherwise a fresh
    DirectSDK reading replaces a stale anthropic one; when neither is fresh, the
    anthropic reading is kept and DirectSDK is used only when it is absent.
    DirectSDK rows keep the Anthropic card id.
    """
    anthropic = _hermes_usage("anthropic")
    if anthropic is not None and not anthropic.get("stale"):
        return anthropic
    direct = _hermes_usage(DIRECTSDK_PROVIDER)
    if direct is not None and not direct.get("stale"):
        return dict(direct, id="anthropic")
    if anthropic is not None:
        return anthropic
    if direct is not None:
        return dict(direct, id="anthropic")
    return None


def fetch_anthropic():
    """Anthropic quota windows: Hermes sign-in, DirectSDK, then the token on disk.

    A helper payload does not carry the per-model limits[] rows. Read them
    separately at a throttled pace, or use the raw body when a helper snapshot
    starts carrying one.
    """
    direct_ok = [False]

    def direct():
        result = _anthropic_direct()
        direct_ok[0] = True
        return result

    payload = _helper_or_direct("anthropic", direct, helper=_anthropic_helper)
    if not isinstance(payload, dict):
        return payload
    if payload.pop("_anthropic_limits_raw", False):
        return payload
    if direct_ok[0]:
        return payload
    _merge_anthropic_limit_rows(payload, _anthropic_limits_cached())
    return payload


def _merge_anthropic_limit_rows(payload, rows):
    """Append limit rows whose model key is not already in the helper payload."""
    if not isinstance(payload, dict) or not rows:
        return
    windows = payload.setdefault("windows", [])
    existing = {str(row.get("key")) for row in windows if isinstance(row, dict) and row.get("key")}
    existing.update(
        str(row.get("model")) + ":weekly"
        for row in windows
        if isinstance(row, dict) and row.get("scope") == "model" and row.get("model")
    )
    for slug, row in rows.items():
        key = slug + ":weekly"
        if key in existing:
            continue
        windows.append(copy.deepcopy(row))
        existing.add(key)


def _anthropic_limits_cached():
    """Parsed per-model limit rows, refreshed at most once per 15 minutes.

    A failed read keeps the last rows for an hour unless a 429 held the extra
    read. No failure reaches the provider card or marks the main payload stale.
    """
    state = _anthropic_limits
    now = time.time()
    if state["at"] and now - state["at"] > ANTHROPIC_LIMITS_CACHE_S:
        state["at"] = 0.0
        state["rows"] = {}
    cached = copy.deepcopy(state["rows"])
    if now < state["hold"]:
        return cached
    if state["attempt"] and now - state["attempt"] < ANTHROPIC_LIMITS_READ_S:
        return cached
    if _run_closed():
        return cached
    left = _time_left()
    if left is not None and left <= ANTHROPIC_LIMITS_MIN_LEFT_S:
        return cached
    token = _claude_code_oauth_token()
    if not token:
        return cached
    state["attempt"] = now
    try:
        d = _anthropic_request(token)
        rows = _anthropic_limit_rows(d.get("limits"))
    except _RateLimited as exc:
        state["hold"] = max(state["hold"], exc.reset_at)
        return cached
    except Exception as exc:  # noqa: BLE001 - a side read never breaks the card
        logging.getLogger(__name__).debug(
            "anthropic limits read failed (%s): %s", type(exc).__name__, _error_message(exc)
        )
        return cached
    state["at"] = now
    state["rows"] = rows
    return copy.deepcopy(rows)


def _anthropic_limit_rows(limits):
    """Per-model weekly rows from Anthropic's plan limits, keyed by model slug."""
    rows = {}
    if not isinstance(limits, list):
        return rows
    for entry in limits:
        if not isinstance(entry, dict):
            continue
        if entry.get("kind") not in ("weekly_scoped", "weekly_model"):
            continue
        scope = entry.get("scope")
        model = scope.get("model") if isinstance(scope, dict) else None
        name = model.get("display_name") if isinstance(model, dict) else None
        if not isinstance(name, str) or not name.strip():
            continue
        percent = _num(entry.get("percent"))
        if percent is None:
            continue
        label = name.strip()
        slug = _slug(label)
        if slug in rows:
            continue
        row = _window(
            label,
            percent,
            _limit_reset(entry.get("resets_at")),
            duration=7 * 86400,
            scope="model",
            model=slug,
        )
        if row is not None:
            rows[slug] = row
    return rows


def _anthropic_direct():
    """One direct Anthropic read with the Claude Code OAuth token."""
    token = _claude_code_oauth_token()
    if not token:
        raise _Skip("anthropic")
    d = _anthropic_request(token)
    limit_rows = _anthropic_limit_rows(d.get("limits"))
    used_limits = set()
    windows = []
    for key, label, duration, scope, model in (
        ("five_hour", "5h", 5 * 3600, "account", None),
        ("seven_day", "Weekly", 7 * 86400, "account", None),
        ("seven_day_opus", "Opus", 7 * 86400, "model", "opus"),
        ("seven_day_sonnet", "Sonnet", 7 * 86400, "model", "sonnet"),
    ):
        w = d.get(key)
        if not isinstance(w, dict):
            continue
        resets = w.get("resets_at")
        row = _window(
            label,
            w.get("utilization"),
            resets if isinstance(resets, str) else None,
            duration=duration,
            scope=scope,
            model=model,
        )
        if row is None:
            continue
        if scope == "model" and model in limit_rows:
            # The plan limits carry the current value; the seven_day_* object
            # is the older shape of the same per-model weekly window.
            windows.append(limit_rows[model])
            used_limits.add(model)
            continue
        windows.append(row)
    for slug, row in limit_rows.items():
        if slug not in used_limits:
            windows.append(row)
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
    if (
        purchased is not None
        and purchased > 0
        and (total is None or abs(purchased - total) > 0.005)
    ):
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
    # Same context copy as _collect(): this nested call must not drop the
    # caller's profile scope either.
    info = _helper_call(
        lambda: get_nous_portal_account_info(force_fresh=True),
        timeout=HELPER_TIMEOUT_S,
        key="nous",
    )
    snap = build_nous_credits_snapshot(info)
    if snap is None or not snap.available:
        raise _Skip("nous")
    windows = []
    for w in snap.windows or ():
        row = _window(
            str(w.label or "Credits"),
            w.used_percent,
            _iso_dt(w.reset_at),
        )
        if row is not None:
            windows.append(row)
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
    for key, label in (
        ("premium_interactions", "Premium requests"),
        ("chat", "Chat"),
        ("completions", "Completions"),
    ):
        entry = snapshots.get(key) or {}
        if not isinstance(entry, dict) or entry.get("unlimited"):
            continue
        entitlement = _num(entry.get("entitlement"))
        if entitlement is not None and entitlement <= 0:
            continue
        remaining = _num(entry.get("percent_remaining"))
        if remaining is None:
            continue
        row = _window(
            label,
            100.0 - remaining,
            reset_at if isinstance(reset_at, str) else None,
        )
        if row is not None:
            windows.append(row)
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
    payload = _http_json(
        "https://api.deepseek.com/user/balance", {"Authorization": "Bearer " + key}
    )
    money = []
    for info in payload.get("balance_infos") or []:
        if not isinstance(info, dict):
            continue
        total = _num(info.get("total_balance"))
        if total is None:
            continue
        money.append(
            {
                "label": "Balance",
                "left": round(total, 2),
                "cur": str(info.get("currency") or "USD")[:8],
            }
        )
    if not money:
        raise _ProviderError("DeepSeek returned no balance rows", secret=key)
    return {"id": "deepseek", "status": "ok", "money": money}


def _kimi_balance(payload):
    """Available balance from a Moonshot balance body.

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


class _NextHost(Exception):
    """The host answered but its body is unusable: try the next host."""

    def __init__(self, error):
        super().__init__(str(error))
        self.error = error


def _probe_hosts(family, urls, headers, accept):
    """The first accepted body and the host that served it, as ``(value, url)``.

    Hosts are tried in ``_prefer`` order. A rate limit or timeout propagates at
    once. Any other request failure is remembered and the next host is tried.
    ``accept`` turns a body into a value, or raises ``_NextHost`` to rule its
    host out; any other exception from ``accept`` propagates. When every host
    fails, the last remembered error is raised.
    """
    last_error = None
    for url in _prefer(family, urls):
        try:
            body = _http_json(url, headers)
        except (_RateLimited, _Timeout):
            raise
        except Exception as exc:
            # 401/403, 404, transport, a non-JSON body: this host is out.
            last_error = exc
            continue
        try:
            value = accept(body)
        except _NextHost as exc:
            last_error = exc.error
            continue
        _won(family, url)
        return value, url
    raise last_error if last_error is not None else RuntimeError("no host answered")


def _fetch_moonshot_balance(headers):
    """The available balance and the host that answered, as ``(amount, url)``."""

    def accept(payload):
        available = _kimi_balance(payload)
        if available is None:
            # The host answered and understood the key; a body without a
            # number is a contract break, not a region mismatch.
            raise _ProviderError(
                "Moonshot balance response carried no available_balance",
                secret=str(headers.get("Authorization") or "").removeprefix("Bearer "),
            )
        return available

    return _probe_hosts("moonshot", _MOONSHOT_BALANCE_URLS, headers, accept)


def _reset_text(*values):
    """The first string reset stamp, else None (a non-string is not a stamp)."""
    for value in values:
        if isinstance(value, str) and value:
            return value
    return None


_KIMI_UNIT_SECONDS = {
    "TIME_UNIT_MINUTE": 60,
    "MINUTE": 60,
    "TIME_UNIT_HOUR": 3600,
    "HOUR": 3600,
    "TIME_UNIT_DAY": 86400,
    "DAY": 86400,
}


def _kimi_duration(entry):
    """A dict window's length in seconds from its own unit and number, or None."""
    window = entry.get("window")
    if not isinstance(window, dict):
        return None
    duration = _num(window.get("duration"))
    factor = _KIMI_UNIT_SECONDS.get(str(window.get("timeUnit") or "").strip().upper())
    if duration is None or factor is None:
        return None
    return duration * factor


def _kimi_label(entry, detail):
    """The detail or entry name; a known duration label wins in ``_window``."""
    window = entry.get("window")
    if not isinstance(window, dict):
        return str(window or entry.get("name") or "Limit")
    return str(detail.get("name") or entry.get("name") or "Limit")


def fetch_kimi():
    # Kimi Coding keys and Moonshot open-platform keys are the same product
    # line; users set whichever their setup provisioned.
    key = _secret("KIMI_API_KEY", "MOONSHOT_API_KEY")
    if not key:
        raise _Skip("kimi-coding")
    headers = {"Authorization": "Bearer " + key, "Accept": "application/json"}

    def used_limit(entry):
        used = _num(entry.get("used"))
        limit = _num(entry.get("limit"))
        if used is None and limit is not None:
            remaining = _num(entry.get("remaining"))
            if remaining is not None:
                used = limit - remaining
        return used, limit

    # Coding-plan quota first; fall back to the Moonshot open-platform balance.
    payload = None
    try:
        payload = _http_json("https://api.kimi.com/coding/v1/usages", headers)
    except (_RateLimited, _Timeout):
        raise
    except Exception:
        payload = None
    if isinstance(payload, dict):
        windows = []
        usage = payload.get("usage")
        if not isinstance(usage, dict):
            usage = {}
        used, limit = used_limit(usage)
        if used is not None and limit:
            row = _window(
                "Weekly",
                used / limit * 100.0,
                _reset_text(usage.get("resetTime"), usage.get("reset_at")),
            )
            if row is not None:
                windows.append(row)
        for entry in payload.get("limits") or []:
            if not isinstance(entry, dict):
                continue
            detail = entry.get("detail")
            if not isinstance(detail, dict):
                detail = {}
            percent = _num(entry.get("percentage"))
            if percent is None:
                used, limit = used_limit(detail)
                if used is None or not limit:
                    continue
                percent = used / limit * 100.0
            row = _window(
                _kimi_label(entry, detail),
                percent,
                _reset_text(
                    entry.get("resetTime"),
                    entry.get("reset_time"),
                    detail.get("resetTime"),
                    detail.get("reset_at"),
                ),
                duration=_kimi_duration(entry),
            )
            if row is not None:
                windows.append(row)
        usages = payload.get("usages")
        if isinstance(usages, dict):
            for name, label, duration, scope, model in (
                ("limit_5h", "5h", 5 * 3600, "account", None),
                ("limit_month_total", "Monthly", 30 * 86400, "account", None),
                ("limit_month_code", "Code", 30 * 86400, "model", "code"),
            ):
                entry = usages.get(name)
                if not isinstance(entry, dict):
                    continue
                percent = _num(entry.get("used_ratio"))
                if percent is None:
                    continue
                if name == "limit_5h" and any(row.get("key") == "5h" for row in windows):
                    continue
                row = _window(
                    label,
                    percent * 100.0,
                    _reset_text(entry.get("reset_time"), entry.get("resetTime")),
                    duration=duration,
                    scope=scope,
                    model=model,
                )
                if row is not None:
                    windows.append(row)
        wallet = payload.get("booster_wallet")
        balance = wallet.get("balance") if isinstance(wallet, dict) else None
        if isinstance(balance, dict):
            amount = _num(balance.get("amount"))
            left = _num(balance.get("amountLeft"))
            if amount is not None and amount > 0 and left is not None:
                used = max(0.0, min(100.0, 100.0 - left / amount * 100.0))
                row = _window("Booster", used, None)
                if row is not None:
                    row["key"] = "booster"
                    row["indicative"] = True
                    windows.append(row)
        if windows:
            return {"id": "kimi-coding", "status": "ok", "windows": windows}
    available, balance_url = _fetch_moonshot_balance(headers)
    host = balance_url.split("/")[2]
    return {
        "id": "kimi-coding",
        "status": "ok",
        "money": [
            {
                "label": "Balance",
                "left": round(available, 2),
                "cur": "USD" if host.endswith("moonshot.ai") else "CNY",
            }
        ],
    }


def fetch_zai():
    key = _secret("ZAI_API_KEY", "GLM_API_KEY")
    if not key:
        raise _Skip("zai")
    payload = _http_json(
        "https://api.z.ai/api/monitor/usage/quota/limit",
        {"Authorization": "Bearer " + key, "Accept": "application/json"},
    )
    if not isinstance(payload, dict):
        raise _ProviderError("Z.AI returned no parseable quota limits", secret=key)
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
            total, current = _num(total), _num(current)
            base = total if total is not None else _num(usage_value)
            if current is not None and base is not None and base:
                percent = current / base * 100.0
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
        resets_at = _iso_from_ms(item.get("nextResetTime"))
        row = _window(label, percent, resets_at)
        if row is not None:
            windows.append(row)
    if not windows:
        message = payload.get("msg") or payload.get("message")
        if isinstance(message, str) and message.strip():
            raise _ProviderError("Z.AI: %s" % message.strip(), secret=key)
        raise _ProviderError("Z.AI returned no parseable quota limits", secret=key)
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
    """MiniMax credentials in probe order, each with its family and hosts.

    A mainland key is useless on the intl hosts and the other way round, so
    every configured credential probes the family matching its region first and
    the other one second. The CN key is tried before the global one, and both
    are probed when both are configured.
    """
    credentials = []
    for name, family, urls in (
        ("MINIMAX_CN_API_KEY", "minimax-cn", MINIMAX_CN_URLS + MINIMAX_GLOBAL_URLS),
        ("MINIMAX_API_KEY", "minimax-global", MINIMAX_GLOBAL_URLS + MINIMAX_CN_URLS),
    ):
        key = _secret(name)
        if key and key not in [known for _family, known, _urls in credentials]:
            credentials.append((family, key, urls))
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
    secrets = tuple(key for _family, key, _urls in credentials)
    payload = None
    last_error = None
    for family, key, urls in credentials:
        headers = {"Authorization": "Bearer " + key, "Accept": "application/json"}

        def accept(candidate, key=key):
            if isinstance(candidate, dict) and candidate.get("model_remains"):
                return candidate
            # A reachable host serving the other region answers 200 with a
            # base_resp error and no rows: remember it, keep probing.
            msg = None
            if isinstance(candidate, dict):
                msg = (candidate.get("base_resp") or {}).get("status_msg")
            raise _NextHost(_ProviderError(str(msg or "no quota rows"), secret=key))

        try:
            payload, _url = _probe_hosts(family, urls, headers, accept)
        except (_RateLimited, _Timeout):
            raise
        except Exception as exc:
            last_error = exc
            continue
        break
    if not isinstance(payload, dict):
        detail = _error_message(last_error) if last_error is not None else "no endpoint"
        raise _ProviderError(
            "MiniMax quota probe failed: %s" % detail,
            secret=secrets,
        )
    windows = []
    for row in payload.get("model_remains") or []:
        if not isinstance(row, dict):
            continue
        model_name = str(row.get("model_name") or "")
        # The M Plan reports a single aggregate row named "general".
        model = "" if model_name in ("", "general") else model_name
        prefix = model[:24] + " · " if model else ""
        for total_key, used_key, pct_key, end_key, duration, label in (
            (
                "current_interval_total_count",
                "current_interval_usage_count",
                "current_interval_remaining_percent",
                "end_time",
                5 * 3600,
                "5h",
            ),
            (
                "current_weekly_total_count",
                "current_weekly_usage_count",
                "current_weekly_remaining_percent",
                "weekly_end_time",
                7 * 86400,
                "Weekly",
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
                total, used = _num(row.get(total_key)), _num(row.get(used_key))
                if total is not None and total > 0 and used is not None:
                    percent = min(max(used, 0), total) / total * 100.0
            resets_at = _iso_from_ms(row.get(end_key))
            window = _window(
                prefix + label,
                percent,
                resets_at,
                duration=duration,
                scope="model" if model else "account",
                model=model or None,
            )
            if window is not None:
                windows.append(window)
    if not windows:
        raise _ProviderError(
            "MiniMax returned no parseable plan rows",
            secret=secrets,
        )
    return {"id": "minimax", "status": "ok", "windows": windows}


# Every provider the panel knows, in display order. The three names below derive
# from it; runtime code reads those names, so a test can replace them.
PROVIDERS = {
    "opencode-go": {
        "name": "OpenCode Go",
        "tag": "Plan",
        "code": "opencode",
        "fetch": fetch_opencode_go,
    },
    "openai-codex": {
        "name": "OpenAI Codex",
        "tag": "Plus",
        "code": "codex",
        "fetch": fetch_openai_codex,
    },
    "openrouter": {
        "name": "OpenRouter",
        "tag": "Credits",
        "code": "openrouter",
        "fetch": fetch_openrouter,
    },
    "anthropic": {
        "name": "Anthropic",
        "tag": "Claude Code",
        "code": "claude",
        "fetch": fetch_anthropic,
    },
    "copilot": {
        "name": "GitHub Copilot",
        "tag": "Quota",
        "code": "copilot",
        "fetch": fetch_copilot,
    },
    "nous": {"name": "Nous", "tag": "Portal", "code": "nous", "fetch": fetch_nous},
    "zai": {"name": "Z.AI", "tag": "GLM", "code": "zai", "fetch": fetch_zai},
    "kimi-coding": {
        "name": "Kimi",
        "tag": "Coding",
        "code": "kimi",
        "fetch": fetch_kimi,
    },
    "minimax": {
        "name": "MiniMax",
        "tag": "Coding",
        "code": "minimax",
        "fetch": fetch_minimax,
    },
    "deepseek": {
        "name": "DeepSeek",
        "tag": "Balance",
        "code": "deepseek",
        "fetch": fetch_deepseek,
    },
}

FETCH_ORDER = tuple(PROVIDERS)
PROVIDER_META = {
    pid: {"name": p["name"], "tag": p["tag"], "code": p["code"]} for pid, p in PROVIDERS.items()
}
FETCHERS = {pid: p["fetch"] for pid, p in PROVIDERS.items()}

# --------------------------------------------------------------------------- #
# Burn-rate history: every fresh collection records (time, value) samples, and
# windows / money rows gain a projected time to 100% / exhaustion when a
# positive trend is visible (at least 30 min of history within the last 6 h).
# In-memory only; a restart just pauses projections until samples reaccumulate.
# --------------------------------------------------------------------------- #

_history = {}  # (provider id, row key) -> [[t, value], ...]
_history_meta = {}  # (provider id, row key) -> {"resets_at": str|None, "duration_seconds": float|None}
_history_lock = threading.Lock()
_HISTORY_WINDOW = 6 * 3600
_HISTORY_MIN_SPAN = 1800
_HISTORY_MAX_AGE = 24 * 3600
_HISTORY_MAX_POINTS = 700
_HISTORY_PANEL_POINTS = 120
_HISTORY_SAVE_S = 60.0
_HISTORY_LOADED = False
_HISTORY_DIRTY = False
_HISTORY_WRITTEN_AT = 0.0


def _history_path():
    """The documented plugin data file, or None outside a Hermes host.

    Hermes gives every plugin a profile-scoped data directory that survives
    plugin updates and removals. Tests replace this function with a temp path.
    """
    try:
        from plugins.plugin_storage import plugin_data_dir

        return plugin_data_dir("provider-usage") / "history.json"
    except Exception:
        pass
    try:
        from hermes_constants import get_hermes_home

        return get_hermes_home() / "plugin-data" / "provider-usage" / "history.json"
    except Exception:
        return None


def _history_start(meta, now):
    """The current window start, or the 24 h fallback when there is no window."""
    reset = _epoch_from_iso((meta or {}).get("resets_at"))
    duration = _num((meta or {}).get("duration_seconds"))
    if reset is not None and duration is not None and duration > 0:
        return reset - duration
    return now - _HISTORY_MAX_AGE


def _history_sample(value):
    """One stored sample as ``[epoch, value]``, or None when it is not one."""
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return None
    stamp, amount = value[0], value[1]
    if isinstance(stamp, bool) or isinstance(amount, bool):
        return None
    try:
        stamp = float(stamp)
        amount = float(amount)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(stamp) or not math.isfinite(amount):
        return None
    return [stamp, amount]


def _ensure_history_loaded():
    """Load the persistent history once; any file problem means empty history."""
    global _HISTORY_LOADED
    with _history_lock:
        if _HISTORY_LOADED:
            return
        _HISTORY_LOADED = True
        path = _history_path()
        if path is None:
            return
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        except (OSError, ValueError):
            logging.getLogger(__name__).debug("history file is unreadable; starting empty")
            return
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            logging.getLogger(__name__).debug("history file is malformed; starting empty")
            return
        if not isinstance(data, dict):
            return
        now = time.time()
        for pid, rows in data.items():
            if not isinstance(pid, str) or not isinstance(rows, dict):
                continue
            for key, entry in rows.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    continue
                samples = [
                    sample
                    for sample in (_history_sample(item) for item in entry.get("samples") or [])
                    if sample is not None
                ]
                reset = entry.get("resets_at")
                reset = reset if isinstance(reset, str) and reset else None
                duration = _num(entry.get("duration_seconds"))
                duration = duration if duration is not None and duration > 0 else None
                meta = {"resets_at": reset, "duration_seconds": duration}
                cutoff = _history_start(meta, now)
                samples = [sample for sample in samples if sample[0] >= cutoff][
                    -_HISTORY_MAX_POINTS:
                ]
                if samples:
                    row_key = (pid, key)
                    _history[row_key] = samples
                    _history_meta[row_key] = meta


def _save_history(now=None, force=False):
    """Atomically persist changed history, at most once per minute."""
    global _HISTORY_DIRTY, _HISTORY_WRITTEN_AT
    now = time.time() if now is None else now
    _ensure_history_loaded()
    with _history_lock:
        if not _HISTORY_DIRTY:
            return False
        if not force and now - _HISTORY_WRITTEN_AT < _HISTORY_SAVE_S:
            return False
        path = _history_path()
        if path is None:
            return False
        data = {}
        for (pid, key), samples in _history.items():
            if not samples:
                continue
            meta = _history_meta.get((pid, key)) or {}
            data.setdefault(pid, {})[key] = {
                "samples": samples,
                "resets_at": meta.get("resets_at"),
                "duration_seconds": meta.get("duration_seconds"),
            }
        temp = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(path.parent, 0o700)
            except OSError:
                pass
            handle, temp = tempfile.mkstemp(prefix=".history.", suffix=".tmp", dir=path.parent)
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(data, stream, separators=(",", ":"), sort_keys=True)
            os.chmod(temp, 0o600)
            os.replace(temp, path)
            _HISTORY_DIRTY = False
            _HISTORY_WRITTEN_AT = now
            return True
        except OSError:
            logging.getLogger(__name__).debug("history file is not writable; keeping memory only")
            if temp is not None:
                try:
                    os.unlink(temp)
                except OSError:
                    pass
            return False


def _record(key, value, now, resets_at=None, duration_seconds=None):
    _ensure_history_loaded()
    with _history_lock:
        samples = _history.setdefault(key, [])
        previous = _history_meta.get(key) or {}
        if not samples:
            previous = {}
        reset = resets_at if isinstance(resets_at, str) and resets_at else None
        duration = _num(duration_seconds)
        duration = duration if duration is not None and duration > 0 else None
        reset_epoch = _epoch_from_iso(reset)
        start = reset_epoch - duration if reset_epoch is not None and duration is not None else None
        previous_reset = _epoch_from_iso(previous.get("resets_at"))
        moved = start is not None and previous_reset is not None and start >= previous_reset - 60
        changed = False
        if samples and (value < samples[-1][1] - 0.001 or moved):
            samples.clear()  # the window reset: start a fresh cycle
            changed = True
        spacing = max(60.0, duration / 600.0) if duration is not None else 60.0
        if not samples or now - samples[-1][0] >= spacing:
            samples.append([now, value])
            changed = True
        cutoff = start if start is not None else now - _HISTORY_MAX_AGE
        kept = [sample for sample in samples if sample[0] >= cutoff][-_HISTORY_MAX_POINTS:]
        if len(kept) != len(samples):
            samples[:] = kept
            changed = True
        meta = {"resets_at": reset, "duration_seconds": duration}
        if meta != previous:
            _history_meta[key] = meta
            changed = True
        if changed:
            global _HISTORY_DIRTY
            _HISTORY_DIRTY = True


def _prune_history(now):
    """Drop keys whose newest sample is outside the current window or 24 h."""
    _ensure_history_loaded()
    global _HISTORY_DIRTY
    with _history_lock:
        for key, samples in list(_history.items()):
            if not samples:
                del _history[key]
                _history_meta.pop(key, None)
                _HISTORY_DIRTY = True
                continue
            cutoff = _history_start(_history_meta.get(key), now)
            kept = [sample for sample in samples if sample[0] >= cutoff]
            if not kept:
                del _history[key]
                _history_meta.pop(key, None)
                _HISTORY_DIRTY = True
            elif len(kept) != len(samples):
                samples[:] = kept
                _HISTORY_DIRTY = True


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


def _history_key(pid, row):
    """The history key for a row: its stable contract key."""
    return (pid, str(row["key"]))


def _long_window(row, now):
    """True when a window is longer than a day, by duration or by reset."""
    duration = _num(row.get("duration_seconds"))
    if duration is not None and duration > 0:
        return duration > 86400
    reset = _epoch_from_iso(row.get("resets_at"))
    return reset is not None and reset - now > 86400


def _decorate(pid, p, now):
    for w in p.get("windows") or []:
        v = _num(w.get("percent"))
        if v is None:
            continue
        key = _history_key(pid, w)
        _record(
            key,
            v,
            now,
            resets_at=w.get("resets_at"),
            duration_seconds=w.get("duration_seconds"),
        )
        if w.get("indicative") is True:
            # Indicative rows are shown for information only. Keep the history
            # sample for the chart, but never project them to a run-out.
            w.pop("eta_seconds", None)
            continue
        if _long_window(w, now):
            # Keep the sample for the chart, but let the panel judge a long
            # window by its average pace instead of a short burst.
            w.pop("eta_seconds", None)
            continue
        eta = _project(key, v, 100.0, now)
        if eta is not None:
            w["eta_seconds"] = eta
    for m in p.get("money") or []:
        total = _num(m.get("total"))
        left = _num(m.get("left"))
        if total is None or left is None or total <= 0:
            continue
        used = total - left
        # The history key is the row's stable contract key, so two balances with
        # the same label cannot share a history.
        key = _history_key(pid, m)
        _record(key, used, now)
        eta = _project(key, used, total, now)
        if eta is not None:
            m["depletes_in_seconds"] = eta


def _slug(text):
    """A stable key fragment: lower-case, runs of anything else become one _."""
    slug = re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")
    return slug or "row"


_ISO_STAMP = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})"
    r"(?:[T ](?P<hour>\d{2}):(?P<minute>\d{2})"
    r"(?::(?P<second>\d{2})(?:\.(?P<fraction>\d+))?)?)?"
    r"(?P<zone>Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$"
)


def _epoch_from_iso(text):
    """Epoch seconds for the ISO-8601 forms we accept, or None. Zone defaults to UTC."""
    if not isinstance(text, str):
        return None
    match = _ISO_STAMP.match(text.strip())
    if match is None:
        return None
    try:
        when = datetime.fromisoformat(text.strip())
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    try:
        return when.timestamp()
    except (OverflowError, OSError, ValueError):
        return None


def _window_actionable(row, now):
    """Seconds to 100% only when it lands before the reset, or within a week."""
    eta = _num(row.get("eta_seconds"))
    if eta is None or eta <= 0:
        return None
    reset = _epoch_from_iso(row.get("resets_at"))
    if reset is not None:
        return int(eta) if eta < reset - now else None
    return int(eta) if eta <= 7 * 86400 else None


def _money_actionable(row):
    """Seconds to exhaustion only when it lands inside fourteen days."""
    value = _num(row.get("depletes_in_seconds"))
    if value is None or value <= 0 or value >= 14 * 86400:
        return None
    return int(value)


def _history_buckets(samples, start, end, limit):
    """At most ``limit`` points, one per even time bucket, newest kept."""
    if len(samples) <= limit:
        return [[int(t), round(v, 2)] for t, v in samples]
    width = max((end - start) / limit, 1.0)
    buckets = {}
    for stamp, value in samples:
        if stamp < start or stamp > end:
            continue
        buckets[int((stamp - start) // width)] = [int(stamp), round(value, 2)]
    return [buckets[index] for index in sorted(buckets)]


def _row_history(pid, row, now):
    """History for the chart: the whole current window, or the last six hours."""
    _ensure_history_loaded()
    key = _history_key(pid, row)
    with _history_lock:
        samples = list(_history.get(key) or ())
    if not samples:
        return None
    duration = _num(row.get("duration_seconds"))
    reset = _epoch_from_iso(row.get("resets_at"))
    if duration is not None and duration > 0 and reset is not None:
        start = reset - duration
        inside = [sample for sample in samples if start <= sample[0] <= now]
        if not inside:
            return None
        return _history_buckets(inside, start, reset, _HISTORY_PANEL_POINTS)
    buckets = {}
    for t, v in samples:
        if now - t <= _HISTORY_WINDOW:
            buckets[int(t // 600)] = [int(t), round(float(v), 2)]
    if not buckets:
        return None
    return [buckets[b] for b in sorted(buckets)[-36:]]


def _unique_key(base, seen):
    """The base key, or the first free ":N" suffix of it."""
    key = base
    index = 2
    while key in seen:
        key = "%s:%d" % (base, index)
        index += 1
    return key


def _assign_keys(p):
    """Give every row its stable key, before history and projections run.

    A key the window helper already set comes from the provider's own data and
    is kept; everything else keeps the label slug this payload has always used.
    Keys are unique within a provider.
    """
    seen = set()
    groups = (("window", p.get("windows") or []), ("money", p.get("money") or []))
    for kind, rows in groups:
        for row in rows:
            key = row.get("key")
            if not key:
                base = _slug(row.get("label") or "")
                if kind == "money":
                    base = "money:" + base
                    if row.get("cur"):
                        base = base + ":" + _slug(row.get("cur"))
                key = _unique_key(base, seen)
            elif key in seen:
                key = _unique_key(str(key), seen)
            seen.add(key)
            row["key"] = key


def _contract_rows(p, now):
    """Add the stable row contract fields to every window and money row."""
    groups = (("window", p.get("windows") or []), ("money", p.get("money") or []))
    for kind, rows in groups:
        for row in rows:
            row["kind"] = kind
            if kind == "window":
                used = _num(row.get("percent"))
                indicative = row.get("indicative") is True
                row["used_pct"] = used
                row["warn"] = False if indicative else used is not None and used >= WARN_PCT
                row["actionable_eta"] = None if indicative else _window_actionable(row, now)
            else:
                total = _num(row.get("total"))
                left = _num(row.get("left"))
                used = None
                if total is not None and left is not None and total > 0:
                    used = round(max(0.0, min(100.0, (total - left) / total * 100.0)), 1)
                row["used_pct"] = used
                row["warn"] = (
                    row.get("label") == "Key cap" and used is not None and used >= WARN_PCT
                )
                row["actionable_eta"] = _money_actionable(row)
            history = _row_history(p.get("id"), row, now)
            if history:
                row["history"] = history


def _collect(deadline=None):
    """Collect every provider inside one wall-clock deadline.

    Workers past the deadline are abandoned: their result is never read, their
    late writes to shared state are refused, and their provider is reported as a
    timeout. Callers must not hold ``_lock`` here.
    """
    results = {}
    now = time.time()
    deadline = time.monotonic() + DEADLINE_S if deadline is None else deadline
    run = _collection.get(None)
    held = {pid: until for pid, until in _holds.items() if pid in FETCH_ORDER and until > now}
    to_fetch = []
    blocked = []
    for pid in FETCH_ORDER:
        if pid in held:
            continue
        event = _inflight.get(pid)
        if event is not None and not event.is_set():
            # The previous worker for this provider never came back. Do not
            # stack a second one on top of it.
            blocked.append(pid)
            continue
        to_fetch.append(pid)

    pool = ThreadPoolExecutor(max_workers=max(1, len(to_fetch)))
    futures = {}
    try:
        # All workers start together, so one cutoff covers every chain: no
        # provider may run past its own budget.
        cutoff = min(deadline, time.monotonic() + PROVIDER_BUDGET_S)
        for pid in to_fetch:
            event = threading.Event()
            _inflight[pid] = event
            # Pool workers do not inherit contextvars; under a multiplexed host
            # the profile secret scope and profile home live in the caller's
            # context, so run every task in a copy of it (the core's
            # tools/daemon_pool.py uses the same pattern).
            future = pool.submit(contextvars.copy_context().run, _run_fetcher, pid, cutoff)
            future.add_done_callback(lambda _f, ev=event: ev.set())
            futures[future] = pid

        pending = set(futures)
        while pending:
            left = cutoff - time.monotonic()
            if left <= 0:
                break
            done, pending = wait(pending, timeout=left, return_when=FIRST_COMPLETED)
            for future in done:
                pid = futures[future]
                try:
                    result = future.result()
                except _Skip:
                    _holds.pop(pid, None)
                    _last_good.pop(pid, None)
                    continue
                except _RateLimited as exc:
                    _holds[pid] = exc.reset_at
                    held[pid] = exc.reset_at
                except _Timeout:
                    results[pid] = _timeout_result(pid)
                except Exception as exc:  # one provider must never blank the others
                    _log_provider_error(pid, exc)
                    results[pid] = {"id": pid, "status": "error", "error": _error_message(exc)}
                else:
                    _holds.pop(pid, None)
                    _last_good[pid] = copy.deepcopy(result)
                    results[pid] = result
        for future in pending:
            future.cancel()
            results[futures[future]] = _timeout_result(futures[future])
    finally:
        if run is not None:
            # Anything still running is now late and must stay inert.
            run.closed = True
        # Leaving the executor waits for its workers; a hung worker must not
        # hold the collection open.
        pool.shutdown(wait=False, cancel_futures=True)

    for pid in blocked:
        results[pid] = _timeout_result(pid)

    for pid, until in held.items():
        last = _last_good.get(pid)
        if last is not None:
            stale = _as_stale(last)
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
        p.setdefault("code", meta["code"])
        _assign_keys(p)
        if p.get("status") == "ok" and not p.get("stale"):
            _decorate(pid, p, now)
        _contract_rows(p, now)
        providers.append(p)
    _prune_history(now)
    _save_history(now)
    return {
        "fetched_at": _iso_epoch(time.time()),
        "providers": providers,
    }


def _collect_and_store(run, refresh):
    """One collection in its own thread; state is stored only when it returns."""
    token = _refresh_flag.set(bool(refresh))
    collection = _collection.set(run)
    try:
        run.payload = _collect()
    except BaseException as exc:  # the waiting caller must see it, not hang
        run.error = exc
    finally:
        _refresh_flag.reset(token)
        _collection.reset(collection)
        run.closed = True
        with _lock:
            if run.payload is not None:
                _cache["at"] = time.time()
                _cache["payload"] = run.payload
            if _running["run"] is run:
                _running["run"] = None
        run.done.set()


def payload(fresh=False, refresh=False):
    """Cached aggregate payload.

    ``fresh`` forces a provider round-trip; ``refresh`` marks a manual refresh,
    which also skips the helper snapshot shortcut. A caller with a warm cache
    never waits for a running collection; with no cache it waits for one.
    """
    with _lock:
        now = time.time()
        cached = _cache["payload"]
        if not fresh and not refresh and cached is not None and now - _cache["at"] < TTL:
            return cached
        run = _running["run"]
        if run is None:
            run = _Run()
            _running["run"] = run
            # The collector runs in a new thread, which inherits no contextvars.
            # Copy the caller's context so a worker still sees the profile scope.
            ctx = contextvars.copy_context()
            threading.Thread(
                target=ctx.run,
                args=(_collect_and_store, run, refresh),
                name="provider-usage-collect",
                daemon=True,
            ).start()
        elif cached is not None:
            return cached
    run.done.wait(DEADLINE_S + 5.0)
    with _lock:
        if run.error is not None:
            raise run.error
        if _cache["payload"] is None:
            raise RuntimeError("collection finished without a payload")
        return _cache["payload"]


@router.get("/usage")
def get_usage(fresh: bool = False, refresh: bool = False):
    """Aggregate usage payload; per-provider failures are isolated in-band.

    ``refresh`` is the manual refresh: it skips the helper snapshot shortcut.
    An older client that only sends ``fresh`` keeps the previous behaviour.
    """
    return payload(fresh=fresh, refresh=refresh)


@router.get("/health")
def get_health():
    return {"ok": True}
