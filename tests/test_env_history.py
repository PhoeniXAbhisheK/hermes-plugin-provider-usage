"""Tests for .env line parsing and burn-rate history pruning."""

import copy
import importlib.util
import sys
import tempfile
import time
import types
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


class EnvLineTest(unittest.TestCase):
    def test_env_line_parsing(self):
        cases = (
            ("NAME=abc", "abc"),
            ("export NAME=abc", "abc"),
            ("export\tNAME=abc", "abc"),
            ("exportNAME=abc", None),
            ("NAME \t= \tabc", "abc"),
            ('NAME="abc"', "abc"),
            ("NAME='abc'", "abc"),
            ('NAME="a # b"', "a # b"),
            ('NAME="abc"tail', "abc"),
            ("NAME=abc # note", "abc"),
            ("NAME=abc\t# note", "abc"),
            ("NAME=ab#cd", "ab#cd"),
            ("NAME=#abc", "#abc"),
            ("NAME= #abc", ""),
            ("export", None),
            ("export\n", None),
            ("  export NAME=abc", "abc"),
            ('NAME="abc', "abc"),
            ("# NAME=abc", None),
            ("   NAME=abc", "abc"),
            ("NAME2=abc", None),
            ("XNAME=abc", None),
            ("NAME=", ""),
            ("NAME= # note", ""),
            ("NAME=abc\r\n", "abc"),
            ("NAME", None),
        )
        for line, expected in cases:
            with self.subTest(line=line):
                self.assertEqual(API._env_line_value(line, "NAME"), expected)


class EnvFileTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.path = Path(self.home.name) / ".env"

    def install_home(self):
        module = types.ModuleType("hermes_constants")
        module.get_hermes_home = lambda: Path(self.home.name)
        saved = sys.modules.get("hermes_constants")
        sys.modules["hermes_constants"] = module
        self.addCleanup(self.restore_module, "hermes_constants", saved)

    def install_scope(self, value):
        agent = types.ModuleType("agent")
        agent.__path__ = []
        scope = types.ModuleType("agent.secret_scope")
        scope.get_secret = lambda name: value
        agent.secret_scope = scope
        saved = {name: sys.modules.get(name) for name in ("agent", "agent.secret_scope")}
        sys.modules.update({"agent": agent, "agent.secret_scope": scope})
        for name, module in saved.items():
            self.addCleanup(self.restore_module, name, module)

    @staticmethod
    def restore_module(name, module):
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module

    def test_file_and_secret_cases(self):
        cases = (
            ("first", "NAME=first\nNAME=second\n", False, False, "first"),
            ("bare export", "export\nNAME=abc\n", False, False, "abc"),
            ("empty first", "NAME=\nNAME=second\n", None, False, ""),
            ("empty first is no secret", "NAME=\nNAME=second\n", None, True, None),
            ("exported quoted", 'export DEEPSEEK_API_KEY = "abc" # note\n', None, True, "abc"),
            ("scope wins", "DEEPSEEK_API_KEY=from-file\n", "from-scope", True, "from-scope"),
            ("empty value is no secret", "NAME=\n", None, True, None),
        )
        for label, text, scope, secret, expected in cases:
            with self.subTest(label=label):
                self.path.write_text(text, encoding="utf-8")
                self.install_home()
                if scope is not False:
                    self.install_scope(scope)
                name = "DEEPSEEK_API_KEY" if "DEEPSEEK" in text else "NAME"
                value = API._secret(name) if secret else API._hermes_env_value(name)
                self.assertEqual(value, expected)

    def test_undecodable_bytes_are_tolerated(self):
        self.path.write_bytes(b"NAME=abc\xff\xfe\n")
        self.install_home()
        value = API._hermes_env_value("NAME")
        self.assertTrue(value.startswith("abc"))


class PruneTest(unittest.TestCase):
    def setUp(self):
        self.saved = copy.deepcopy(API._history)
        API._history.clear()
        self.addCleanup(self.restore)

    def restore(self):
        API._history.clear()
        API._history.update(self.saved)

    def test_prune_cases(self):
        now = 1_000_000.0
        cases = (
            ("old key", {("zai", "old"): [[now - API._HISTORY_MAX_AGE - 1, 5.0]]}, {}),
            (
                "fresh key",
                {("zai", "5h"): [[now - 3000, 5.0], [now - 1000, 6.0]]},
                {("zai", "5h"): [[now - 3000, 5.0], [now - 1000, 6.0]]},
            ),
            (
                "age boundary",
                {
                    ("a", "at"): [[now - API._HISTORY_MAX_AGE, 1.0]],
                    ("b", "past"): [[now - API._HISTORY_MAX_AGE - 1, 1.0]],
                },
                {("a", "at"): [[now - API._HISTORY_MAX_AGE, 1.0]]},
            ),
            (
                "old sample in a fresh key",
                {("zai", "mixed"): [[now - API._HISTORY_MAX_AGE - 100, 1.0], [now - 10, 2.0]]},
                {("zai", "mixed"): [[now - 10, 2.0]]},
            ),
            ("empty key", {("zai", "empty"): []}, {}),
            (
                "several keys",
                {
                    ("a", "old"): [[now - API._HISTORY_MAX_AGE - 5, 1.0]],
                    ("b", "old"): [[now - API._HISTORY_MAX_AGE - 9, 1.0]],
                    ("c", "fresh"): [[now - 10, 1.0]],
                },
                {("c", "fresh"): [[now - 10, 1.0]]},
            ),
        )
        for label, history, expected in cases:
            with self.subTest(label=label):
                API._history.clear()
                API._history.update(copy.deepcopy(history))
                API._prune_history(now)
                self.assertEqual(API._history, expected)


class CollectPruneTest(unittest.TestCase):
    def setUp(self):
        self.saved_history = copy.deepcopy(API._history)
        self.saved_fetchers = API.FETCHERS
        self.addCleanup(self.restore)
        API._history.clear()
        API._history[("zai", "old")] = [[time.time() - 90000, 5.0]]
        API._history[("zai", "5h")] = [[time.time() - 120, 5.0]]

        def fake(pid):
            def fetch():
                return {
                    "id": pid,
                    "status": "ok",
                    "windows": [{"label": "5h", "percent": 10.0}],
                }

            return fetch

        API.FETCHERS = {pid: fake(pid) for pid in API.FETCH_ORDER}

    def restore(self):
        API._history.clear()
        API._history.update(self.saved_history)
        API.FETCHERS = self.saved_fetchers

    def test_a_collection_prunes_old_keys_and_keeps_fresh_ones(self):
        API._collect()
        self.assertNotIn(("zai", "old"), API._history)
        self.assertIn(("zai", "5h"), API._history)
        self.assertEqual(len(API._history[("zai", "5h")]), 2)


if __name__ == "__main__":
    unittest.main()
