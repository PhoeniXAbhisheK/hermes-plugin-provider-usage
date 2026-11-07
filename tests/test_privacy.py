"""Privacy tests: declared hosts, credential routing, and error payload text.

Every fetcher runs against canned HTTP fixtures through a patched httpx client,
so no request leaves the process. Credentials are unique sentinels written to a
scratch HOME; no real credential file is read.
"""

import importlib.util
import json
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path
from urllib.parse import urlsplit

import httpx

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"

ERROR_CAP = 120


def load_api():
    spec = importlib.util.spec_from_file_location(
        "provider_usage_api", ROOT / "dashboard" / "plugin_api.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["provider_usage_api"] = mod
    spec.loader.exec_module(mod)
    return mod


API = load_api()

SENTINEL = {
    "opencode": "SENTINEL-OPENCODE-GO-KEY",
    "codex": "SENTINEL-CODEX-ACCESS-TOKEN",
    "openai_platform": "SENTINEL-OPENAI-PLATFORM-KEY",
    "openrouter": "SENTINEL-OPENROUTER-KEY",
    "anthropic": "SENTINEL-ANTHROPIC-OAUTH-TOKEN",
    "copilot": "SENTINEL-COPILOT-TOKEN",
    "deepseek": "SENTINEL-DEEPSEEK-KEY",
    "kimi": "SENTINEL-KIMI-KEY",
    "zai": "SENTINEL-ZAI-KEY",
    "minimax_cn": "SENTINEL-MINIMAX-CN-KEY",
    "minimax_global": "SENTINEL-MINIMAX-GLOBAL-KEY",
}

# The only hosts a credential may be sent to, in Authorization headers.
CREDENTIAL_HOSTS = {
    "opencode": {"opencode.ai"},
    "codex": {"chatgpt.com"},
    "openrouter": {"openrouter.ai"},
    "anthropic": {"api.anthropic.com"},
    "copilot": {"api.github.com"},
    "deepseek": {"api.deepseek.com"},
    "kimi": {"api.kimi.com", "api.moonshot.ai", "api.moonshot.cn"},
    "zai": {"api.z.ai"},
    # Each MiniMax key probes its own region first and the other one second.
    "minimax_cn": {
        "api.minimaxi.com",
        "www.minimax.cn",
        "api.minimax.io",
        "www.minimax.io",
    },
    "minimax_global": {
        "api.minimaxi.com",
        "www.minimax.cn",
        "api.minimax.io",
        "www.minimax.io",
    },
}

SECRET_BY_NAME = {
    "OPENCODE_GO_API_KEY": SENTINEL["opencode"],
    "OPENROUTER_API_KEY": SENTINEL["openrouter"],
    "DEEPSEEK_API_KEY": SENTINEL["deepseek"],
    "KIMI_API_KEY": SENTINEL["kimi"],
    "ZAI_API_KEY": SENTINEL["zai"],
    "GLM_API_KEY": None,
    "MOONSHOT_API_KEY": None,
    "MINIMAX_CN_API_KEY": SENTINEL["minimax_cn"],
    "MINIMAX_API_KEY": SENTINEL["minimax_global"],
}
CREDENTIAL_SENTINELS = {
    label: value
    for label, value in SENTINEL.items()
    if label not in ("openai_platform", "minimax_global")  # the CN key answers first
}
TOKEN_SHAPED = re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}")

# Credential shapes that must never survive sanitizing, and invisible characters
# that must be stripped before a match is attempted.
OPAQUE_TOKENS = [
    "github_pat_11ABCDEFG0abcdefghijklmnop",
    "Bearer abcDEF123ghiJKL456mnoPQR789",
    "0123456789abcdef0123456789abcdef",
    "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp",
    "AIzaSyA1234567890abcdefghijklmnopqrstuv",
]
INVISIBLE = ["\x9b", "\u202e", "\u200b"]


