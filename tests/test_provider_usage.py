"""Loader + unit tests for dashboard/plugin_api.py (stdlib unittest only)."""
import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def load_api():
    # dash in the folder name makes a normal import impossible; load by path.
    spec = importlib.util.spec_from_file_location(
        "provider_usage_api", ROOT / "dashboard" / "plugin_api.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["provider_usage_api"] = mod
    spec.loader.exec_module(mod)
    return mod

API = load_api()


class HttpJsonGuardTest(unittest.TestCase):
    class FakeResp:
        def __init__(self, status, text):
            self.status_code = status
            self.text = text
        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError("HTTP %d" % self.status_code)

    def test_catchall_not_found_is_clear_error(self):
        # api.opencode.ai answers 200 with the literal text "Not Found".
        fake = HttpJsonGuardTest.FakeResp(200, '"Not Found"')
        with self.assertRaises(ValueError):
            API._decode_json_body(fake)

    def test_html_is_clear_error(self):
        with self.assertRaises(ValueError):
            API._decode_json_body(HttpJsonGuardTest.FakeResp(200, "<html>login</html>"))

    def test_json_object_parses(self):
        self.assertEqual(API._decode_json_body(HttpJsonGuardTest.FakeResp(200, '{"a":1}')), {"a": 1})

    def test_error_never_echoes_response_body(self):
        # _collect() turns exceptions into {"error": str(exc)[:160]} and the
        # panel renders that. A provider that reflects a rejected credential
        # back in a non-JSON body must not put that credential in the UI.
        for body in (
            "Not Found",
            "unauthorized: token sk-live-ABCDEFGHIJKLMNOP invalid",
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
        ):
            with self.assertRaises(ValueError) as cm:
                API._decode_json_body(HttpJsonGuardTest.FakeResp(200, body))
            msg = str(cm.exception)
            for secret in ("sk-live-", "eyJhbGciOi", "Bearer"):
                self.assertNotIn(secret, msg, "error message leaked %r" % secret)
            # the shape is still reported, so the error stays diagnosable
            self.assertIn("non-JSON response", msg)
            self.assertIn("200", msg)

    def test_403_raises_permission_error(self):
        # Go entitlement errors come back 403; fetchers must be able to
        # distinguish them from generic failures. Monkeypatch the client.
        import httpx
        class FakeClient:
            def __init__(self, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, url, headers=None):
                return httpx.Response(403, request=httpx.Request("GET", url))
        orig = httpx.Client
        httpx.Client = FakeClient
        try:
            with self.assertRaises(PermissionError):
                API._http_json("https://x", {})
        finally:
            httpx.Client = orig


class SmokeTest(unittest.TestCase):
    def test_go_fetcher_registered(self):
        self.assertIn("opencode-go", API.FETCHERS)
        self.assertNotIn("opencode-zen", API.FETCHERS)
        self.assertEqual(API.PROVIDER_META["opencode-go"]["name"], "OpenCode Go")


class GoFetcherTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        (self.home / ".local" / "share" / "opencode").mkdir(parents=True)
        self.auth = self.home / ".local" / "share" / "opencode" / "auth.json"
        self._orig_home = API.HOME
        API.HOME = self.home
        API._secret = lambda *names: None  # no Hermes-scoped key in tests
        self._orig_http = API._http_json

    def tearDown(self):
        API.HOME = self._orig_home
        API._http_json = self._orig_http
        self._tmp.cleanup()

    def _write_auth(self, payload):
        self.auth.write_text(json.dumps(payload))

    def test_zen_key_is_never_sent_to_go_endpoint(self):
        # auth.json with ONLY a Zen key (entry id "opencode") must skip,
        # not 403 the Go endpoint with the wrong credential.
        self._write_auth({"opencode": {"type": "api", "key": "zen-key"}})
        with self.assertRaises(API._Skip):
            API.fetch_opencode_go()

    def test_no_key_no_file_skips(self):
        with self.assertRaises(API._Skip):
            API.fetch_opencode_go()

    def test_403_entitlement_hides_silently(self):
        self._write_auth({"opencode-go": {"type": "api", "key": "go-key"}})
        def boom(url, headers, **kw):
            raise PermissionError("HTTP 403: credential rejected or entitlement missing")
        API._http_json = boom
        with self.assertRaises(API._Skip):
            API.fetch_opencode_go()

    def test_windows_without_any_percent_are_skipped(self):
        # missing metric must never render as a 0% bar
        self._write_auth({"opencode-go": {"type": "api", "key": "go-key"}})
        API._http_json = lambda url, headers, **kw: {"usage": {}}
        with self.assertRaises(API._Skip):
            API.fetch_opencode_go()

    def test_ok_windows_payload(self):
        self._write_auth({"opencode-go": {"type": "api", "key": "go-key"}})
        API._http_json = lambda url, headers, **kw: {
            "usage": {"rolling": {"percent": 12.5, "resetsAt": "2026-10-01T12:00:00Z", "status": "ok"}}
        }
        p = API.fetch_opencode_go()
        self.assertEqual(p["id"], "opencode-go")
        self.assertEqual(p["windows"][0]["label"], "5h")
        self.assertEqual(p["windows"][0]["percent"], 12.5)


CODING_URL = "https://api.kimi.com/coding/v1/usages"
AI_URL = "https://api.moonshot.ai/v1/users/me/balance"
CN_URL = "https://api.moonshot.cn/v1/users/me/balance"


class KimiFetcherTest(unittest.TestCase):
    """fetch_kimi() with mocked endpoints (unit tests never hit the network
    and never carry a real credential)."""

    BALANCE_AI = {"code": 0, "scode": "0x0", "status": True,
                  "data": {"available_balance": 18.02331,
                           "voucher_balance": 0, "cash_balance": 18.02331}}

    def setUp(self):
        self._orig_secret = API._secret
        self._orig_http = API._http_json
        self.calls = []
        self.headers_seen = []

    def tearDown(self):
        API._secret = self._orig_secret
        API._http_json = self._orig_http

    def _routes(self, routes):
        def fake(url, headers, **kw):
            self.calls.append(url)
            self.headers_seen.append(dict(headers))
            handler = routes.get(url, "MISS")
            if handler == "MISS":
                raise AssertionError("unexpected url: " + url)
            if isinstance(handler, Exception):
                raise handler
            return handler
        API._http_json = fake

    def _key(self, value="fake-key"):
        API._secret = lambda *names: value

    def test_reads_both_env_var_names(self):
        seen = []
        def fake_secret(*names):
            seen.append(names)
            return None
        API._secret = fake_secret
        with self.assertRaises(API._Skip):
            API.fetch_kimi()
        self.assertIn("KIMI_API_KEY", seen[0])
        self.assertIn("MOONSHOT_API_KEY", seen[0])

    def test_moonshot_env_var_alone_suffices(self):
        # users whose setup only provisioned MOONSHOT_API_KEY must get a card
        API._secret = lambda *names: "moonshot-key" if "MOONSHOT_API_KEY" in names else None
        self._routes({CODING_URL: PermissionError("HTTP 401"), AI_URL: self.BALANCE_AI})
        p = API.fetch_kimi()
        self.assertEqual(p["money"][0]["left"], 18.02)
        self.assertEqual(self.headers_seen[-1]["Authorization"], "Bearer moonshot-key")

    def test_international_region_probed_first(self):
        self._key()
        self._routes({CODING_URL: PermissionError("HTTP 401"), AI_URL: self.BALANCE_AI})
        p = API.fetch_kimi()
        self.assertEqual(self.calls, [CODING_URL, AI_URL])  # .cn never touched when .ai answers
        self.assertEqual(p["id"], "kimi-coding")
        row = p["money"][0]
        self.assertEqual(row["label"], "Balance")
        self.assertEqual(row["left"], 18.02)   # nested data.available_balance, rounded
        self.assertEqual(row["cur"], "CNY")

    def test_falls_back_to_cn_region_when_ai_rejects_key(self):
        self._key()
        cn = {"code": 0, "data": {"available_balance": 42.5}}
        self._routes({CODING_URL: PermissionError("HTTP 401"),
                      AI_URL: PermissionError("HTTP 401: Invalid Authentication"),
                      CN_URL: cn})
        p = API.fetch_kimi()
        self.assertEqual(self.calls, [CODING_URL, AI_URL, CN_URL])
        self.assertEqual(p["money"][0]["left"], 42.5)

    def test_both_regions_failing_surfaces_the_error(self):
        self._key()
        self._routes({CODING_URL: PermissionError("HTTP 401"),
                      AI_URL: PermissionError("HTTP 401"),
                      CN_URL: PermissionError("HTTP 401")})
        with self.assertRaises(PermissionError):
            API.fetch_kimi()

    def test_legacy_flat_available_still_parses(self):
        self._key()
        self._routes({CODING_URL: PermissionError("HTTP 401"),
                      AI_URL: {"available": 5.0}})
        p = API.fetch_kimi()
        self.assertEqual(p["money"][0]["left"], 5.0)

    def test_coding_windows_take_precedence_over_balance(self):
        self._key()
        self._routes({CODING_URL: {"usage": {"used": 1.0, "limit": 4.0, "resetTime": "2026-10-05T00:00:00Z"}}})
        p = API.fetch_kimi()
        self.assertEqual(self.calls, [CODING_URL])
        self.assertEqual(p["windows"][0]["percent"], 25.0)
        self.assertNotIn("money", p)

    def test_balance_body_without_number_raises(self):
        self._key()
        self._routes({CODING_URL: PermissionError("HTTP 401"),
                      AI_URL: {"code": 0, "data": {"voucher_balance": 0}},
                      CN_URL: {"code": 0, "data": {"voucher_balance": 0}}})
        with self.assertRaises(RuntimeError):
            API.fetch_kimi()

    def test_kimi_balance_parser(self):
        self.assertEqual(API._kimi_balance({"data": {"available_balance": "7.25"}}), 7.25)
        self.assertEqual(API._kimi_balance({"available": 3}), 3.0)
        self.assertIsNone(API._kimi_balance({"data": {"available_balance": None}}))
        self.assertIsNone(API._kimi_balance({}))


ANTHROPIC_URL = "https://api.anthropic.com/api/oauth/usage"


class AnthropicFetcherTest(unittest.TestCase):
    """fetch_anthropic() with a mocked credentials file and mocked HTTP:
    Hermes' helper first, Claude Code OAuth fallback. Fixtures carry a
    placeholder token only; never real credential material."""

    LIVE_BODY = {  # shape verified live against the OAuth usage endpoint
        "five_hour": {"utilization": 40.3, "resets_at": "2026-10-02T07:06:00.000000+00:00"},
        "seven_day": {"utilization": 0.0, "resets_at": "2026-10-07T00:59:59.000000+00:00"},
        "seven_day_opus": None,
    }

    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self.creds = self.home / ".claude" / ".credentials.json"
        self._orig_home = API.HOME
        API.HOME = self.home
        self._orig_http = API._http_json
        self._orig_hermes = API._hermes_usage
        self.calls = []
        self.headers_seen = []

    def tearDown(self):
        API.HOME = self._orig_home
        API._http_json = self._orig_http
        API._hermes_usage = self._orig_hermes
        self._tmp.cleanup()

    def _no_hermes(self):
        # the desktop plugin host: Hermes' helper resolves nothing here
        API._hermes_usage = lambda provider: None

    def _write_creds(self, payload):
        self.creds.parent.mkdir(parents=True, exist_ok=True)
        self.creds.write_text(json.dumps(payload) if not isinstance(payload, str) else payload)

    def _mock_http(self, body):
        def fake(url, headers, **kw):
            self.calls.append(url)
            self.headers_seen.append(dict(headers))
            return body
        API._http_json = fake

    def test_hermes_result_takes_precedence(self):
        API._hermes_usage = lambda provider: {"id": provider, "status": "ok", "windows": []}
        p = API.fetch_anthropic()
        self.assertEqual(self.calls, [])  # no fallback HTTP when Hermes answers

    def test_oauth_fallback_ratio_windows(self):
        self._no_hermes()
        self._write_creds({"claudeAiOauth": {"accessToken": "test-token", "subscriptionType": "pro"}})
        self._mock_http(self.LIVE_BODY)
        p = API.fetch_anthropic()
        self.assertEqual(p["id"], "anthropic")
        self.assertEqual(p["status"], "ok")
        self.assertNotIn("money", p)  # ratio windows, never money rows
        self.assertEqual(p["windows"][0]["label"], "5h")
        self.assertEqual(p["windows"][0]["percent"], 40.3)
        self.assertEqual(p["windows"][0]["resets_at"], "2026-10-02T07:06:00.000000+00:00")
        self.assertEqual(p["windows"][1]["label"], "7d")
        self.assertEqual(p["windows"][1]["percent"], 0.0)  # real 0%, not fabricated

    def test_fallback_headers(self):
        self._no_hermes()
        self._write_creds({"claudeAiOauth": {"accessToken": "test-token"}})
        self._mock_http(self.LIVE_BODY)
        API.fetch_anthropic()
        self.assertEqual(self.calls, [ANTHROPIC_URL])
        hdr = self.headers_seen[0]
        self.assertEqual(hdr["Authorization"], "Bearer test-token")
        self.assertEqual(hdr["anthropic-beta"], "oauth-2025-04-20")

    def test_missing_credentials_file_skips(self):
        self._no_hermes()
        with self.assertRaises(API._Skip):
            API.fetch_anthropic()

    def test_malformed_credentials_file_skips(self):
        self._no_hermes()
        self._write_creds("{not json")
        with self.assertRaises(API._Skip):
            API.fetch_anthropic()

    def test_wrong_shape_credentials_skips(self):
        self._no_hermes()
        self._write_creds({"claudeAiOauth": {"accessToken": ""}})  # empty token
        with self.assertRaises(API._Skip):
            API.fetch_anthropic()
        self._write_creds({"mcpOAuth": {}})  # no claudeAiOauth entry
        with self.assertRaises(API._Skip):
            API.fetch_anthropic()

    def test_token_from_other_entries_never_used(self):
        # mcpOAuth entries are unrelated server tokens; only claudeAiOauth counts
        self._no_hermes()
        self._write_creds({"mcpOAuth": {"x|1": {"accessToken": "mcp-token"}}})
        with self.assertRaises(API._Skip):
            API.fetch_anthropic()

    def test_window_without_utilization_is_skipped(self):
        self._no_hermes()
        self._write_creds({"claudeAiOauth": {"accessToken": "test-token"}})
        self._mock_http({"five_hour": {"resets_at": "2026-10-02T07:06:00+00:00"}})
        with self.assertRaises(API._Skip):
            API.fetch_anthropic()

    def test_partial_windows_only_render_present_rows(self):
        self._no_hermes()
        self._write_creds({"claudeAiOauth": {"accessToken": "test-token"}})
        self._mock_http({"five_hour": {"utilization": 120.5, "resets_at": None}})
        p = API.fetch_anthropic()
        self.assertEqual(len(p["windows"]), 1)
        self.assertEqual(p["windows"][0]["percent"], 100.0)  # clamped to a sane bar
        self.assertIsNone(p["windows"][0]["resets_at"])


class EnvEncodingTest(unittest.TestCase):
    """GBK/cp936 Windows: any read without an explicit encoding raised
    UnicodeDecodeError. Regression tests for the UTF-8 read sweep."""

    def _point_home(self, home):
        import types
        hc = types.ModuleType("hermes_constants")
        hc.get_hermes_home = lambda: home
        sys.modules["hermes_constants"] = hc
        self.addCleanup(lambda: sys.modules.pop("hermes_constants", None))

    def test_env_read_specifies_encoding(self):
        # A non-UTF-8 platform locale makes any encoding-less read fail; the
        # .env read must pass its own encoding. Simulated with a strict reader
        # (verbatim the Windows failure: no encoding kwarg -> UnicodeDecodeError).
        import pathlib
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            (home / ".env").write_text(
                "# note \u2014 with an em dash\nDEEPSEEK_API_KEY=test-key\n",
                encoding="utf-8",
            )
            self._point_home(home)
            orig = pathlib.Path.read_text

            def strict_locale_read(self, *args, **kwargs):
                if "encoding" not in kwargs:
                    raise UnicodeDecodeError("gbk", b"\x94", 0, 1, "illegal multibyte sequence")
                return orig(self, *args, **kwargs)

            pathlib.Path.read_text = strict_locale_read
            self.addCleanup(lambda: setattr(pathlib.Path, "read_text", orig))
            self.assertEqual(API._hermes_env_value("DEEPSEEK_API_KEY"), "test-key")

    def test_env_read_tolerates_undecodable_bytes(self):
        import pathlib
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            (home / ".env").write_bytes(b"# \x94 broken comment\nZAI_API_KEY=zz\n")
            self._point_home(home)
            self.assertEqual(API._hermes_env_value("ZAI_API_KEY"), "zz")


class ContextPropagationTest(unittest.TestCase):
    """A multiplexed host binds the profile secret scope and profile home in
    contextvars on the request; bare pool workers drop them, so fetchers
    either fail closed (UnscopedSecretError) or read the launch profile
    (#8, #9). Each pool task must run in a copy of the caller's context."""

    def test_collect_copies_context_into_workers(self):
        import contextvars
        marker = contextvars.ContextVar("provider_usage_test_marker", default="unset")
        seen = {}

        def probe():
            seen["marker"] = marker.get()
            return {"id": "deepseek", "status": "ok"}

        orig_order, orig_fetchers = API.FETCH_ORDER, API.FETCHERS
        API.FETCH_ORDER = ("deepseek",)
        API.FETCHERS = dict(API.FETCHERS, deepseek=probe)
        self.addCleanup(lambda: setattr(API, "FETCH_ORDER", orig_order))
        self.addCleanup(lambda: setattr(API, "FETCHERS", orig_fetchers))
        token = marker.set("visible")
        self.addCleanup(lambda: marker.reset(token))

        out = API._collect()
        self.assertEqual(seen.get("marker"), "visible",
                         "collect worker lost the caller's context")
        self.assertEqual([p["id"] for p in out["providers"]], ["deepseek"])

    def test_nous_pool_copies_context_into_workers(self):
        import contextvars
        import types
        marker = contextvars.ContextVar("provider_usage_test_marker_nous", default="unset")
        seen = {}

        def fake_get_nous_portal_account_info(force_fresh=False):
            seen["marker"] = marker.get()
            return {"ok": True}

        class FakeWindow:
            label = "Credits"
            used_percent = 12.5
            reset_at = None

        class FakeSnapshot:
            available = True
            windows = (FakeWindow(),)

        agent_pkg = types.ModuleType("agent")
        agent_mod = types.ModuleType("agent.account_usage")
        agent_mod.build_nous_credits_snapshot = lambda info: FakeSnapshot()
        agent_pkg.account_usage = agent_mod
        cli_pkg = types.ModuleType("hermes_cli")
        cli_mod = types.ModuleType("hermes_cli.nous_account")
        cli_mod.get_nous_portal_account_info = fake_get_nous_portal_account_info
        cli_pkg.nous_account = cli_mod
        for name, mod in (
            ("agent", agent_pkg),
            ("agent.account_usage", agent_mod),
            ("hermes_cli", cli_pkg),
            ("hermes_cli.nous_account", cli_mod),
        ):
            orig = sys.modules.get(name)
            sys.modules[name] = mod
            if orig is None:
                self.addCleanup(lambda n=name: sys.modules.pop(n, None))
            else:
                self.addCleanup(lambda n=name, m=orig: sys.modules.__setitem__(n, m))

        token = marker.set("visible")
        self.addCleanup(lambda: marker.reset(token))

        p = API.fetch_nous()
        self.assertEqual(seen.get("marker"), "visible",
                         "nous pool worker lost the caller's context")
        self.assertEqual(p["id"], "nous")
        self.assertEqual(p["windows"][0]["percent"], 12.5)

class _FakeAccess:
    """Stands in for hermes_cli.nous_account's paid-service access info."""

    def __init__(self, total=None, purchased=None, subscription=None):
        self.total_usable_credits = total
        self.purchased_credits_remaining = purchased
        self.subscription_credits_remaining = subscription


class _FakeInfo:
    def __init__(self, access):
        self.paid_service_access_info = access


class _FakeSnap:
    def __init__(self, available=True, windows=()):
        self.available = available
        self.windows = windows


class _FakeWindow:
    def __init__(self, label, used, reset=None):
        self.label = label
        self.used_percent = used
        self.reset_at = reset


class NousFetcherTest(unittest.TestCase):
    """fetch_nous() with the Hermes account-usage helpers stubbed out.

    A free / top-up-only Portal account reports credits but no subscription
    percentage window; the card used to vanish entirely. It must now surface
    the balance as money rows, while a real subscription window still wins.
    """

    def _install(self, snap, info=None):
        import types
        agent = types.ModuleType("agent")
        acct = types.ModuleType("agent.account_usage")
        setattr(acct, "build_nous_credits_snapshot", lambda _info=None: snap)
        setattr(agent, "account_usage", acct)
        cli = types.ModuleType("hermes_cli")
        nous = types.ModuleType("hermes_cli.nous_account")
        setattr(nous, "get_nous_portal_account_info", lambda force_fresh=False: info)
        setattr(cli, "nous_account", nous)
        for name, mod in (
            ("agent", agent),
            ("agent.account_usage", acct),
            ("hermes_cli", cli),
            ("hermes_cli.nous_account", nous),
        ):
            sys.modules[name] = mod
        self.addCleanup(
            lambda: [sys.modules.pop(k, None) for k in
                     ("agent", "agent.account_usage", "hermes_cli", "hermes_cli.nous_account")]
        )

    def test_topup_credits_become_money_rows(self):
        self._install(_FakeSnap(windows=()), _FakeInfo(_FakeAccess(total=7.92, purchased=7.92, subscription=0.0)))
        p = API.fetch_nous()
        self.assertEqual(p["status"], "ok")
        self.assertNotIn("windows", p)
        self.assertEqual(p["money"][0], {"label": "Balance", "left": 7.92, "cur": "USD"})
        # purchased == total -> no redundant duplicate row
        self.assertEqual(len(p["money"]), 1)

    def test_subscription_and_topup_split(self):
        self._install(_FakeSnap(windows=()), _FakeInfo(_FakeAccess(total=9.5, purchased=4.5, subscription=5.0)))
        labels = [m["label"] for m in API.fetch_nous()["money"]]
        self.assertEqual(labels, ["Balance", "Top-up credits", "Subscription credits"])

    def test_subscription_window_still_wins(self):
        self._install(_FakeSnap(windows=(_FakeWindow("Weekly", 42.0),)),
                      _FakeInfo(_FakeAccess(total=7.9)))
        p = API.fetch_nous()
        self.assertEqual(p["windows"][0]["percent"], 42.0)
        self.assertNotIn("money", p)

    def test_no_credit_fields_skips(self):
        self._install(_FakeSnap(windows=()), _FakeInfo(_FakeAccess()))
        with self.assertRaises(API._Skip):
            API.fetch_nous()

    def test_unavailable_snapshot_skips(self):
        self._install(_FakeSnap(available=False, windows=()), _FakeInfo(_FakeAccess(total=1.0)))
        with self.assertRaises(API._Skip):
            API.fetch_nous()


class RateLimitTest(unittest.TestCase):
    """429 + retry-after: hold the provider and keep the last reading (#13)."""

    WINDOWS = [{"label": "5h", "percent": 12.0, "resets_at": None, "status": "ok"}]

    def setUp(self):
        self._orig = (API.FETCHERS, API.FETCH_ORDER, API._holds, API._last_good)

    def tearDown(self):
        API.FETCHERS, API.FETCH_ORDER, API._holds, API._last_good = self._orig

    def _client(self, status, extra_headers=None):
        import httpx
        captured = dict(extra_headers or {})

        class FakeClient:
            def __init__(self, **kw):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def get(self, url, headers=None):
                return httpx.Response(status, request=httpx.Request("GET", url), headers=captured)

        return FakeClient

    def _limited_wait(self, headers):
        import httpx
        orig = httpx.Client
        httpx.Client = self._client(429, headers)
        try:
            before = API.time.time()
            with self.assertRaises(API._RateLimited) as cm:
                API._http_json("https://example.invalid/usage", {})
        finally:
            httpx.Client = orig
        return cm.exception.reset_at - before

    def test_retry_after_seconds(self):
        wait = self._limited_wait({"retry-after": "2700"})
        self.assertGreater(wait, 2600)
        self.assertLess(wait, 2800)

    def test_retry_after_absent_uses_default(self):
        wait = self._limited_wait({})
        self.assertGreaterEqual(wait, API.RATE_LIMIT_DEFAULT - 5)
        self.assertLessEqual(wait, API.RATE_LIMIT_DEFAULT + 5)

    def test_retry_after_http_date(self):
        from datetime import datetime, timedelta, timezone
        from email.utils import format_datetime

        header = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=1800), usegmt=True)
        wait = self._limited_wait({"retry-after": header})
        self.assertGreater(wait, 1700)
        self.assertLess(wait, 1900)

    def test_hold_skips_fetcher_and_serves_last_reading(self):
        calls = []

        def boom():
            calls.append(1)
            raise AssertionError("fetcher ran while held")

        API.FETCH_ORDER = ("anthropic",)
        API.FETCHERS = dict(API.FETCHERS, anthropic=boom)
        API._holds = {"anthropic": API.time.time() + 600}
        API._last_good = {"anthropic": {"id": "anthropic", "status": "ok", "windows": [dict(self.WINDOWS[0])]}}
        p = API._collect()["providers"][0]
        self.assertEqual(calls, [])
        self.assertTrue(p.get("stale"))
        self.assertTrue(p.get("hold_until"))
        self.assertEqual(p["windows"][0]["percent"], 12.0)
        self.assertEqual(p["name"], "Anthropic")

    def test_hold_without_last_reading_reports_rate_limit(self):
        def boom():
            raise AssertionError("fetcher ran while held")

        API.FETCH_ORDER = ("anthropic",)
        API.FETCHERS = dict(API.FETCHERS, anthropic=boom)
        API._holds = {"anthropic": API.time.time() + 600}
        API._last_good = {}
        p = API._collect()["providers"][0]
        self.assertEqual(p["status"], "error")
        self.assertIn("rate limited until", p["error"])

    def test_fetcher_rate_limit_sets_hold_and_keeps_last_reading(self):
        def limited():
            raise API._RateLimited(API.time.time() + 900)

        API.FETCH_ORDER = ("anthropic",)
        API.FETCHERS = dict(API.FETCHERS, anthropic=limited)
        API._holds = {}
        API._last_good = {"anthropic": {"id": "anthropic", "status": "ok", "windows": [dict(self.WINDOWS[0])]}}
        p = API._collect()["providers"][0]
        self.assertTrue(p.get("stale"))
        self.assertGreater(API._holds.get("anthropic", 0), API.time.time() + 800)

    def test_expired_hold_refetches_and_clears(self):
        calls = []

        def good():
            calls.append(1)
            return {"id": "anthropic", "status": "ok", "windows": [dict(self.WINDOWS[0])]}

        API.FETCH_ORDER = ("anthropic",)
        API.FETCHERS = dict(API.FETCHERS, anthropic=good)
        API._holds = {"anthropic": API.time.time() - 10}
        API._last_good = {}
        p = API._collect()["providers"][0]
        self.assertEqual(len(calls), 1)
        self.assertNotIn("anthropic", API._holds)
        self.assertFalse(p.get("stale"))

    def test_hold_is_per_provider(self):
        def boom():
            raise AssertionError("fetcher ran while held")

        def good():
            return {"id": "deepseek", "status": "ok"}

        API.FETCH_ORDER = ("anthropic", "deepseek")
        API.FETCHERS = dict(API.FETCHERS, anthropic=boom, deepseek=good)
        API._holds = {"anthropic": API.time.time() + 600}
        API._last_good = {}
        out = API._collect()
        got = {p["id"]: p for p in out["providers"]}
        self.assertEqual(got["deepseek"]["status"], "ok")
        self.assertFalse(got["deepseek"].get("stale"))
        self.assertEqual(got["anthropic"]["status"], "error")

    def test_stale_reading_does_not_feed_projections(self):
        recs = []
        orig = API._record
        API._record = lambda *a, **k: recs.append(a)
        try:
            def boom():
                raise AssertionError("fetcher ran while held")

            API.FETCH_ORDER = ("anthropic",)
            API.FETCHERS = dict(API.FETCHERS, anthropic=boom)
            API._holds = {"anthropic": API.time.time() + 600}
            API._last_good = {"anthropic": {"id": "anthropic", "status": "ok", "windows": [dict(self.WINDOWS[0])]}}
            API._collect()
        finally:
            API._record = orig
        self.assertEqual(recs, [])



    def test_retry_after_malformed_falls_back(self):
        wait = self._limited_wait({"retry-after": "soon"})
        self.assertGreaterEqual(wait, API.RATE_LIMIT_DEFAULT - 5)
        self.assertLessEqual(wait, API.RATE_LIMIT_DEFAULT + 5)

    def test_retry_after_clamped_to_max(self):
        wait = self._limited_wait({"retry-after": "999999"})
        self.assertGreater(wait, API.RATE_LIMIT_MAX - 5)

    def test_retry_after_past_date_floors_at_one_minute(self):
        from datetime import datetime, timedelta, timezone
        from email.utils import format_datetime

        header = format_datetime(datetime.now(timezone.utc) - timedelta(hours=1), usegmt=True)
        wait = self._limited_wait({"retry-after": header})
        self.assertGreaterEqual(wait, 55)
        self.assertLess(wait, 70)

    def test_success_fills_last_good_and_serves_an_isolated_copy(self):
        def good():
            return {"id": "anthropic", "status": "ok", "windows": [dict(self.WINDOWS[0])]}

        API.FETCH_ORDER = ("anthropic",)
        API.FETCHERS = dict(API.FETCHERS, anthropic=good)
        API._holds = {}
        API._last_good = {}
        out = API._collect()
        self.assertIn("anthropic", API._last_good)
        out["providers"][0]["windows"][0]["percent"] = 99.0
        self.assertEqual(API._last_good["anthropic"]["windows"][0]["percent"], 12.0)

    def test_skip_clears_hold_and_last_good(self):
        def skipped():
            raise API._Skip("anthropic")

        API.FETCH_ORDER = ("anthropic",)
        API.FETCHERS = dict(API.FETCHERS, anthropic=skipped)
        API._holds = {"anthropic": API.time.time() - 10}
        API._last_good = {"anthropic": {"id": "anthropic", "status": "ok", "windows": [dict(self.WINDOWS[0])]}}
        out = API._collect()
        self.assertEqual(out["providers"], [])
        self.assertNotIn("anthropic", API._holds)
        self.assertNotIn("anthropic", API._last_good)

    def test_non_stale_reading_feeds_projections(self):
        recs = []
        orig = API._record
        API._record = lambda *a, **k: recs.append(a)
        try:
            def good():
                return {"id": "anthropic", "status": "ok", "windows": [dict(self.WINDOWS[0])]}

            API.FETCH_ORDER = ("anthropic",)
            API.FETCHERS = dict(API.FETCHERS, anthropic=good)
            API._holds = {}
            API._last_good = {}
            API._collect()
        finally:
            API._record = orig
        self.assertNotEqual(recs, [])

    def test_rate_limit_survives_kimi_fallbacks(self):
        def boom(*a, **k):
            raise API._RateLimited(API.time.time() + 600)

        orig_secret, orig_http = API._secret, API._http_json
        API._secret = lambda *names: "test-key"
        API._http_json = boom
        try:
            with self.assertRaises(API._RateLimited):
                API.fetch_kimi()
        finally:
            API._secret, API._http_json = orig_secret, orig_http

    def test_rate_limit_survives_minimax_fallback(self):
        def boom(*a, **k):
            raise API._RateLimited(API.time.time() + 600)

        orig_secret, orig_http = API._secret, API._http_json
        API._secret = lambda *names: "test-key"
        API._http_json = boom
        try:
            with self.assertRaises(API._RateLimited):
                API.fetch_minimax()
        finally:
            API._secret, API._http_json = orig_secret, orig_http


