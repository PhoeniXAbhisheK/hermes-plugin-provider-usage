"""Tests for provider-driven window labels, scope, durations and keys."""

import unittest
from types import SimpleNamespace

from tests import test_fixture_cases as base

API = base.API

FIVE_HOURS = 5 * 3600
WEEK = 7 * 86400
MONTH = 30 * 86400


class WindowHelperTest(unittest.TestCase):
    def test_known_durations_take_the_shared_labels(self):
        for seconds, label, key in (
            (FIVE_HOURS, "5h", "5h"),
            (WEEK, "Weekly", "weekly"),
            (MONTH, "Monthly", "monthly"),
        ):
            with self.subTest(seconds=seconds):
                row = API._window("own name", 10.0, None, duration=seconds)
                self.assertEqual((row["label"], row["key"]), (label, key))
                self.assertEqual(row["duration_seconds"], seconds)
                self.assertEqual(row["scope"], "account")

    def test_ten_percent_edges(self):
        for seconds, key in (
            (16200, "5h"),
            (16199, None),
            (19800, "5h"),
            (19801, None),
            (544320, "weekly"),
            (544319, None),
            (665280, "weekly"),
            (665281, None),
            (2332800, "monthly"),
            (2332799, None),
            (2851200, "monthly"),
            (2851201, None),
        ):
            with self.subTest(seconds=seconds):
                row = API._window("own name", 10.0, None, duration=seconds)
                if key is None:
                    self.assertEqual(row["label"], "own name")
                    self.assertEqual(row["key"], "%ds" % seconds)
                else:
                    self.assertEqual(row["key"], key)

    def test_an_unmatched_duration_keeps_the_label(self):
        row = API._window("Burst", 10.0, None, duration=7200)
        self.assertEqual(row["label"], "Burst")
        self.assertEqual(row["key"], "7200s")
        self.assertEqual(row["duration_seconds"], 7200)

    def test_a_model_row_keeps_its_label_and_keys_on_the_model(self):
        row = API._window("Opus", 10.0, None, duration=WEEK, scope="model", model="opus")
        self.assertEqual((row["label"], row["key"]), ("Opus", "opus:weekly"))
        self.assertEqual(row["scope"], "model")
        self.assertEqual(row["duration_seconds"], WEEK)

    def test_a_model_row_without_a_known_duration_has_no_suffix(self):
        row = API._window("Opus", 10.0, None, duration=7200, scope="model", model="opus")
        self.assertEqual((row["label"], row["key"]), ("Opus", "opus"))
        self.assertEqual(row["duration_seconds"], 7200)

    def test_a_model_row_without_a_duration_still_keys_on_the_model(self):
        row = API._window("Opus", 10.0, None, scope="model", model="opus")
        self.assertEqual(row["key"], "opus")
        self.assertNotIn("duration_seconds", row)

    def test_a_missing_model_uses_the_label_for_the_key(self):
        row = API._window("Sonnet", 10.0, None, duration=WEEK, scope="model")
        self.assertEqual(row["key"], "sonnet:weekly")

    def test_no_duration_leaves_the_key_to_the_contract_pass(self):
        row = API._window("Session (5h)", 10.0, None)
        self.assertNotIn("duration_seconds", row)
        self.assertNotIn("key", row)
        self.assertEqual(row["label"], "Session (5h)")
        self.assertEqual(row["scope"], "account")

    def test_an_unusable_percent_is_still_none(self):
        self.assertIsNone(API._window("a", None, None, duration=WEEK))

    def test_bools_and_nan_are_not_durations(self):
        for value in (True, False, float("nan"), float("inf")):
            with self.subTest(value=value):
                row = API._window("own name", 10.0, None, duration=value)
                self.assertNotIn("duration_seconds", row)
                self.assertNotIn("key", row)


