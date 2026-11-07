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
    def test_plain_line(self):
        self.assertEqual(API._env_line_value("NAME=abc", "NAME"), "abc")

    def test_export_with_a_space(self):
        self.assertEqual(API._env_line_value("export NAME=abc", "NAME"), "abc")

    def test_export_with_a_tab(self):
        self.assertEqual(API._env_line_value("export\tNAME=abc", "NAME"), "abc")

    def test_export_needs_a_separator(self):
        self.assertIsNone(API._env_line_value("exportNAME=abc", "NAME"))

    def test_spaces_and_tabs_around_equals(self):
        self.assertEqual(API._env_line_value("NAME \t= \tabc", "NAME"), "abc")

    def test_double_quotes(self):
        self.assertEqual(API._env_line_value('NAME="abc"', "NAME"), "abc")

    def test_single_quotes(self):
        self.assertEqual(API._env_line_value("NAME='abc'", "NAME"), "abc")

    def test_hash_inside_quotes_is_kept(self):
        self.assertEqual(API._env_line_value('NAME="a # b"', "NAME"), "a # b")

    def test_text_after_a_closing_quote_is_ignored(self):
        self.assertEqual(API._env_line_value('NAME="abc"tail', "NAME"), "abc")

    def test_inline_comment_after_a_space(self):
        self.assertEqual(API._env_line_value("NAME=abc # note", "NAME"), "abc")

    def test_inline_comment_after_a_tab(self):
        self.assertEqual(API._env_line_value("NAME=abc\t# note", "NAME"), "abc")

    def test_hash_without_a_space_is_kept(self):
        self.assertEqual(API._env_line_value("NAME=ab#cd", "NAME"), "ab#cd")
        self.assertEqual(API._env_line_value("NAME=#abc", "NAME"), "#abc")

    def test_a_hash_with_a_leading_space_is_a_comment(self):
        self.assertEqual(API._env_line_value("NAME= #abc", "NAME"), "")

    def test_a_bare_export_line_gives_none(self):
        self.assertIsNone(API._env_line_value("export", "NAME"))
        self.assertIsNone(API._env_line_value("export\n", "NAME"))

    def test_an_indented_export_line_is_read(self):
        self.assertEqual(API._env_line_value("  export NAME=abc", "NAME"), "abc")

    def test_unmatched_quote_gives_the_text(self):
        self.assertEqual(API._env_line_value('NAME="abc', "NAME"), "abc")

    def test_a_commented_out_line_is_ignored(self):
        self.assertIsNone(API._env_line_value("# NAME=abc", "NAME"))

    def test_an_indented_line_is_read(self):
        self.assertEqual(API._env_line_value("   NAME=abc", "NAME"), "abc")

    def test_similar_names_do_not_match(self):
        self.assertIsNone(API._env_line_value("NAME2=abc", "NAME"))
        self.assertIsNone(API._env_line_value("XNAME=abc", "NAME"))

    def test_an_empty_value(self):
        self.assertEqual(API._env_line_value("NAME=", "NAME"), "")
        self.assertEqual(API._env_line_value("NAME= # note", "NAME"), "")

    def test_a_crlf_line(self):
        self.assertEqual(API._env_line_value("NAME=abc\r\n", "NAME"), "abc")

    def test_a_line_without_equals(self):
        self.assertIsNone(API._env_line_value("NAME", "NAME"))


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

    def test_first_match_wins(self):
        self.path.write_text("NAME=first\nNAME=second\n", encoding="utf-8")
        self.install_home()
        self.assertEqual(API._hermes_env_value("NAME"), "first")

    def test_an_empty_first_match_still_wins(self):
        self.path.write_text("NAME=\nNAME=second\n", encoding="utf-8")
        self.install_home()
        self.install_scope(None)
        self.assertEqual(API._hermes_env_value("NAME"), "")
        self.assertIsNone(API._secret("NAME"))

    def test_a_bare_export_line_does_not_stop_the_file(self):
        self.path.write_text("export\nNAME=abc\n", encoding="utf-8")
        self.install_home()
        self.assertEqual(API._hermes_env_value("NAME"), "abc")

    def test_an_empty_value_is_no_credential(self):
        self.path.write_text("NAME=\n", encoding="utf-8")
        self.install_home()
        self.install_scope(None)
        self.assertIsNone(API._secret("NAME"))

    def test_secret_reads_an_exported_quoted_line(self):
        self.path.write_text('export DEEPSEEK_API_KEY = "abc" # note\n', encoding="utf-8")
        self.install_home()
        self.install_scope(None)
        self.assertEqual(API._secret("DEEPSEEK_API_KEY"), "abc")

    def test_secret_scope_wins_over_the_file(self):
        self.path.write_text("DEEPSEEK_API_KEY=from-file\n", encoding="utf-8")
        self.install_home()
        self.install_scope("from-scope")
        self.assertEqual(API._secret("DEEPSEEK_API_KEY"), "from-scope")

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

    def test_an_old_key_is_deleted(self):
        now = 1_000_000.0
        API._history[("zai", "old")] = [[now - API._HISTORY_MAX_AGE - 1, 5.0]]
        API._prune_history(now)
        self.assertNotIn(("zai", "old"), API._history)

    def test_a_fresh_key_keeps_every_sample(self):
        now = 1_000_000.0
        samples = [[now - 3000, 5.0], [now - 1000, 6.0]]
        API._history[("zai", "5h")] = copy.deepcopy(samples)
        API._prune_history(now)
        self.assertEqual(API._history[("zai", "5h")], samples)

    def test_the_age_boundary(self):
        now = 1_000_000.0
        API._history[("a", "at")] = [[now - API._HISTORY_MAX_AGE, 1.0]]
        API._history[("b", "past")] = [[now - API._HISTORY_MAX_AGE - 1, 1.0]]
        API._prune_history(now)
        self.assertIn(("a", "at"), API._history)
        self.assertNotIn(("b", "past"), API._history)

    def test_a_fresh_newest_sample_keeps_the_key(self):
        now = 1_000_000.0
        samples = [[now - API._HISTORY_MAX_AGE - 100, 1.0], [now - 10, 2.0]]
        API._history[("zai", "mixed")] = copy.deepcopy(samples)
        API._prune_history(now)
        self.assertEqual(API._history[("zai", "mixed")], samples)

    def test_an_empty_key_is_deleted(self):
        API._history[("zai", "empty")] = []
        API._prune_history(1_000_000.0)
        self.assertNotIn(("zai", "empty"), API._history)

    def test_several_keys_at_once(self):
        now = 1_000_000.0
        API._history[("a", "old")] = [[now - API._HISTORY_MAX_AGE - 5, 1.0]]
        API._history[("b", "old")] = [[now - API._HISTORY_MAX_AGE - 9, 1.0]]
        API._history[("c", "fresh")] = [[now - 10, 1.0]]
        API._prune_history(now)
        self.assertEqual(list(API._history), [("c", "fresh")])


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