FIXTURE_PATHS = {
    "anthropic_usage": "anthropic/ok.json",
    "codex_usage": "openai-codex/ok.json",
    "copilot_user": "copilot/ok_limited.json",
    "deepseek_balance": "deepseek/ok.json",
    "kimi_usages": "kimi-coding/ok.json",
    "minimax_remains": "minimax/ok.json",
    "opencode_go_usage": "opencode-go/ok.json",
    "openrouter_credits": "openrouter/ok_credits.json",
    "openrouter_key": "openrouter/ok_key.json",
    "zai_limits": "zai/ok.json",
}


def fixture(name):
    return (FIXTURES / FIXTURE_PATHS[name]).read_text(encoding="utf-8")


def host_of(url):
    return urlsplit(url).hostname or ""


def readme_hosts():
    """Every host named in the README provider table."""
    hosts = set()
    for line in (ROOT / "README.md").read_text(encoding="utf-8").splitlines():
        if line.startswith("|") and "https://" in line:
            hosts.update(re.findall(r"https://([A-Za-z0-9.-]+)", line))
    return hosts


class FakeResponse:
    def __init__(self, status, body, url):
        self.status_code = status
        self.text = body if isinstance(body, str) else json.dumps(body)
        self._url = url
        self.headers = {}

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("GET", self._url)
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError(
                "HTTP %d" % self.status_code, request=request, response=response
            )


class FixtureClient:
    """httpx.Client stand-in: answers from a route table, records every request."""

    def __init__(self, routes, log, unexpected):
        self._routes = routes
        self._log = log
        self._unexpected = unexpected

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def get(self, url, headers=None):
        self._log.append((url, dict(headers or {})))
        route = self._routes.get(url)
        if route is None:
            self._unexpected.append(url)
            return FakeResponse(404, "{}", url)
        if isinstance(route, Exception):
            raise route
        return FakeResponse(route[0], route[1], url)


def stub_core_modules():
    """Replace the Hermes modules the fetchers import, so nothing reaches a helper."""
    names = (
        "agent",
        "agent.account_usage",
        "hermes_cli",
        "hermes_cli.nous_account",
        "hermes_cli.copilot_auth",
    )
    saved = {name: sys.modules.get(name) for name in names}

    agent = types.ModuleType("agent")
    agent.__path__ = []
    usage = types.ModuleType("agent.account_usage")
    usage.build_nous_credits_snapshot = lambda info: None
    agent.account_usage = usage

    cli = types.ModuleType("hermes_cli")
    cli.__path__ = []
    nous = types.ModuleType("hermes_cli.nous_account")
    nous.get_nous_portal_account_info = lambda **kwargs: object()
    copilot = types.ModuleType("hermes_cli.copilot_auth")
    copilot.resolve_copilot_token = lambda: (SENTINEL["copilot"], None)
    cli.nous_account = nous
    cli.copilot_auth = copilot

    sys.modules.update(
        {
            "agent": agent,
            "agent.account_usage": usage,
            "hermes_cli": cli,
            "hermes_cli.nous_account": nous,
            "hermes_cli.copilot_auth": copilot,
        }
    )
    return saved


def restore_core_modules(saved):
    for name, module in saved.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module


class PrivacyHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.log = []
        self.unexpected = []
        self.routes = {}
        self.secrets = {}
        self._saved = {
            "home": API.HOME,
            "secret": API._secret,
            "cached": API._cached_snapshot,
            "fetch": API._fetch_usage,
            "client": httpx.Client,
        }
        API.HOME = self.home
        API._secret = self._secret
        API._cached_snapshot = lambda provider: None
        API._fetch_usage = lambda provider: None
        API._helper_cooldown.clear()
        API._holds.clear()
        API._last_good.clear()
        API._HOST_WINNERS.clear()
        self._saved_modules = stub_core_modules()
        self._write_codex(access_token=SENTINEL["codex"])
        self._write_claude()
        self._serve_success()
        httpx.Client = lambda **kwargs: FixtureClient(self.routes, self.log, self.unexpected)

    def tearDown(self):
        httpx.Client = self._saved["client"]
        API.HOME = self._saved["home"]
        API._secret = self._saved["secret"]
        API._cached_snapshot = self._saved["cached"]
        API._fetch_usage = self._saved["fetch"]
        API._holds.clear()
        API._last_good.clear()
        API._HOST_WINNERS.clear()
        restore_core_modules(self._saved_modules)
        self.tmp.cleanup()

    def _secret(self, *names):
        for name in names:
            if name in self.secrets:
                return self.secrets[name]
        return None

    def _write_codex(self, access_token=None, platform_key=None):
        payload = {"tokens": {}, "OPENAI_API_KEY": None}
        if access_token is not None:
            payload["tokens"]["access_token"] = access_token
        if platform_key is not None:
            payload["OPENAI_API_KEY"] = platform_key
        path = self.home / ".codex" / "auth.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")

    def _write_claude(self):
        path = self.home / ".claude" / ".credentials.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"claudeAiOauth": {"accessToken": SENTINEL["anthropic"]}}), encoding="utf-8"
        )

    def _serve_success(self):
        self.routes.update(
            {
                "https://opencode.ai/zen/go/v1/usage": (200, fixture("opencode_go_usage")),
                "https://chatgpt.com/backend-api/wham/usage": (200, fixture("codex_usage")),
                "https://openrouter.ai/api/v1/key": (200, fixture("openrouter_key")),
                "https://openrouter.ai/api/v1/credits": (200, fixture("openrouter_credits")),
                "https://api.anthropic.com/api/oauth/usage": (200, fixture("anthropic_usage")),
                "https://api.github.com/copilot_internal/user": (200, fixture("copilot_user")),
                "https://api.deepseek.com/user/balance": (200, fixture("deepseek_balance")),
                "https://api.kimi.com/coding/v1/usages": (200, fixture("kimi_usages")),
                "https://api.z.ai/api/monitor/usage/quota/limit": (200, fixture("zai_limits")),
                "https://api.minimaxi.com/v1/token_plan/remains": (200, fixture("minimax_remains")),
                "https://api.minimax.io/v1/token_plan/remains": (200, fixture("minimax_remains")),
            }
        )

    def _all_secrets(self):
        self.secrets = dict(SECRET_BY_NAME)

    def run_fetchers(self):
        results = {}
        for pid in API.FETCH_ORDER:
            try:
                results[pid] = API.FETCHERS[pid]()
            except API._Skip:
                results[pid] = "skip"
            except Exception as exc:  # noqa: BLE001 - the test reports the exception
                results[pid] = exc
        return results

    def requests_with(self, sentinel):
        """(host, header name) for every request whose headers carry the sentinel."""
        hits = []
        for url, headers in self.log:
            for name, value in headers.items():
                if sentinel in str(value):
                    hits.append((host_of(url), name.lower()))
        return hits


class HostAllowlistTest(PrivacyHarness):
    def test_allowlist_mirrors_the_readme(self):
        declared = set(getattr(API, "ALLOWED_HOSTS", {}))
        self.assertEqual(
            declared,
            readme_hosts(),
            "ALLOWED_HOSTS and the README provider table disagree",
        )

    def test_fetchers_only_reach_declared_hosts(self):
        self._all_secrets()
        declared = set(getattr(API, "ALLOWED_HOSTS", {})) or readme_hosts()
        self.routes["https://www.minimax.cn/v1/token_plan/remains"] = (404, "{}")
        self.routes["https://www.minimax.io/v1/token_plan/remains"] = (404, "{}")

        # A subscription key is region bound: make its first host refuse, so the
        # probe has to fall through to the next host in the chain.
        self.secrets = {"MINIMAX_CN_API_KEY": SENTINEL["minimax_cn"]}
        self.routes["https://api.minimaxi.com/v1/token_plan/remains"] = (404, "{}")
        results = self.run_fetchers()
        self.assertIsInstance(results["minimax"], dict)

        self.secrets = {"MINIMAX_API_KEY": SENTINEL["minimax_global"]}
        self.routes["https://api.minimaxi.com/v1/token_plan/remains"] = (
            200,
            fixture("minimax_remains"),
        )
        self.routes["https://api.minimax.io/v1/token_plan/remains"] = (404, "{}")
        results = self.run_fetchers()
        self.assertIsInstance(results["minimax"], dict)

        undeclared = sorted({host_of(url) for url in self.unexpected})
        self.assertEqual(undeclared, [], "undeclared host contacted: %s" % undeclared)
        seen = sorted({host_of(url) for url, _headers in self.log})
        self.assertEqual(
            [host for host in seen if host not in declared],
            [],
            "fetchers reached hosts missing from ALLOWED_HOSTS",
        )

    def test_moonshot_fallback_hosts_are_declared(self):
        self.secrets = {"KIMI_API_KEY": SENTINEL["kimi"]}
        self.routes["https://api.kimi.com/coding/v1/usages"] = (200, {})
        self.routes["https://api.moonshot.ai/v1/users/me/balance"] = (404, "{}")
        self.routes["https://api.moonshot.cn/v1/users/me/balance"] = (
            200,
            {"code": 0, "data": {"available_balance": 12.0}},
        )
        results = self.run_fetchers()
        self.assertIsInstance(results["kimi-coding"], dict)
        hosts = {host_of(url) for url, _headers in self.log}
        for host in ("api.kimi.com", "api.moonshot.ai", "api.moonshot.cn"):
            self.assertIn(host, hosts)
        self.assertEqual(self.unexpected, [])