class FetcherCase(unittest.TestCase):
    def setUp(self):
        self.saved = {
            name: getattr(API, name)
            for name in ("_secret", "_http_json", "_read_text", "_hermes_usage")
        }
        API._HOST_WINNERS.clear()
        self.addCleanup(self.restore)

    def restore(self):
        for name, value in self.saved.items():
            setattr(API, name, value)
        API._HOST_WINNERS.clear()

    def serve(self, body):
        API._http_json = lambda url, headers, **kwargs: body

    def key(self, value="sentinel"):
        API._secret = lambda *names: value


class ProviderWindowTest(FetcherCase):
    def test_opencode_go_names_each_named_field(self):
        self.key()
        self.serve(
            {
                "usage": {
                    "rolling": {"percent": 12.0},
                    "weekly": {"percent": 34.0},
                    "monthly": {"percent": 56.0},
                }
            }
        )
        p = API.fetch_opencode_go()
        self.assertEqual([w["label"] for w in p["windows"]], ["5h", "Weekly", "Monthly"])
        self.assertEqual([w["duration_seconds"] for w in p["windows"]], [FIVE_HOURS, WEEK, MONTH])
        self.assertEqual([w["key"] for w in p["windows"]], ["5h", "weekly", "monthly"])

    def test_codex_reads_the_window_length_and_sets_the_plan_tag(self):
        API._read_text = lambda path: '{"tokens": {"access_token": "sentinel"}}'
        self.serve(
            {
                "rate_limit": {
                    "primary_window": {"used_percent": 10, "limit_window_seconds": WEEK},
                },
                "plan_type": "plus",
            }
        )
        p = API._codex_direct()
        self.assertEqual(p["plan"], "plus")
        self.assertEqual(p["tag"], "Plus")
        self.assertEqual(p["windows"][0]["label"], "Weekly")
        self.assertEqual(p["windows"][0]["duration_seconds"], WEEK)

    def test_codex_without_a_length_keeps_the_positional_labels(self):
        API._read_text = lambda path: '{"tokens": {"access_token": "sentinel"}}'
        self.serve(
            {
                "rate_limit": {
                    "primary_window": {"used_percent": 10},
                    "secondary_window": {"used_percent": 20},
                }
            }
        )
        p = API._codex_direct()
        self.assertEqual([w["label"] for w in p["windows"]], ["5h", "Weekly"])
        self.assertNotIn("duration_seconds", p["windows"][0])
        self.assertNotIn("key", p["windows"][0])
        self.assertNotIn("tag", p)

    def test_anthropic_marks_the_model_weekly_caps(self):
        API._read_text = lambda path: '{"claudeAiOauth": {"accessToken": "sentinel"}}'
        self.serve(
            {
                "five_hour": {"utilization": 10.0},
                "seven_day": {"utilization": 20.0},
                "seven_day_opus": {"utilization": 30.0},
                "seven_day_sonnet": {"utilization": 40.0},
            }
        )
        p = API._anthropic_direct()
        rows = p["windows"]
        self.assertEqual([w["label"] for w in rows], ["5h", "Weekly", "Opus", "Sonnet"])
        self.assertEqual([w["scope"] for w in rows], ["account", "account", "model", "model"])
        self.assertEqual(rows[2]["key"], "opus:weekly")
        self.assertEqual(rows[3]["key"], "sonnet:weekly")

    def test_kimi_labels_from_its_own_window(self):
        self.key()
        self.serve(
            {
                "limits": [
                    {
                        "window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
                        "detail": {"limit": "100", "used": "15"},
                    },
                    {
                        "window": {"duration": 3, "timeUnit": "TIME_UNIT_FORTNIGHT"},
                        "detail": {"limit": "10", "used": "4", "name": "Burst"},
                    },
                ]
            }
        )
        p = API.fetch_kimi()
        self.assertEqual([w["label"] for w in p["windows"]], ["5h", "Burst"])
        self.assertNotIn("duration_seconds", p["windows"][1])

    def test_minimax_marks_a_per_model_row(self):
        self.key()
        self.serve(
            {
                "model_remains": [
                    {
                        "model_name": "general",
                        "current_interval_remaining_percent": 90,
                    },
                    {
                        "model_name": "MiniMax-M2",
                        "current_interval_remaining_percent": 80,
                        "current_weekly_remaining_percent": 70,
                    },
                ]
            }
        )
        p = API.fetch_minimax()
        rows = {w["label"]: w for w in p["windows"]}
        self.assertEqual(rows["5h"]["scope"], "account")
        self.assertEqual(rows["5h"]["key"], "5h")
        self.assertEqual(rows["MiniMax-M2 · 5h"]["scope"], "model")
        self.assertEqual(rows["MiniMax-M2 · 5h"]["key"], "minimax_m2:5h")
        self.assertEqual(rows["MiniMax-M2 · Weekly"]["key"], "minimax_m2:weekly")

    def test_zai_keeps_its_own_label_and_scope(self):
        self.key()
        self.serve(
            {
                "data": {
                    "limits": [
                        {
                            "type": "CREDIT_LIMIT",
                            "unit": 6,
                            "number": 1,
                            "usage": 10000,
                            "currentValue": 2500,
                            "percentage": 25,
                        }
                    ]
                }
            }
        )
        p = API.fetch_zai()
        row = p["windows"][0]
        self.assertNotIn("duration_seconds", row)
        self.assertNotIn("key", row)
        self.assertEqual(row["scope"], "account")


