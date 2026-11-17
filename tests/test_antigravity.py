"""Google Antigravity quota: the agy /usage reader.

Everything here is synthetic. No test runs the real agy binary: subprocess.run
is replaced and every call is recorded.
"""

import importlib.util
import json
import logging
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OK = json.loads((ROOT / "tests" / "fixtures" / "antigravity-oauth" / "ok.json").read_text("utf-8"))


def load_api():
    spec = importlib.util.spec_from_file_location(
        "provider_usage_agy", ROOT / "dashboard" / "plugin_api.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["provider_usage_agy"] = mod
    spec.loader.exec_module(mod)
    return mod


API = load_api()
AGY = "/opt/agy/bin/agy"


class AgyBase(unittest.TestCase):
    version = "1.5.10\n"
    usage = OK

    def setUp(self):
        self.calls = []
        self._run = API.subprocess.run
        self._bin = API._agy_binary
        API._agy_binary = lambda: AGY
        API.subprocess.run = self._fake_run
        self.addCleanup(self._restore)

    def _restore(self):
        API.subprocess.run = self._run
        API._agy_binary = self._bin

    def _fake_run(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        if argv[1:] == ["--version"]:
            return subprocess.CompletedProcess(argv, 0, self.version, "")
        body = self.usage if isinstance(self.usage, str) else json.dumps(self.usage)
        return subprocess.CompletedProcess(argv, 0, body, "")


class ReadTest(AgyBase):
    def test_rows_are_distinct_groups_never_summed(self):
        out = API.fetch_antigravity_oauth()
        rows = {(r["key"]): r for r in out["windows"]}
        self.assertEqual(out["id"], "antigravity-oauth")
        self.assertEqual(
            sorted(rows),
            ["claude_and_gpt_models:weekly", "gemini_models:5h", "gemini_models:weekly"],
        )
        gem = rows["gemini_models:5h"]
        self.assertEqual(
            (gem["label"], gem["percent"], gem["scope"], gem["duration_seconds"]),
            ("Gemini Models 5h", 50.0, "model", 18000),
        )
        self.assertEqual(gem["resets_at"], "2026-11-17T15:00:00Z")
        self.assertEqual(rows["gemini_models:weekly"]["percent"], 25.0)
        self.assertEqual(rows["claude_and_gpt_models:weekly"]["percent"], 0.0)

    def test_argv_is_fixed_and_shell_free_with_a_timeout(self):
        API.fetch_antigravity_oauth()
        self.assertEqual(
            [argv for argv, _ in self.calls],
            [[AGY, "--version"], [AGY, "-p", "/usage", "--output-format", "json"]],
        )
        for _argv, kw in self.calls:
            self.assertFalse(kw.get("shell", False))
            self.assertGreater(kw["timeout"], 0)
            self.assertEqual(kw["stdin"], subprocess.DEVNULL)
            self.assertEqual(kw["cwd"], tempfile.gettempdir())

    def test_unknown_window_gets_no_invented_length(self):
        body = json.loads(json.dumps(OK))
        body["command"]["data"]["groups"] = [
            {"name": "G", "buckets": [{"window": "daily", "remaining_fraction": 0.9}]}
        ]
        self.usage = body
        row = API.fetch_antigravity_oauth()["windows"][0]
        self.assertNotIn("duration_seconds", row)
        self.assertEqual(row["label"], "G daily")
        self.assertIsNone(row["resets_at"])

    def test_fraction_is_clamped_and_junk_buckets_dropped(self):
        body = json.loads(json.dumps(OK))
        body["command"]["data"]["groups"] = [
            {
                "name": "G",
                "buckets": [
                    {"window": "5h", "remaining_fraction": 1.7},
                    {"window": "weekly", "remaining_fraction": "x"},
                    {"window": "weekly", "remaining_fraction": True},
                    "nope",
                ],
            },
            "nope",
        ]
        self.usage = body
        rows = API.fetch_antigravity_oauth()["windows"]
        self.assertEqual([r["percent"] for r in rows], [0.0])


class GateTest(AgyBase):
    def assert_never_asked_usage(self):
        self.assertEqual([argv[1:] for argv, _ in self.calls], [["--version"]])

    def test_no_binary_skips(self):
        API._agy_binary = lambda: None
        with self.assertRaises(API._Skip):
            API.fetch_antigravity_oauth()
        self.assertEqual(self.calls, [])

    def test_old_version_never_runs_usage(self):
        for version in ("1.1.10", "1.0.99", "0.9.0 (build 3)"):
            self.calls.clear()
            self.version = version + "\n"
            with self.subTest(version=version), self.assertRaises(API._Skip):
                API.fetch_antigravity_oauth()
            self.assert_never_asked_usage()

    def test_unparseable_version_is_treated_as_too_old(self):
        for version in ("", "agy dev\n", "1.1\n", "garbage 1.2.3", "1.1.11-rc.1"):
            self.calls.clear()
            self.version = version
            with self.subTest(version=version), self.assertRaises(API._Skip):
                API.fetch_antigravity_oauth()
            self.assert_never_asked_usage()

    def test_minimum_version_is_accepted(self):
        for version in ("1.1.11", "agy 1.1.11", "v1.2.0", "2.0.0"):
            self.calls.clear()
            self.version = version
            with self.subTest(version=version):
                self.assertTrue(API.fetch_antigravity_oauth()["windows"])

    def test_version_call_failure_skips(self):
        def boom(argv, **kwargs):
            raise subprocess.TimeoutExpired(argv, 1)

        API.subprocess.run = boom
        with self.assertRaises(API._Skip):
            API.fetch_antigravity_oauth()


class FailureTest(AgyBase):
    SECRET_TEXT = "RAW-ACCOUNT-TEXT-sk-abcdefghijklmnop"

    def check_fails(self):
        with (
            self.assertLogs(level=logging.DEBUG) as logs,
            self.assertRaises((API._ProviderError, API._Timeout)) as ctx,
        ):
            logging.getLogger().warning("anchor")  # assertLogs needs one record
            API.fetch_antigravity_oauth()
        message = API._error_message(ctx.exception)
        self.assertNotIn("RAW-ACCOUNT", message)
        self.assertNotIn("RAW-ACCOUNT", "\n".join(logs.output))
        return ctx.exception, message

    def test_non_success_status(self):
        self.usage = {"status": "ERROR", "response": self.SECRET_TEXT, "num_turns": 0}
        _exc, message = self.check_fails()
        self.assertEqual(message, "agy /usage failed")

    def test_inference_turns_are_refused(self):
        body = json.loads(json.dumps(OK))
        body["num_turns"] = 1
        self.usage = body
        self.check_fails()

    def test_not_a_usage_command_reply_is_refused(self):
        body = json.loads(json.dumps(OK))
        body["command"]["name"] = "something"
        self.usage = body
        self.check_fails()
        self.usage = {"status": "SUCCESS", "num_turns": 0, "response": self.SECRET_TEXT}
        self.check_fails()

    def test_bad_json_and_nonzero_exit(self):
        self.usage = self.SECRET_TEXT
        self.check_fails()
        self.usage = "[]"
        self.check_fails()
        self.usage = OK

        def fail(argv, **kwargs):
            if argv[1:] == ["--version"]:
                return subprocess.CompletedProcess(argv, 0, "1.5.10", "")
            return subprocess.CompletedProcess(argv, 1, self.SECRET_TEXT, self.SECRET_TEXT)

        API.subprocess.run = fail
        self.check_fails()

    def test_timeout_is_reported_as_timeout(self):
        def slow(argv, **kwargs):
            if argv[1:] == ["--version"]:
                return subprocess.CompletedProcess(argv, 0, "1.5.10", "")
            raise subprocess.TimeoutExpired(argv, kwargs["timeout"], output=self.SECRET_TEXT)

        API.subprocess.run = slow
        _exc, message = self.check_fails()
        self.assertEqual(message, "timeout")

    def test_no_windows_is_an_error(self):
        body = json.loads(json.dumps(OK))
        body["command"]["data"]["groups"] = []
        self.usage = body
        self.check_fails()


class BinaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self._saved = (API.HOME, API.shutil.which, API._IS_WINDOWS)
        self.addCleanup(self._restore)
        API.HOME = self.home
        API.shutil.which = lambda name: None

    def _restore(self):
        API.HOME, API.shutil.which, API._IS_WINDOWS = self._saved

    def install(self, mode=0o755):
        path = self.home / ".local" / "bin" / "agy"
        path.parent.mkdir(parents=True)
        path.write_text("#!/bin/sh\n", encoding="utf-8")
        path.chmod(mode)
        return str(path)

    def test_path_wins(self):
        API.shutil.which = lambda name: "/usr/bin/agy"
        self.assertEqual(API._agy_binary(), "/usr/bin/agy")

    def test_official_user_install_is_the_unix_fallback(self):
        path = self.install()
        self.assertEqual(API._agy_binary(), path)

    def test_fallback_needs_an_executable_file(self):
        self.install(mode=0o644)
        self.assertIsNone(API._agy_binary())

    def test_nothing_found(self):
        self.assertIsNone(API._agy_binary())

    def test_windows_never_picks_a_cmd_or_bat_wrapper(self):
        API._IS_WINDOWS = True
        asked = []
        API.shutil.which = lambda name: asked.append(name) or "C:/x/agy.cmd"
        self.assertIsNone(API._agy_binary())
        API.shutil.which = lambda name: "C:/x/agy.exe"
        self.assertEqual(API._agy_binary(), "C:/x/agy.exe")
        self.assertEqual(asked, ["agy.exe"])
        self.install()
        API.shutil.which = lambda name: None
        self.assertIsNone(API._agy_binary(), "no unix fallback on Windows")


if __name__ == "__main__":
    unittest.main()