class CredentialRoutingTest(PrivacyHarness):
    def test_credentials_reach_only_their_own_hosts(self):
        self._all_secrets()
        results = self.run_fetchers()
        for pid, result in results.items():
            if pid == "nous":
                self.assertEqual(result, "skip")  # helper stub answers nothing
            else:
                self.assertNotIsInstance(result, Exception, "%s failed: %r" % (pid, result))

        for label, sentinel in CREDENTIAL_SENTINELS.items():
            hits = self.requests_with(sentinel)
            self.assertNotEqual(hits, [], "%s was never sent" % label)
            for host, header in hits:
                self.assertIn(host, CREDENTIAL_HOSTS[label], "%s sent to %s" % (label, host))
                self.assertEqual(header, "authorization", "%s in %s header" % (label, header))

        # Second pass: the Codex store also carries an OPENAI_API_KEY entry.
        # That credential belongs to no request this plugin makes, so it must
        # never travel, whatever else the fetcher decides to do.
        self.log.clear()
        self._write_codex(platform_key=SENTINEL["openai_platform"])
        self.run_fetchers()
        self.assertEqual(self.requests_with(SENTINEL["openai_platform"]), [])

        # Kimi falls through to both Moonshot hosts with the same key.
        self.log.clear()
        self.secrets = {"KIMI_API_KEY": SENTINEL["kimi"]}
        self.routes["https://api.kimi.com/coding/v1/usages"] = (200, {})
        self.routes["https://api.moonshot.ai/v1/users/me/balance"] = (404, "{}")
        self.routes["https://api.moonshot.cn/v1/users/me/balance"] = (
            200,
            {"code": 0, "data": {"available_balance": 12.0}},
        )
        self.run_fetchers()
        hosts = {host for host, _header in self.requests_with(SENTINEL["kimi"])}
        self.assertEqual(hosts, {"api.kimi.com", "api.moonshot.ai", "api.moonshot.cn"})

        # The global MiniMax key probes its own region first, then the other.
        self.log.clear()
        self.secrets = {"MINIMAX_API_KEY": SENTINEL["minimax_global"]}
        self.routes["https://api.minimax.io/v1/token_plan/remains"] = (404, "{}")
        self.routes["https://api.minimaxi.com/v1/token_plan/remains"] = (
            200,
            fixture("minimax_remains"),
        )
        self.run_fetchers()
        hosts = {host for host, _header in self.requests_with(SENTINEL["minimax_global"])}
        self.assertEqual(hosts, {"api.minimaxi.com", "api.minimax.io", "www.minimax.io"})

    def test_platform_key_is_never_sent(self):
        # ~/.codex/auth.json also carries an OPENAI_API_KEY entry. The plugin
        # reads the OAuth access token only; the platform key must never leave.
        self._write_codex(platform_key=SENTINEL["openai_platform"])
        with self.assertRaises(API._Skip):
            API.fetch_openai_codex()
        self.assertEqual(self.requests_with(SENTINEL["openai_platform"]), [])


