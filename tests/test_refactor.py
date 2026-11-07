"""Tests for the Step 5.1 registry and the Step 5.3 host probe helper."""

import importlib.util
import re
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_api():
    spec = importlib.util.spec_from_file_location(
        "provider_usage_api", ROOT / "dashboard" / "plugin_api.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["provider_usage_api"] = mod
    spec.loader.exec_module(mod)
    return mod


API = load_api()

MOONSHOT_AI = "https://api.moonshot.ai/v1/users/me/balance"
MOONSHOT_CN = "https://api.moonshot.cn/v1/users/me/balance"
MINIMAX_CN_API = "https://api.minimaxi.com/v1/token_plan/remains"
MINIMAX_CN_WWW = "https://www.minimax.cn/v1/token_plan/remains"
MINIMAX_GLOBAL_API = "https://api.minimax.io/v1/token_plan/remains"
MINIMAX_GLOBAL_WWW = "https://www.minimax.io/v1/token_plan/remains"

EXPECTED = [
    ("opencode-go", "OpenCode Go", "Plan", "opencode"),
    ("openai-codex", "OpenAI Codex", "Plus", "codex"),
    ("openrouter", "OpenRouter", "Credits", "openrouter"),
    ("anthropic", "Anthropic", "Claude Code", "claude"),
    ("copilot", "GitHub Copilot", "Quota", "copilot"),
    ("nous", "Nous", "Portal", "nous"),
    ("zai", "Z.AI", "GLM", "zai"),
    ("kimi-coding", "Kimi", "Coding", "kimi"),
    ("minimax", "MiniMax", "Coding", "minimax"),
    ("deepseek", "DeepSeek", "Balance", "deepseek"),
]


class Base(unittest.TestCase):
    def setUp(self):
        self._http = API._http_json
        self._won = API._won
        self._secret = API._secret
        self._fetchers = API.FETCHERS
        self.calls = []
        self.winners = []
        API._HOST_WINNERS.clear()
        API._holds.clear()
        API._last_good.clear()
        API._history.clear()

    def tearDown(self):
        API._http_json = self._http
        API._won = self._won
        API._secret = self._secret
        API.FETCHERS = self._fetchers
        API._HOST_WINNERS.clear()
        API._holds.clear()
        API._last_good.clear()
        API._history.clear()

    def secrets(self, **values):
        API._secret = lambda *names: values.get(names[0])

    def _route(self, answers):
        def fake_http(url, headers, **kwargs):
            self.calls.append(url)
            answer = answers.get(url)
            if answer is None:
                raise FileNotFoundError("HTTP 404: no route")
            if isinstance(answer, Exception):
                raise answer
            return answer

        API._http_json = fake_http

    def record_won(self):
        API._won = lambda family, url: self.winners.append((family, url))


class RegistryTest(Base):
    def test_providers_table_order_name_tag_code(self):
        self.assertEqual(list(API.PROVIDERS), [row[0] for row in EXPECTED])
        for pid, name, tag, code in EXPECTED:
            with self.subTest(pid=pid):
                entry = API.PROVIDERS[pid]
                self.assertEqual(
                    (entry["name"], entry["tag"], entry["code"]),
                    (name, tag, code),
                )

    def test_derived_names_agree_with_providers(self):
        self.assertEqual(API.FETCH_ORDER, tuple(API.PROVIDERS))
        self.assertEqual(
            API.PROVIDER_META,
            {
                pid: {"name": p["name"], "tag": p["tag"], "code": p["code"]}
                for pid, p in API.PROVIDERS.items()
            },
        )
        self.assertEqual(
            API.FETCHERS,
            {pid: p["fetch"] for pid, p in API.PROVIDERS.items()},
        )

    def test_codes_match_the_desktop_table(self):
        source = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
        block = re.search(r"const CODE = \{(.*?)\}", source, re.S).group(1)
        desktop = dict(re.findall(r"'?([A-Za-z0-9-]+)'?\s*:\s*'([A-Za-z0-9-]+)'", block))
        self.assertEqual({pid: p["code"] for pid, p in API.PROVIDERS.items()}, desktop)


class CollectedCodeTest(Base):
    def _rows(self, fetchers):
        API.FETCHERS = fetchers
        out = API._collect()
        return {p["id"]: p for p in out["providers"]}

    def test_a_collected_row_carries_its_code(self):
        fetchers = {
            pid: (lambda pid=pid: {"id": pid, "status": "ok", "windows": []})
            for pid in API.FETCH_ORDER
        }
        rows = self._rows(fetchers)
        for pid in API.FETCH_ORDER:
            with self.subTest(pid=pid):
                self.assertEqual(rows[pid]["code"], API.PROVIDERS[pid]["code"])

    def test_an_error_row_carries_its_code(self):
        def boom():
            raise API._ProviderError("boom")

        rows = self._rows({pid: boom for pid in API.FETCH_ORDER})
        for pid in API.FETCH_ORDER:
            with self.subTest(pid=pid):
                self.assertEqual(rows[pid]["status"], "error")
                self.assertEqual(rows[pid]["code"], API.PROVIDERS[pid]["code"])

    def test_a_stale_row_carries_its_code(self):
        def boom():
            raise API._ProviderError("boom")

        pid = "zai"
        API._holds[pid] = time.time() + 120
        API._last_good[pid] = {
            "id": pid,
            "status": "ok",
            "windows": [{"label": "5h", "percent": 55.0}],
        }
        rows = self._rows({pid: boom for pid in API.FETCH_ORDER})
        self.assertTrue(rows[pid].get("stale"))
        self.assertEqual(rows[pid]["code"], API.PROVIDERS[pid]["code"])


class ProbeHostsTest(Base):
    def setUp(self):
        super().setUp()
        self.record_won()

    def test_first_host_wins(self):
        self._route({"a": {"ok": 1}, "b": {"ok": 2}})
        value, url = API._probe_hosts("fam", ("a", "b"), {}, lambda body: body["ok"])
        self.assertEqual((value, url), (1, "a"))
        self.assertEqual(self.calls, ["a"])
        self.assertEqual(self.winners, [("fam", "a")])

    def test_a_request_error_moves_on(self):
        self._route({"a": FileNotFoundError("HTTP 404"), "b": {"ok": 2}})
        value, url = API._probe_hosts("fam", ("a", "b"), {}, lambda body: body["ok"])
        self.assertEqual((value, url), (2, "b"))
        self.assertEqual(self.calls, ["a", "b"])

    def test_next_host_moves_on(self):
        def accept(body):
            if body["ok"] == 1:
                raise API._NextHost(ValueError("unusable body"))
            return body["ok"]

        self._route({"a": {"ok": 1}, "b": {"ok": 2}})
        value, url = API._probe_hosts("fam", ("a", "b"), {}, accept)
        self.assertEqual((value, url), (2, "b"))
        self.assertEqual(self.calls, ["a", "b"])

    def test_other_accept_errors_propagate(self):
        def accept(body):
            raise KeyError("not a body this helper understands")

        self._route({"a": {"ok": 1}, "b": {"ok": 2}})
        with self.assertRaises(KeyError):
            API._probe_hosts("fam", ("a", "b"), {}, accept)
        self.assertEqual(self.calls, ["a"])
        self.assertEqual(self.winners, [])

    def test_rate_limit_propagates(self):
        self._route({"a": API._RateLimited(time.time() + 60), "b": {"ok": 2}})
        with self.assertRaises(API._RateLimited):
            API._probe_hosts("fam", ("a", "b"), {}, lambda body: body["ok"])
        self.assertEqual(self.calls, ["a"])

    def test_timeout_propagates(self):
        self._route({"a": API._Timeout(), "b": {"ok": 2}})
        with self.assertRaises(API._Timeout):
            API._probe_hosts("fam", ("a", "b"), {}, lambda body: body["ok"])
        self.assertEqual(self.calls, ["a"])

    def test_remembers_the_last_error(self):
        self._route({"a": FileNotFoundError("first"), "b": ValueError("second")})
        with self.assertRaises(ValueError) as caught:
            API._probe_hosts("fam", ("a", "b"), {}, lambda body: body)
        self.assertEqual(str(caught.exception), "second")

    def test_won_is_called_only_on_success(self):
        self._route({"a": FileNotFoundError("first"), "b": ValueError("second")})
        with self.assertRaises(ValueError):
            API._probe_hosts("fam", ("a", "b"), {}, lambda body: body)
        self.assertEqual(self.winners, [])

    def test_the_remembered_host_goes_first(self):
        API._HOST_WINNERS["fam"] = "b"
        self._route({"a": {"ok": 1}, "b": {"ok": 2}})
        value, url = API._probe_hosts("fam", ("a", "b"), {}, lambda body: body["ok"])
        self.assertEqual((value, url), (2, "b"))
        self.assertEqual(self.calls, ["b"])


class MoonshotProbeTest(Base):
    def test_a_body_without_a_number_does_not_try_the_next_host(self):
        self._route(
            {
                MOONSHOT_AI: {"data": {}},
                MOONSHOT_CN: {"data": {"available_balance": 5.0}},
            }
        )
        with self.assertRaises(API._ProviderError) as caught:
            API._fetch_moonshot_balance({"Authorization": "Bearer sentinel"})
        self.assertIn("carried no available_balance", str(caught.exception))
        self.assertEqual(self.calls, [MOONSHOT_AI])


class MinimaxTest(Base):
    def test_both_keys_use_only_the_first_credential(self):
        self.secrets(MINIMAX_CN_API_KEY="cn-sentinel", MINIMAX_API_KEY="global-sentinel")
        self._route(
            {
                MINIMAX_CN_API: {"model_remains": [{"current_interval_remaining_percent": 50}]},
                MINIMAX_GLOBAL_API: {"model_remains": [{"current_interval_remaining_percent": 77}]},
            }
        )
        p = API.fetch_minimax()
        self.assertEqual(self.calls, [MINIMAX_CN_API])
        self.assertEqual(p["windows"][0]["percent"], 50.0)

    def _status_body(self, key):
        return {"base_resp": {"status_code": 2049, "status_msg": "invalid key " + key}}

    def _all_minimax_hosts(self, body):
        self._route(
            {
                MINIMAX_CN_API: body,
                MINIMAX_CN_WWW: body,
                MINIMAX_GLOBAL_API: body,
                MINIMAX_GLOBAL_WWW: body,
            }
        )

    def test_a_key_in_the_status_message_is_redacted_for_one_credential(self):
        key = "SENTINEL-MINIMAX-CN-KEY"
        self.secrets(MINIMAX_CN_API_KEY=key)
        self._all_minimax_hosts(self._status_body(key))
        with self.assertRaises(API._ProviderError) as caught:
            API.fetch_minimax()
        text = str(caught.exception)
        self.assertNotIn(key, text)
        self.assertIn("[redacted]", text)

    def test_a_key_in_the_status_message_is_redacted_for_two_credentials(self):
        cn, global_key = "SENTINEL-MINIMAX-CN-KEY", "SENTINEL-MINIMAX-GLOBAL-KEY"
        self.secrets(MINIMAX_CN_API_KEY=cn, MINIMAX_API_KEY=global_key)
        self._all_minimax_hosts(self._status_body(global_key))
        with self.assertRaises(API._ProviderError) as caught:
            API.fetch_minimax()
        text = str(caught.exception)
        self.assertNotIn(global_key, text)
        self.assertNotIn(cn, text)
        self.assertIn("[redacted]", text)


if __name__ == "__main__":
    unittest.main()
