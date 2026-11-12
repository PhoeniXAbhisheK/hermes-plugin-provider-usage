"""Projection tests for _record and _project.

The clock is always passed in explicitly and history is seeded per test, so
nothing here depends on the wall clock or on a history file. Every case from the
plan is exercised from both sides where a boundary exists.
"""

import importlib.util
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


class ProjectionTest(unittest.TestCase):
    def setUp(self):
        API._history.clear()
        API._holds.clear()
        API._last_good.clear()
        self._t0 = 1_800_000_000.0

    def tearDown(self):
        API._history.clear()
        API._holds.clear()
        API._last_good.clear()

    def seed(self, key, samples):
        API._history[key] = [[float(t), float(v)] for t, v in samples]

    def test_reset_clears_history(self):
        key = ("zai", "5h")
        API._record(key, 10.0, self._t0)
        API._record(key, 20.0, self._t0 + 900)
        API._record(key, 30.0, self._t0 + 1800)
        self.assertIsNotNone(API._project(key, 30.0, 100.0, self._t0 + 1800))
        API._record(key, 5.0, self._t0 + 1860)  # the window reset
        self.assertEqual(len(API._history[key]), 1)
        self.assertIsNone(API._project(key, 5.0, 100.0, self._t0 + 1860))

    def test_thirty_minute_span_boundary(self):
        key = ("zai", "5h")
        self.seed(key, [(self._t0, 0.0), (self._t0 + 1799, 30.0)])
        self.assertIsNone(API._project(key, 30.0, 100.0, self._t0 + 1799))
        self.seed(key, [(self._t0, 0.0), (self._t0 + 1801, 30.0)])
        eta = API._project(key, 30.0, 100.0, self._t0 + 1801)
        self.assertIsNotNone(eta)
        self.assertGreater(eta, 0)

    def test_project_handles_flat_negative_and_target(self):
        key = ("zai", "5h")
        cases = (
            ("flat", [(self._t0, 50.0), (self._t0 + 1800, 50.0)], 50.0, None),
            # _record would clear on a drop; _project is the unit under test here.
            ("negative", [(self._t0, 50.0), (self._t0 + 1800, 40.0)], 40.0, None),
            ("at target", [(self._t0, 0.0), (self._t0 + 1800, 50.0)], 100.0, 0),
            ("past target", [(self._t0, 0.0), (self._t0 + 1800, 50.0)], 120.0, 0),
        )
        for label, samples, current, expected in cases:
            with self.subTest(label=label):
                self.seed(key, samples)
                self.assertEqual(
                    API._project(key, current, 100.0, self._t0 + 1800),
                    expected,
                )

    def test_sixty_day_cap_boundary(self):
        key = ("zai", "5h")
        cap = 60 * 86400
        span = 1800.0
        # eta = (target - d) * span / d, so d = target * span / (eta + span).
        inside = 180000.0 / (cap - 60 + span)
        outside = 180000.0 / (cap + 60 + span)
        self.seed(key, [(self._t0, 0.0), (self._t0 + span, inside)])
        self.assertEqual(API._project(key, inside, 100.0, self._t0 + span), round(cap - 60))
        self.seed(key, [(self._t0, 0.0), (self._t0 + span, outside)])
        self.assertIsNone(API._project(key, outside, 100.0, self._t0 + span))

    def test_project_uses_only_the_window(self):
        key = ("zai", "5h")
        now = self._t0
        # One sample 7 hours back would halve the rate; the 6-hour window excludes it.
        self.seed(
            key,
            [
                (now - 7 * 3600, 0.0),
                (now - 1800, 10.0),
                (now - 900, 15.0),
                (now, 20.0),
            ],
        )
        self.assertEqual(API._project(key, 20.0, 100.0, now), 14400)

    def test_decorate_projects_to_full_percent(self):
        key = ("zai", "5h")
        self.seed(key, [(self._t0 - 3600, 0.0), (self._t0 - 1800, 10.0)])
        row = {"label": "5h", "percent": 20.0}
        payload = {"id": "zai", "status": "ok", "windows": [row]}
        API._assign_keys(payload)
        API._decorate("zai", payload, self._t0)
        self.assertEqual(row["eta_seconds"], 14400)

    def test_long_windows_skip_the_trailing_rate(self):
        now = self._t0
        low = [(now - 6 * 3600, 0.0), (now - 1800, 2.5)]
        high = [(now - 6 * 3600, 0.0), (now - 1800, 75.0)]
        cases = (
            ("5h high", 18000, now + 4 * 3600, 80.0, high, True, True),
            ("5h low", 18000, now + 4 * 3600, 3.0, low, True, False),
            ("Monthly", 2592000, now + 20 * 86400, 3.0, low, False, False),
            ("Monthly reset", None, now + 20 * 86400, 3.0, low, False, False),
        )
        for label, duration, reset, percent, samples, has_eta, actionable in cases:
            with self.subTest(label=label):
                API._history.clear()
                row = {
                    "label": label,
                    "percent": percent,
                    "resets_at": API._iso_from_epoch(reset),
                }
                if duration is not None:
                    row["duration_seconds"] = duration
                payload = {"id": "zai", "status": "ok", "windows": [row]}
                API._assign_keys(payload)
                self.seed(API._history_key("zai", row), samples)
                API._decorate("zai", payload, now)
                API._contract_rows(payload, now)
                self.assertEqual("eta_seconds" in row, has_eta)
                self.assertEqual(row["actionable_eta"] is not None, actionable)
                self.assertIn("history", row)

    def test_money_depletion_time(self):
        key = ("deepseek", "money:balance:usd")
        self.seed(key, [(self._t0, 0.0), (self._t0 + 1800, 10.0)])
        row = {"label": "Balance", "left": 90.0, "total": 100.0, "cur": "USD"}
        payload = {"id": "deepseek", "status": "ok", "money": [row]}
        API._assign_keys(payload)
        API._decorate("deepseek", payload, self._t0 + 1800)
        self.assertEqual(row["depletes_in_seconds"], 16200)

    def test_stale_rows_do_not_feed_history(self):
        API._last_good["zai"] = {
            "id": "zai",
            "status": "ok",
            "windows": [{"label": "5h", "percent": 55.0}],
        }
        API._holds["zai"] = time.time() + 120
        out = API._collect()
        row = {p["id"]: p for p in out["providers"]}["zai"]
        self.assertTrue(row.get("stale"))
        self.assertFalse(any(key[0] == "zai" for key in API._history))

    def test_a_fresh_row_does_feed_history(self):
        row = {"label": "5h", "percent": 12.0}
        payload = {"id": "zai", "status": "ok", "windows": [row]}
        API._assign_keys(payload)
        API._decorate("zai", payload, self._t0)
        self.assertIn(("zai", "5h"), API._history)
        self.assertEqual(API._history[("zai", "5h")][0][1], 12.0)


if __name__ == "__main__":
    unittest.main()