class SnapshotLabelTest(unittest.TestCase):
    def snap(self, windows):
        return SimpleNamespace(
            available=True,
            windows=[SimpleNamespace(**window) for window in windows],
            fetched_at=None,
        )

    def test_anthropic_labels_and_scope(self):
        snap = self.snap(
            [
                {"label": "Current session", "used_percent": 10.0, "reset_at": None},
                {"label": "Current week", "used_percent": 20.0, "reset_at": None},
                {"label": "Opus week", "used_percent": 30.0, "reset_at": None, "scope": "model"},
                {"label": "Sonnet week", "used_percent": 40.0, "reset_at": None, "scope": "model"},
            ]
        )
        p = API._snap_payload("anthropic", snap)
        rows = p["windows"]
        self.assertEqual([w["label"] for w in rows], ["5h", "Weekly", "Opus", "Sonnet"])
        self.assertEqual([w["scope"] for w in rows], ["account", "account", "model", "model"])
        self.assertEqual([w["duration_seconds"] for w in rows], [FIVE_HOURS, WEEK, WEEK, WEEK])
        self.assertEqual([w["key"] for w in rows], ["5h", "weekly", "opus:weekly", "sonnet:weekly"])

    def test_codex_labels(self):
        snap = self.snap(
            [
                {"label": "Session", "used_percent": 10.0, "reset_at": None},
                {"label": "Weekly", "used_percent": 20.0, "reset_at": None},
            ]
        )
        p = API._snap_payload("openai-codex", snap)
        self.assertEqual([w["label"] for w in p["windows"]], ["5h", "Weekly"])
        self.assertEqual([w["key"] for w in p["windows"]], ["5h", "weekly"])

    def test_an_unknown_label_keeps_its_text(self):
        snap = self.snap([{"label": "Tool quota", "used_percent": 10.0, "reset_at": None}])
        p = API._snap_payload("anthropic", snap)
        row = p["windows"][0]
        self.assertEqual(row["label"], "Tool quota")
        self.assertEqual(row["scope"], "account")
        self.assertNotIn("duration_seconds", row)

    def test_an_unknown_label_keeps_the_snapshot_scope(self):
        snap = self.snap(
            [{"label": "Tool quota", "used_percent": 10.0, "reset_at": None, "scope": "model"}]
        )
        p = API._snap_payload("anthropic", snap)
        row = p["windows"][0]
        self.assertEqual(row["scope"], "model")
        self.assertEqual(row["label"], "Tool quota")
        self.assertNotIn("duration_seconds", row)

    def test_the_core_label_match_is_case_insensitive(self):
        snap = self.snap([{"label": "  weekly ", "used_percent": 10.0, "reset_at": None}])
        p = API._snap_payload("openai-codex", snap)
        self.assertEqual(p["windows"][0]["label"], "Weekly")