class ZaiFetcherTest(unittest.TestCase):
    """fetch_zai() with mocked endpoints (never hits the network)."""

    # Real shape: the limits sit inside a {code, msg, data, success} envelope.
    # The coding plan reports a rolling 5h credit window (unit 3) and a weekly
    # cap (unit 6); only the weekly one carries nextResetTime.
    ENVELOPE = {
        "code": 200, "msg": "ok", "success": True,
        "data": {"level": "standard", "limits": [
            {"type": "CREDIT_LIMIT", "unit": 3, "number": 5, "usage": 2000,
             "currentValue": 0, "remaining": 2000, "percentage": 0},
            {"type": "CREDIT_LIMIT", "unit": 6, "number": 1, "usage": 10000,
             "currentValue": 1612, "remaining": 8387, "percentage": 16,
             "nextResetTime": 1793145034982},
        ]},
    }

    def setUp(self):
        self._orig_secret, self._orig_http = API._secret, API._http_json
        API._secret = lambda *names: "test-key"

    def tearDown(self):
        API._secret, API._http_json = self._orig_secret, self._orig_http

    def test_no_key_skips(self):
        API._secret = lambda *names: None
        with self.assertRaises(API._Skip):
            API.fetch_zai()

    def test_limits_are_read_from_the_data_envelope(self):
        # Reading payload["limits"] off the top level found nothing and blanked
        # the whole card with "no parseable quota limits".
        API._http_json = lambda url, headers, **kw: self.ENVELOPE
        p = API.fetch_zai()
        self.assertEqual([w["label"] for w in p["windows"]], ["Session (5h)", "Weekly"])
        self.assertEqual([w["percent"] for w in p["windows"]], [0.0, 16.0])

    def test_weekly_reset_time_is_exposed(self):
        API._http_json = lambda url, headers, **kw: self.ENVELOPE
        weekly = API.fetch_zai()["windows"][1]
        self.assertEqual(weekly["resets_at"], API._iso_epoch(1793145034982 / 1000.0))

    def test_unwrapped_payload_still_parses(self):
        API._http_json = lambda url, headers, **kw: {"limits": self.ENVELOPE["data"]["limits"]}
        p = API.fetch_zai()
        self.assertEqual(len(p["windows"]), 2)

    def test_token_and_tool_windows_keep_their_labels(self):
        API._http_json = lambda url, headers, **kw: {"data": {"limits": [
            {"type": "TOKENS_LIMIT", "percentage": 12},
            {"type": "TIME_LIMIT", "percentage": 3},
        ]}}
        p = API.fetch_zai()
        self.assertEqual([w["label"] for w in p["windows"]], ["Session (5h)", "Tool quota"])

    def test_usage_over_total_is_a_percent_fallback(self):
        API._http_json = lambda url, headers, **kw: {"data": {"limits": [
            {"type": "CREDIT_LIMIT", "unit": 6, "usage": 10000, "currentValue": 2500},
        ]}}
        p = API.fetch_zai()
        self.assertEqual(p["windows"][0]["percent"], 25.0)

    def test_envelope_error_message_is_surfaced(self):
        API._http_json = lambda url, headers, **kw: {
            "code": 401, "msg": "invalid token", "success": False, "data": {},
        }
        with self.assertRaises(RuntimeError) as cm:
            API.fetch_zai()
        self.assertIn("invalid token", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
