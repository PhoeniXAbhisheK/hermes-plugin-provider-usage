"""Tests for _num, _window and the ten window-row sites."""

import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace

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

NAN = float("nan")
INF = float("inf")


class Base(unittest.TestCase):
    MODULES = ("agent", "agent.account_usage", "hermes_cli", "hermes_cli.nous_account")

    def setUp(self):
        self._http = API._http_json
        self._secret = API._secret
        self._read_text = API._read_text
        self._token = API._claude_code_oauth_token
        self._helper = API._helper_call
        self._saved = {name: sys.modules.get(name) for name in self.MODULES}
        API._HOST_WINNERS.clear()

    def tearDown(self):
        API._http_json = self._http
        API._secret = self._secret
        API._read_text = self._read_text
        API._claude_code_oauth_token = self._token
        API._helper_call = self._helper
        for name, module in self._saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        API._HOST_WINNERS.clear()

    def http(self, body):
        API._http_json = lambda url, headers, **kwargs: body

    def secret(self, value="sentinel"):
        API._secret = lambda *names: value

    def nous(self, snap):
        agent = types.ModuleType("agent")
        agent.__path__ = []
        usage = types.ModuleType("agent.account_usage")
        usage.build_nous_credits_snapshot = lambda info: snap
        agent.account_usage = usage
        cli = types.ModuleType("hermes_cli")
        cli.__path__ = []
        nous = types.ModuleType("hermes_cli.nous_account")
        nous.get_nous_portal_account_info = lambda **kwargs: object()
        cli.nous_account = nous
        sys.modules.update(
            {
                "agent": agent,
                "agent.account_usage": usage,
                "hermes_cli": cli,
                "hermes_cli.nous_account": nous,
            }
        )
        API._helper_call = lambda fn, **kwargs: object()

    def copilot(self):
        cli = types.ModuleType("hermes_cli")
        cli.__path__ = []
        copilot = types.ModuleType("hermes_cli.copilot_auth")
        copilot.resolve_copilot_token = lambda: ("sentinel", None)
        cli.copilot_auth = copilot
        sys.modules.update({"hermes_cli": cli, "hermes_cli.copilot_auth": copilot})


class NumberTest(unittest.TestCase):
    def test_num_rejects_bool_nan_and_infinities(self):
        for value in (True, False, NAN, INF, -INF, "inf", "-inf", "nan"):
            with self.subTest(value=value):
                self.assertIsNone(API._num(value))

    def test_num_accepts_numbers_and_numeric_strings(self):
        self.assertEqual(API._num(42.5), 42.5)
        self.assertEqual(API._num("42.5"), 42.5)
        self.assertEqual(API._num(0), 0.0)

    def test_window_in_range(self):
        row = API._window("5h", 42.5, "2026-01-01T00:00:00Z")
        self.assertEqual(row["percent"], 42.5)

    def test_window_rounds_to_one_decimal(self):
        self.assertEqual(API._window("a", 12.34, None)["percent"], 12.3)
        self.assertEqual(API._window("a", 12.36, None)["percent"], 12.4)

    def test_window_clamps_above_and_below(self):
        self.assertEqual(API._window("a", 100.04, None)["percent"], 100.0)
        self.assertEqual(API._window("a", 100.06, None)["percent"], 100.0)
        self.assertEqual(API._window("a", 1000, None)["percent"], 100.0)
        self.assertEqual(API._window("a", -5, None)["percent"], 0.0)

    def test_window_accepts_a_numeric_string(self):
        self.assertEqual(API._window("a", "42.5", None)["percent"], 42.5)

    def test_window_rejects_unusable_values(self):
        for value in (None, "abc", True, False, NAN, INF, -INF):
            with self.subTest(value=value):
                self.assertIsNone(API._window("a", value, None))

    def test_window_status_default_and_passed(self):
        self.assertEqual(API._window("a", 1, None)["status"], "ok")
        self.assertEqual(API._window("a", 1, None, "stale")["status"], "stale")

    def test_window_keys_and_order(self):
        row = API._window("5h", 1.0, "x")
        self.assertEqual(list(row), ["label", "percent", "resets_at", "status", "scope"])
        self.assertEqual(row["label"], "5h")
        self.assertEqual(row["resets_at"], "x")