class PathParityTest(FetcherCase):
    def test_anthropic_names_the_same_window_on_both_paths(self):
        API._read_text = lambda path: '{"claudeAiOauth": {"accessToken": "sentinel"}}'
        self.serve({"five_hour": {"utilization": 10.0}})
        direct = API._anthropic_direct()["windows"][0]
        snap = SimpleNamespace(
            available=True,
            windows=[SimpleNamespace(label="Current session", used_percent=10.0, reset_at=None)],
            fetched_at=None,
        )
        from_snap = API._snap_payload("anthropic", snap)["windows"][0]
        for field in ("label", "key", "scope", "duration_seconds"):
            self.assertEqual(direct[field], from_snap[field], field)

    def test_codex_names_the_same_window_on_both_paths(self):
        API._read_text = lambda path: '{"tokens": {"access_token": "sentinel"}}'
        self.serve(
            {
                "rate_limit": {
                    "primary_window": {"used_percent": 5, "limit_window_seconds": FIVE_HOURS}
                }
            }
        )
        direct = API._codex_direct()["windows"][0]
        snap = SimpleNamespace(
            available=True,
            windows=[SimpleNamespace(label="Session", used_percent=5.0, reset_at=None)],
            fetched_at=None,
        )
        from_snap = API._snap_payload("openai-codex", snap)["windows"][0]
        for field in ("label", "key", "scope", "duration_seconds"):
            self.assertEqual(direct[field], from_snap[field], field)

    def test_history_written_on_one_path_is_used_by_the_other(self):
        now = 1_800_000_000.0
        API._read_text = lambda path: '{"claudeAiOauth": {"accessToken": "sentinel"}}'
        self.serve({"five_hour": {"utilization": 10.0}})
        direct = API._anthropic_direct()
        API._assign_keys(direct)
        API._decorate("anthropic", direct, now)
        snap = SimpleNamespace(
            available=True,
            windows=[SimpleNamespace(label="Current session", used_percent=30.0, reset_at=None)],
            fetched_at=None,
        )
        payload = API._snap_payload("anthropic", snap)
        API._assign_keys(payload)
        API._decorate("anthropic", payload, now + 1800)
        row = payload["windows"][0]
        self.assertIn("eta_seconds", row)
        self.assertEqual(len(API._history[("anthropic", "5h")]), 2)
        API._history.pop(("anthropic", "5h"), None)


class KeyOrderTest(unittest.TestCase):
    def test_keys_are_assigned_before_history_uses_them(self):
        p = {"id": "zai", "windows": [{"label": "Session (5h)", "percent": 50.0}]}
        API._assign_keys(p)
        row = p["windows"][0]
        self.assertEqual(row["key"], "session_5h")
        self.assertEqual(API._history_key("zai", row), ("zai", "session_5h"))

    def test_a_preset_key_is_kept_and_duplicates_get_a_suffix(self):
        p = {
            "id": "zai",
            "windows": [
                {"label": "a", "percent": 1.0, "key": "5h"},
                {"label": "b", "percent": 2.0, "key": "5h"},
            ],
        }
        API._assign_keys(p)
        self.assertEqual([row["key"] for row in p["windows"]], ["5h", "5h:2"])

    def test_decorate_records_under_the_assigned_key(self):
        API._history.clear()
        p = {"id": "zai", "windows": [{"label": "Session (5h)", "percent": 12.0}]}
        API._assign_keys(p)
        API._decorate("zai", p, 1_800_000_000.0)
        self.assertEqual(API._history[("zai", "session_5h")][0][1], 12.0)
        API._history.clear()


if __name__ == "__main__":
    unittest.main()
