"""Tests for the row history field: keys, bucketing and the payload."""

import copy
import time
import unittest

from tests import test_fixture_cases as base
from tests import test_schema as schema

API = base.API


class HistoryKeyTest(unittest.TestCase):
    def keyed(self, kind, row):
        p = {"windows": [], "money": []}
        p["windows" if kind == "window" else "money"].append(row)
        API._assign_keys(p)
        return API._history_key("zai", kind, row)

    def test_a_window_key(self):
        self.assertEqual(
            self.keyed("window", {"label": "Session (5h)", "percent": 10.0}), ("zai", "session_5h")
        )

    def test_a_money_key(self):
        self.assertEqual(
            self.keyed("money", {"label": "Key cap", "cur": "USD"}),
            ("zai", "money:key_cap:usd"),
        )

    def test_missing_label_and_currency(self):
        self.assertEqual(self.keyed("window", {}), ("zai", "row"))
        self.assertEqual(self.keyed("money", {}), ("zai", "money:row"))


class HistoryFieldTest(schema.Base):
    NOW = 1_000_000.0

    def window_payload(self, label="5h", percent=50.0):
        p = {
            "id": "zai",
            "windows": [{"label": label, "percent": percent, "resets_at": None, "status": "ok"}],
        }
        API._assign_keys(p)
        return p

    def test_pairs_oldest_first_and_rounded(self):
        API._history[("zai", "5h")] = [
            [self.NOW - 1200, 10.111],
            [self.NOW - 60, 12.349],
        ]
        p = self.window_payload()
        API._contract_rows(p, self.NOW)
        self.assertEqual(
            p["windows"][0]["history"],
            [[int(self.NOW - 1200), 10.11], [int(self.NOW - 60), 12.35]],
        )

    def test_samples_past_the_window_are_left_out(self):
        API._history[("zai", "5h")] = [
            [self.NOW - API._HISTORY_WINDOW - 600, 1.0],
            [self.NOW - API._HISTORY_WINDOW, 2.0],
        ]
        p = self.window_payload()
        API._contract_rows(p, self.NOW)
        self.assertEqual(
            p["windows"][0]["history"],
            [[int(self.NOW - API._HISTORY_WINDOW), 2.0]],
        )

    def test_one_point_per_bucket(self):
        samples = [[self.NOW - (99 - i) * 60, float(i)] for i in range(100)]
        API._history[("zai", "5h")] = samples
        p = self.window_payload()
        API._contract_rows(p, self.NOW)
        expected = {}
        for t, v in samples:
            expected[int(t // 600)] = [int(t), round(v, 2)]
        buckets = sorted(expected)
        self.assertEqual(p["windows"][0]["history"], [expected[b] for b in buckets])

    def test_six_hours_give_at_most_36_points(self):
        samples = [[self.NOW - (360 - i) * 60, float(i)] for i in range(361)]
        API._history[("zai", "5h")] = samples
        p = self.window_payload()
        API._contract_rows(p, self.NOW)
        history = p["windows"][0]["history"]
        self.assertEqual(len(history), 36)
        self.assertEqual(history[-1], [int(self.NOW), 360.0])

    def test_two_samples_in_one_bucket_keep_the_later(self):
        API._history[("zai", "5h")] = [
            [self.NOW - 60, 1.0],
            [self.NOW - 30, 2.0],
        ]
        p = self.window_payload()
        API._contract_rows(p, self.NOW)
        self.assertEqual(p["windows"][0]["history"], [[int(self.NOW - 30), 2.0]])

    def test_no_samples_means_no_history(self):
        p = self.window_payload(label="nothing")
        API._contract_rows(p, self.NOW)
        self.assertNotIn("history", p["windows"][0])

    def test_a_money_row_without_a_total_has_no_history(self):
        p = {"id": "zai", "money": [{"label": "Balance", "left": 5.0, "cur": "USD"}]}
        API._assign_keys(p)
        API._contract_rows(p, self.NOW)
        self.assertNotIn("history", p["money"][0])

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

    def test_projections_are_unchanged(self):
        API._history[("zai", "5h")] = [
            [self.NOW - 2400, 40.0],
            [self.NOW - 300, 55.0],
        ]
        p = self.window_payload(percent=60.0)
        API._decorate("zai", p, self.NOW)
        self.assertEqual(p["windows"][0]["eta_seconds"], 4800)
        API._contract_rows(p, self.NOW)
        self.assertEqual(p["windows"][0]["eta_seconds"], 4800)
        self.assertIn("history", p["windows"][0])


if __name__ == "__main__":
    unittest.main()