class ErrorPayloadTest(PrivacyHarness):
    def _failing_collect(self):
        token_like = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZW50aW5lbCJ9.c2lnbmF0dXJl"
        self.secrets = {
            "OPENCODE_GO_API_KEY": SENTINEL["opencode"],
            "ZAI_API_KEY": SENTINEL["zai"],
            "MINIMAX_CN_API_KEY": SENTINEL["minimax_cn"],
            "DEEPSEEK_API_KEY": SENTINEL["deepseek"],
        }
        # 200 with a non-JSON body that reflects the key.
        self.routes["https://opencode.ai/zen/go/v1/usage"] = (
            200,
            "unauthorized token " + SENTINEL["opencode"] + " rejected",
        )
        # Envelope msg: reflected key, a token-shaped string, a newline and a
        # control character, plus enough text to exceed the cap.
        self.routes["https://api.z.ai/api/monitor/usage/quota/limit"] = (
            200,
            {
                "code": 401,
                "success": False,
                "msg": "invalid token "
                + SENTINEL["zai"]
                + " "
                + token_like
                + "\nsecond line\x01 "
                + "padding " * 30,
                "data": {},
            },
        )
        # MiniMax status_msg carries the key on every host.
        for host in ("api.minimaxi.com", "www.minimax.cn", "api.minimax.io", "www.minimax.io"):
            self.routes["https://%s/v1/token_plan/remains" % host] = (
                200,
                {
                    "base_resp": {
                        "status_code": 2049,
                        "status_msg": "invalid api key " + SENTINEL["minimax_cn"],
                    }
                },
            )
        self.routes["https://api.minimax.io/v1/token_plan/remains"] = (
            200,
            {
                "base_resp": {
                    "status_code": 2049,
                    "status_msg": "invalid api key " + SENTINEL["minimax_cn"],
                }
            },
        )
        # A raised exception whose text carries another key.
        self.routes["https://api.deepseek.com/user/balance"] = RuntimeError(
            "reflected " + SENTINEL["deepseek"]
        )
        return API._collect()

    def test_error_payload_has_no_credentials(self):
        payload = self._failing_collect()
        blob = json.dumps(payload)
        for label, value in SENTINEL.items():
            self.assertNotIn(value, blob, "%s leaked into the payload" % label)
        self.assertIsNone(TOKEN_SHAPED.search(blob), "token-shaped text reached the payload")

    def test_error_rows_are_single_line_and_capped(self):
        payload = self._failing_collect()
        self.assertEqual(
            getattr(API, "ERROR_MAX_CHARS", ERROR_CAP), ERROR_CAP, "cap constant changed"
        )
        rows = {p["id"]: p for p in payload["providers"] if p.get("status") == "error"}
        self.assertEqual(
            set(rows), {"opencode-go", "zai", "minimax", "deepseek"}, "missing error rows"
        )
        for pid, row in rows.items():
            text = row["error"]
            self.assertTrue(text, "%s carries no error text" % pid)
            self.assertLessEqual(len(text), ERROR_CAP, "%s error is %d chars" % (pid, len(text)))
            self.assertNotRegex(text, r"[\x00-\x1f\x7f]", "%s error has control characters" % pid)

    def _zai_says(self, message):
        self.secrets = {"ZAI_API_KEY": SENTINEL["zai"]}
        self.routes["https://api.z.ai/api/monitor/usage/quota/limit"] = (
            200,
            {"code": 401, "success": False, "msg": message, "data": {}},
        )
        payload = API._collect()
        return next(p for p in payload["providers"] if p["id"] == "zai")["error"]

    def test_minimax_wrapper_keeps_raw_text_out(self):
        self.secrets = {"MINIMAX_CN_API_KEY": SENTINEL["minimax_cn"]}
        raw = "raw provider text not on the allowlist"
        self.routes["https://api.minimaxi.com/v1/token_plan/remains"] = RuntimeError(raw)
        self.routes["https://api.minimax.io/v1/token_plan/remains"] = RuntimeError(raw)
        payload = API._collect()
        error = next(p for p in payload["providers"] if p["id"] == "minimax")["error"]
        self.assertNotIn(raw, error)

    def test_minimax_status_message_still_shows(self):
        payload = self._failing_collect()
        error = next(p for p in payload["providers"] if p["id"] == "minimax")["error"]
        self.assertIn("invalid api key", error)

    def test_os_error_paths_do_not_reach_the_payload(self):
        self.secrets = {
            "DEEPSEEK_API_KEY": SENTINEL["deepseek"],
            "OPENROUTER_API_KEY": SENTINEL["openrouter"],
        }
        self.routes["https://api.deepseek.com/user/balance"] = PermissionError(
            "/srv/provider-usage/deepseek.json: permission denied"
        )
        self.routes["https://openrouter.ai/api/v1/key"] = FileNotFoundError(
            "/srv/provider-usage/openrouter.json: no such file"
        )
        payload = API._collect()
        rows = {p["id"]: p["error"] for p in payload["providers"] if p.get("status") == "error"}
        self.assertEqual(rows["deepseek"], "permission denied")
        self.assertEqual(rows["openrouter"], "not found")
        self.assertNotIn("/srv/", json.dumps(payload))
        self.assertNotIn("deepseek.json", json.dumps(payload))

    def test_token_shapes_are_redacted(self):
        error = self._zai_says("invalid token " + " ".join(OPAQUE_TOKENS))
        for token in OPAQUE_TOKENS:
            self.assertNotIn(token, error)
        self.assertNotIn("abcDEF123ghiJKL456mnoPQR789", error)  # the Bearer value itself
        self.assertIn("invalid token", error)

    def test_invisible_characters_are_stripped(self):
        error = self._zai_says("invalid token " + "".join(INVISIBLE) + " rejected")
        for char in INVISIBLE:
            self.assertNotIn(char, error)
        self.assertIn("invalid token", error)

    def test_request_error_shapes(self):
        for exc in (
            httpx.ReadError("boom"),
            httpx.RemoteProtocolError("boom"),
            httpx.ProxyError("boom"),
        ):
            self.assertEqual(API._error_message(exc), "connection failed", type(exc).__name__)
        self.assertEqual(API._error_message(httpx.ConnectTimeout("boom")), "timeout")


