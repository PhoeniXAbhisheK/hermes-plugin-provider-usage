"""Tests for the row history field: keys, bucketing and the payload."""

import copy
import stat
import tempfile
import time
import unittest
from pathlib import Path

from tests import test_fixture_cases as base
from tests import test_schema as schema

API = base.API


class HistoryKeyTest(unittest.TestCase):
    def keyed(self, kind, row):
        p = {"windows": [], "money": []}
        p["windows" if kind == "window" else "money"].append(row)
        API._assign_keys(p)
        return API._history_key("zai", row)

    def test_key_cases(self):
        cases = (
            ("window", {"label": "Session (5h)", "percent": 10.0}, ("zai", "session_5h")),
            ("money", {"label": "Key cap", "cur": "USD"}, ("zai", "money:key_cap:usd")),
            ("window", {}, ("zai", "row")),
            ("money", {}, ("zai", "money:row")),
        )
        for kind, row, expected in cases:
            with self.subTest(kind=kind, row=row):
                self.assertEqual(self.keyed(kind, row), expected)


class HistoryStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "history.json"
        self.saved = {
            "path": API._history_path,
            "history": copy.deepcopy(API._history),
            "meta": copy.deepcopy(API._history_meta),
            "loaded": API._HISTORY_LOADED,
            "dirty": API._HISTORY_DIRTY,
            "written": API._HISTORY_WRITTEN_AT,
        }
        self.addCleanup(self.restore)
        self.addCleanup(self.tmp.cleanup)
        API._history_path = lambda: self.path
        API._history.clear()
        API._history_meta.clear()
        API._HISTORY_LOADED = False
        API._HISTORY_DIRTY = False
        API._HISTORY_WRITTEN_AT = 0.0

    def restore(self):
        API._history_path = self.saved["path"]
        API._history.clear()
        API._history.update(self.saved["history"])
        API._history_meta.clear()
        API._history_meta.update(self.saved["meta"])
        API._HISTORY_LOADED = self.saved["loaded"]
        API._HISTORY_DIRTY = self.saved["dirty"]
        API._HISTORY_WRITTEN_AT = self.saved["written"]

    @staticmethod
    def record(key, value, when, reset, duration):
        API._record(
            key, value, when, resets_at=API._iso_from_epoch(reset), duration_seconds=duration
        )

    def test_round_trip_keeps_samples_and_meta(self):
        now = time.time()
        key = ("zai", "5h")
        samples = [[now - 120, 10.0], [now, 20.0]]
        meta = {
            "resets_at": API._iso_from_epoch(now + 4 * 3600),
            "duration_seconds": 18000.0,
        }
        API._history[key] = copy.deepcopy(samples)
        API._history_meta[key] = meta
        API._HISTORY_DIRTY = True
        self.assertTrue(API._save_history(now, force=True))
        API._history.clear()
        API._history_meta.clear()
        API._HISTORY_LOADED = False
        API._ensure_history_loaded()
        self.assertEqual(API._history[key], samples)
        self.assertEqual(API._history_meta[key], meta)

    def test_corrupt_file_is_empty_and_does_not_raise(self):
        self.path.write_text("{not json", encoding="utf-8")
        API._ensure_history_loaded()
        self.assertEqual(API._history, {})

    def test_atomic_write_leaves_one_private_file(self):
        now = time.time()
        API._history[("zai", "5h")] = [[now, 10.0]]
        API._HISTORY_DIRTY = True
        self.assertTrue(API._save_history(now, force=True))
        self.assertEqual([entry.name for entry in self.path.parent.iterdir()], ["history.json"])
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)

    def test_spacing_follows_the_window_length(self):
        now = time.time()
        short = now + 4 * 3600
        long = now + 20 * 86400
        for offset in (0, 60, 120):
            self.record(("zai", "5h"), 10.0 + offset / 60, now + offset, short, 18000)
        self.assertEqual(len(API._history[("zai", "5h")]), 3)
        for offset in (0, 60, 4320):
            self.record(("zai", "monthly"), 10.0 + offset / 60, now + offset, long, 2592000)
        self.assertEqual(len(API._history[("zai", "monthly")]), 2)

    def test_new_cycle_rules(self):
        now = time.time()
        key = ("zai", "5h")
        reset = now + 3600
        self.record(key, 10.0, now, reset, 18000)
        self.record(key, 20.0, now + 60, reset, 18000)
        self.record(key, 5.0, now + 120, reset, 18000)
        self.assertEqual(len(API._history[key]), 1)
        self.assertEqual(API._history[key][0][1], 5.0)
        self.record(key, 6.0, now + 180, reset, 18000)
        self.record(key, 7.0, now + 239, reset + 5, 18000)
        self.assertEqual(len(API._history[key]), 2)
        self.record(key, 8.0, now + 3600, now + 21600, 18000)
        self.assertEqual(len(API._history[key]), 1)
        self.assertEqual(API._history[key][0][1], 8.0)

    def test_prune_uses_the_current_window_start(self):
        now = time.time()
        key = ("zai", "5h")
        API._history[key] = [[now - 5 * 3600, 1.0], [now - 3600, 2.0]]
        API._history_meta[key] = {
            "resets_at": API._iso_from_epoch(now + 3600),
            "duration_seconds": 18000,
        }
        API._prune_history(now)
        self.assertEqual(API._history[key], [[now - 3600, 2.0]])

    def test_downsampling_keeps_the_newest_point(self):
        now = time.time()
        reset = now + 20 * 86400
        start = reset - 30 * 86400
        key = ("zai", "monthly")
        API._history[key] = [[start + i * (now - start) / 300, float(i)] for i in range(301)]
        row = {
            "key": "monthly",
            "resets_at": API._iso_from_epoch(reset),
            "duration_seconds": 2592000,
        }
        history = API._row_history("zai", row, now)
        self.assertLessEqual(len(history), API._HISTORY_PANEL_POINTS)
        self.assertEqual(history[-1], [int(now), 300.0])


