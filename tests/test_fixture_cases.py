"""Fixture-driven fetcher cases, one directory per FETCHERS id.

Each fixture is invented or fully redacted. A case is a fixture file plus a mode
that tells the harness how to feed it to the real fetcher. The manifest below is
the only way a fixture gets used, and ``test_manifest_covers_disk`` fails when a
file on disk is missing from it, so an unused file cannot satisfy the meta-test.
"""

import importlib.util
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"


def load_api():
    spec = importlib.util.spec_from_file_location(
        "provider_usage_api", ROOT / "dashboard" / "plugin_api.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["provider_usage_api"] = mod
    spec.loader.exec_module(mod)
    return mod


API = load_api()
REAL_HERMES_USAGE = API._hermes_usage

# provider id -> [(fixture name or (names...), mode, expected outcome)]
# expected outcome: "ok", "skip" or "error"
CASES = {
    "opencode-go": [
        ("ok.json", "http", "ok"),
        ("skip_no_key.json", "no_key", "skip"),
    ],
    "openai-codex": [
        ("ok.json", "http", "ok"),
        ("hermes.json", "snapshot", "ok"),
        ("skip_no_token.json", "no_key", "skip"),
    ],
    "openrouter": [
        (("ok_key.json", "ok_credits.json"), "openrouter", "ok"),
        ("skip_no_key.json", "no_key", "skip"),
    ],
    "anthropic": [
        ("ok.json", "http", "ok"),
        ("ok_limits.json", "http", "ok"),
        ("skip_no_token.json", "no_key", "skip"),
    ],
    "copilot": [
        ("ok_limited.json", "http", "ok"),
        ("ok_unlimited_mixed.json", "http", "ok"),
        ("skip_zero_entitlement.json", "http", "skip"),
    ],
    "nous": [
        ("ok.json", "nous", "ok"),
        ("skip_no_account.json", "no_account", "skip"),
    ],
    "zai": [
        ("ok.json", "http", "ok"),
        ("error_500.json", "http", "error"),
    ],
    "kimi-coding": [
        ("ok.json", "http", "ok"),
        ("ok_after_reset.json", "http", "ok"),
        ("ok_usages.json", "http", "ok"),
        ("skip_no_key.json", "no_key", "skip"),
    ],
    "minimax": [
        ("ok.json", "http", "ok"),
        ("error_500.json", "http", "error"),
    ],
    "deepseek": [
        ("ok.json", "http", "ok"),
        ("ok_multi_currency.json", "http", "ok"),
        ("skip_no_key.json", "no_key", "skip"),
    ],
}


def fixture_path(pid, name):
    return FIXTURES / pid / name


def snapshot_from(body):
    """A core-snapshot stand-in built from a JSON fixture."""
    windows = []
    for w in body.get("windows") or []:
        reset = w.get("reset_at")
        when = None
        if isinstance(reset, str):
            when = datetime.strptime(reset, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        windows.append(
            SimpleNamespace(
                label=w.get("label"),
                used_percent=w.get("used_percent"),
                reset_at=when,
            )
        )
    return SimpleNamespace(
        available=bool(body.get("available")),
        windows=windows,
        fetched_at=datetime.now(timezone.utc),
    )


class FixtureCaseTest(unittest.TestCase):
    def setUp(self):
        self._saved = {
            "_secret": API._secret,
            "_read_text": API._read_text,
            "_http_json": API._http_json,
            "_cached_snapshot": API._cached_snapshot,
            "_fetch_usage": API._fetch_usage,
            "_hermes_usage": API._hermes_usage,
            "_claude_code_oauth_token": API._claude_code_oauth_token,
        }
        self._saved_modules = {
            name: sys.modules.get(name)
            for name in ("agent.account_usage", "hermes_cli.copilot_auth")
        }
        self._reset()

    def tearDown(self):
        self._restore()
        self._clean_shared()

    def _clean_shared(self):
        for bucket in (
            API._helper_cooldown,
            API._holds,
            API._last_good,
            API._history,
            API._HOST_WINNERS,
        ):
            bucket.clear()
        for name in ("_direct_cooldown", "_direct_readings"):
            getattr(API, name, {}).clear()

    def _reset(self):
        API._secret = lambda *names: "sentinel-key"
        API._read_text = lambda path: '{"tokens": {"access_token": "sentinel-token"}}'
        API._hermes_usage = lambda provider: None
        API._claude_code_oauth_token = lambda: None
        API._helper_cooldown.clear()
        API._holds.clear()
        API._last_good.clear()
        API._history.clear()
        if hasattr(API, "_direct_cooldown"):
            API._direct_cooldown.clear()
        if hasattr(API, "_direct_readings"):
            API._direct_readings.clear()
        API._HOST_WINNERS.clear()

    def _restore(self):
        for name, value in self._saved.items():
            setattr(API, name, value)
        for name, module in self._saved_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def _copilot_stub(self, token="sentinel-token"):
        module = SimpleNamespace(resolve_copilot_token=lambda: (token, None))
        sys.modules["hermes_cli.copilot_auth"] = module

    def _nous_stub(self, body):
        account = sys.modules.get("agent.account_usage")
        if account is None:
            account = SimpleNamespace()
            sys.modules["agent.account_usage"] = account
        snap = snapshot_from(body) if body is not None else None
        account.build_nous_credits_snapshot = lambda info: snap
        portal = sys.modules.get("hermes_cli.nous_account") or SimpleNamespace()
        portal.get_nous_portal_account_info = lambda **kwargs: {}
        sys.modules["hermes_cli.nous_account"] = portal

    def _apply(self, pid, mode, bodies):
        body = bodies[0] if bodies else None
        if pid == "copilot":
            self._copilot_stub()
        if pid == "anthropic" and mode == "http":
            API._claude_code_oauth_token = lambda: "sentinel-token"
        if mode == "http":
            API._http_json = lambda url, headers, **kwargs: body
        elif mode == "openrouter":
            key_body, credits_body = bodies

            def http(url, headers, **kwargs):
                return key_body if url.endswith("/key") else credits_body

            API._http_json = http
        elif mode == "no_key":
            API._secret = lambda *names: None
            API._read_text = lambda path: "{}"
            API._claude_code_oauth_token = lambda: None
            if pid == "copilot":
                self._copilot_stub(token=None)
        elif mode == "snapshot":
            API._hermes_usage = REAL_HERMES_USAGE
            API._cached_snapshot = lambda provider: snapshot_from(body)
            API._fetch_usage = lambda provider: None
        elif mode == "nous":
            self._nous_stub(body)
        elif mode == "no_account":
            self._nous_stub(None)

    def _run_case(self, pid):
        try:
            payload = API.FETCHERS[pid]()
        except API._Skip:
            return "skip", None
        except Exception as exc:  # noqa: BLE001 - any failure is an error case
            return "error", exc
        return "ok", payload

    def test_cases(self):
        for pid, cases in CASES.items():
            for files, mode, expect in cases:
                names = files if isinstance(files, tuple) else (files,)
                bodies = [
                    json.loads(fixture_path(pid, name).read_text(encoding="utf-8"))
                    for name in names
                ]
                with self.subTest(pid=pid, case=names[0]):
                    self._reset()
                    try:
                        self._apply(pid, mode, bodies)
                        outcome, payload = self._run_case(pid)
                    finally:
                        self._restore()
                        self._clean_shared()
                        self._reset()
                    self.assertEqual(outcome, expect, "%s %s" % (pid, names[0]))
                    if expect == "ok":
                        self.assertIsNotNone(payload)
                        assert payload is not None
                        self.assertEqual(payload["id"], pid)
                        self.assertTrue(
                            payload.get("windows") or payload.get("money"),
                            "an ok case rendered no rows",
                        )
                        if pid == "copilot" and names[0] == "ok_unlimited_mixed.json":
                            labels = [row["label"] for row in payload["windows"]]
                            self.assertEqual(labels, ["Chat"], "an unlimited entry was rendered")
                        if pid == "deepseek" and names[0] == "ok_multi_currency.json":
                            curs = sorted(row["cur"] for row in payload["money"])
                            self.assertEqual(curs, ["CNY", "USD"])
                        if pid == "anthropic" and names[0] == "ok_limits.json":
                            keys = (
                                "label",
                                "percent",
                                "resets_at",
                                "duration_seconds",
                                "scope",
                                "key",
                            )
                            rows = [tuple(row[k] for k in keys) for row in payload["windows"]]
                            self.assertEqual(
                                rows,
                                [
                                    ("5h", 12.5, "2026-11-13T07:00:00Z", 18000, "account", "5h"),
                                    (
                                        "Weekly",
                                        20.0,
                                        "2026-11-13T07:00:00Z",
                                        604800,
                                        "account",
                                        "weekly",
                                    ),
                                    (
                                        "Sonnet",
                                        42.0,
                                        "2025-11-13T02:13:20Z",
                                        604800,
                                        "model",
                                        "sonnet:weekly",
                                    ),
                                    (
                                        "Fable",
                                        15.0,
                                        "2026-11-13T07:00:00.016532+00:00",
                                        604800,
                                        "model",
                                        "fable:weekly",
                                    ),
                                ],
                            )
                        if pid == "kimi-coding":
                            if names[0] == "ok_usages.json":
                                rows = [
                                    (
                                        row["label"],
                                        row["percent"],
                                        row["resets_at"],
                                        row.get("duration_seconds"),
                                        row["scope"],
                                        row["key"],
                                    )
                                    for row in payload["windows"]
                                ]
                                self.assertEqual(
                                    rows,
                                    [
                                        (
                                            "5h",
                                            0.0,
                                            "2026-11-09T18:15:17.902245Z",
                                            18000,
                                            "account",
                                            "5h",
                                        ),
                                        (
                                            "Monthly",
                                            100.0,
                                            "2026-11-13T00:00:00Z",
                                            2592000,
                                            "account",
                                            "monthly",
                                        ),
                                        (
                                            "Code",
                                            32.9,
                                            "2026-11-13T00:00:00Z",
                                            2592000,
                                            "model",
                                            "code:monthly",
                                        ),
                                        ("Booster", 48.3, None, None, "account", "booster"),
                                    ],
                                )
                                self.assertNotIn("money", payload)
                            else:
                                rows = [
                                    (row["label"], row["percent"], row["resets_at"])
                                    for row in payload["windows"]
                                ]
                                self.assertEqual(
                                    rows,
                                    [
                                        ("Weekly", 26.0, "2026-02-11T17:32:50.757941Z"),
                                        ("5h", 15.0, "2026-02-07T12:32:50.757941Z"),
                                    ],
                                )

    def test_manifest_covers_disk(self):
        for pid, cases in CASES.items():
            listed = set()
            for files, _mode, _expect in cases:
                listed.update(files if isinstance(files, tuple) else (files,))
            on_disk = {p.name for p in (FIXTURES / pid).glob("*.json")}
            self.assertEqual(on_disk, listed, "%s has an unused or missing fixture" % pid)

    def test_every_fetcher_has_an_ok_case_and_a_failure_case(self):
        self.assertEqual(set(CASES), set(API.FETCHERS), "a fetcher has no fixture directory")
        for pid, cases in CASES.items():
            expects = {expect for _files, _mode, expect in cases}
            self.assertIn("ok", expects, pid)
            self.assertTrue(expects & {"skip", "error"}, "%s has no skip or error case" % pid)


if __name__ == "__main__":
    unittest.main()