class LogRedactionTest(PrivacyHarness):
    def test_log_never_carries_a_credential(self):
        self.secrets = {
            "OPENCODE_GO_API_KEY": SENTINEL["opencode"],
            "ZAI_API_KEY": SENTINEL["zai"],
            "MINIMAX_CN_API_KEY": SENTINEL["minimax_cn"],
            "DEEPSEEK_API_KEY": SENTINEL["deepseek"],
        }
        self.routes["https://opencode.ai/zen/go/v1/usage"] = (
            200,
            "unauthorized token " + SENTINEL["opencode"],
        )
        self.routes["https://api.z.ai/api/monitor/usage/quota/limit"] = (
            200,
            {
                "code": 401,
                "success": False,
                "msg": "invalid token " + SENTINEL["zai"],
                "data": {},
            },
        )
        self.routes["https://api.minimaxi.com/v1/token_plan/remains"] = (
            200,
            {
                "base_resp": {
                    "status_code": 2049,
                    "status_msg": "invalid api key " + SENTINEL["minimax_cn"],
                }
            },
        )
        self.routes["https://api.minimax.io/v1/token_plan/remains"] = (
            200,
            {
                "base_resp": {
                    "status_code": 2049,
                    "status_msg": "invalid api key " + SENTINEL["minimax_cn"],
                }
            },
        )
        self.routes["https://api.deepseek.com/user/balance"] = RuntimeError(
            "reflected " + SENTINEL["deepseek"]
        )
        with self.assertLogs("provider_usage_api", level="WARNING") as captured:
            API._collect()
        text = "\n".join(captured.output)
        self.assertGreaterEqual(len(captured.output), 4)
        for label, value in SENTINEL.items():
            self.assertNotIn(value, text, "%s leaked into the log" % label)


if __name__ == "__main__":
    unittest.main()