class HistoryFieldTest(schema.Base):
    NOW = 1_000_000.0

    def window_payload(self, label="5h", percent=50.0):
        p = {
            "id": "zai",
            "windows": [{"label": label, "percent": percent, "resets_at": None, "status": "ok"}],
        }
        API._assign_keys(p)
        return p

    def test_legacy_history_keeps_36_points(self):
        API._history[("zai", "5h")] = [[self.NOW - 7 * 3600, 1.0]] + [
            [self.NOW - (360 - i) * 60, float(i)] for i in range(361)
        ]
        p = self.window_payload()
        API._contract_rows(p, self.NOW)
        history = p["windows"][0]["history"]
        self.assertEqual(len(history), 36)
        self.assertEqual(history[-1], [int(self.NOW), 360.0])

    def test_bools_and_nan_money_are_not_history_samples(self):
        for total, left in ((True, 0.0), (100.0, float("nan")), (float("nan"), 0.0)):
            with self.subTest(total=total, left=left):
                API._history.clear()
                p = {
                    "id": "zai",
                    "money": [{"label": "Balance", "total": total, "left": left, "cur": "USD"}],
                }
                API._assign_keys(p)
                API._decorate("zai", p, self.NOW)
                self.assertEqual(API._history, {})

    def test_a_stale_provider_keeps_history_without_adding_a_sample(self):
        now = time.time()
        API._history[("zai", "5h")] = [[now - 120, 42.0]]
        API._last_good["zai"] = self.window_payload(percent=42.0)
        API._holds["zai"] = now + 300
        before = copy.deepcopy(API._history)
        payload = self.collect(("zai",))
        provider = payload["providers"][0]
        self.assertTrue(provider["stale"])
        self.assertEqual(provider["windows"][0]["history"], [[int(now - 120), 42.0]])
        self.assertEqual(API._history, before)

    def test_a_full_collection_validates_with_history(self):
        payload = schema.seed_fresh_history(self)
        rows = {p["id"]: p for p in payload["providers"]}
        window = rows["zai"]["windows"][0]
        balance = next(m for m in rows["openrouter"]["money"] if m["label"] == "Balance")
        self.assertIn("history", window)
        self.assertIn("history", balance)
        schema.validate(payload)


if __name__ == "__main__":
    unittest.main()