class SiteTest(Base):
    def test_opencode_go_clamps_and_skips(self):
        self.secret()
        self.http(
            {
                "usage": {
                    "rolling": {"percent": 100.06},
                    "weekly": {"percent": "nan"},
                    "monthly": {"percent": 12.34},
                }
            }
        )
        p = API.fetch_opencode_go()
        rows = {row["label"]: row["percent"] for row in p["windows"]}
        self.assertEqual(rows, {"5h": 100.0, "Monthly": 12.3})

    def test_opencode_go_keeps_each_window_status(self):
        self.secret()
        cases = (("warn", {"status": "warn"}, "warn"), (None, {}, "ok"))
        for name, extra, expected in cases:
            with self.subTest(name=name):
                self.http({"usage": {"rolling": dict({"percent": 40}, **extra)}})
                p = API.fetch_opencode_go()
                self.assertEqual(p["windows"][0]["status"], expected)

    def test_codex_direct_clamps_and_skips(self):
        self._read_text = API._read_text
        API._read_text = lambda path: json.dumps({"tokens": {"access_token": "sentinel"}})
        self.http(
            {
                "rate_limit": {
                    "primary_window": {"used_percent": 100.06, "limit_window_seconds": 18000},
                    "secondary_window": {"used_percent": None, "limit_window_seconds": 604800},
                },
                "plan_type": "plus",
            }
        )
        p = API._codex_direct()
        self.assertEqual([(r["label"], r["percent"]) for r in p["windows"]], [("5h", 100.0)])

    def test_snap_payload_clamps_and_skips(self):
        snap = SimpleNamespace(
            available=True,
            windows=[
                SimpleNamespace(label="A", used_percent=150.06, reset_at=None),
                SimpleNamespace(label="B", used_percent=NAN, reset_at=None),
            ],
        )
        p = API._snap_payload("zai", snap)
        self.assertEqual([(r["label"], r["percent"]) for r in p["windows"]], [("A", 100.0)])

    def test_nous_clamps_and_skips(self):
        snap = SimpleNamespace(
            available=True,
            windows=[
                SimpleNamespace(label="Credits", used_percent=140.0, reset_at=None),
                SimpleNamespace(label="Other", used_percent=NAN, reset_at=None),
            ],
        )
        self.nous(snap)
        p = API.fetch_nous()
        self.assertEqual([(r["label"], r["percent"]) for r in p["windows"]], [("Credits", 100.0)])

    def test_copilot_clamps_and_skips(self):
        self.copilot()
        self.http(
            {
                "quota_snapshots": {
                    "premium_interactions": {"entitlement": 300, "percent_remaining": 150},
                    "chat": {"entitlement": 200, "percent_remaining": "42"},
                    "completions": {"entitlement": 100, "percent_remaining": NAN},
                }
            }
        )
        p = API.fetch_copilot()
        rows = {row["label"]: row["percent"] for row in p["windows"]}
        self.assertEqual(rows, {"Premium requests": 0.0, "Chat": 58.0})

    def test_kimi_usage_row_clamps_and_skips(self):
        self.secret()
        self.http(
            {
                "usage": {"limit": "100", "used": "150"},
                "limits": [{"percentage": NAN, "window": "5h"}],
            }
        )
        p = API.fetch_kimi()
        self.assertEqual([(r["label"], r["percent"]) for r in p["windows"]], [("Weekly", 100.0)])

    def test_kimi_limits_row_clamps_and_skips(self):
        self.secret()
        self.http(
            {
                "usage": {"limit": "100", "used": "26"},
                "limits": [
                    {"percentage": 120.04, "window": "5h"},
                    {"percentage": NAN, "window": "Weekly"},
                ],
            }
        )
        p = API.fetch_kimi()
        rows = [(r["label"], r["percent"]) for r in p["windows"]]
        self.assertEqual(rows, [("Weekly", 26.0), ("5h", 100.0)])

    def test_zai_clamps_and_skips(self):
        self.secret()
        self.http(
            {
                "data": {
                    "limits": [
                        {"type": "TOKENS_LIMIT", "percentage": 120.04},
                        {"type": "TIME_LIMIT", "percentage": NAN},
                    ]
                }
            }
        )
        p = API.fetch_zai()
        self.assertEqual(
            [(r["label"], r["percent"]) for r in p["windows"]],
            [("Session (5h)", 100.0)],
        )

    def test_minimax_clamps_and_skips(self):
        self.secret()
        self.http(
            {
                "model_remains": [
                    {
                        "current_interval_remaining_percent": -20,
                        "current_weekly_remaining_percent": "nan",
                    }
                ]
            }
        )
        p = API.fetch_minimax()
        self.assertEqual([(r["label"], r["percent"]) for r in p["windows"]], [("5h", 100.0)])


class NoRowsTest(Base):
    def test_opencode_go_all_skipped_raises_skip(self):
        self.secret()
        self.http({"usage": {"rolling": {"percent": NAN}, "weekly": {"percent": NAN}}})
        with self.assertRaises(API._Skip):
            API.fetch_opencode_go()

    def test_codex_direct_all_skipped_raises_skip(self):
        API._read_text = lambda path: json.dumps({"tokens": {"access_token": "sentinel"}})
        self.http(
            {
                "rate_limit": {
                    "primary_window": {"used_percent": NAN},
                    "secondary_window": {"used_percent": None},
                }
            }
        )
        with self.assertRaises(API._Skip):
            API._codex_direct()

    def test_snap_payload_all_skipped_returns_none(self):
        snap = SimpleNamespace(
            available=True,
            windows=[
                SimpleNamespace(label="A", used_percent=NAN, reset_at=None),
                SimpleNamespace(label="B", used_percent=None, reset_at=None),
            ],
        )
        self.assertIsNone(API._snap_payload("zai", snap))


if __name__ == "__main__":
    unittest.main()
