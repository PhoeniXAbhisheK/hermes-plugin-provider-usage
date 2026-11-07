"""Codex windows of unusual length: the reset outruns the label the core gives.

A free Codex account can return one primary window of 30 days. The core helper
labels any non-5h/non-weekly length by position ("Session"), so the plugin has
to let the reset decide the real length instead of trusting the map.
"""

import json
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from tests import test_fixture_cases as base

API = base.API

FIVE_HOURS = 5 * 3600
WEEK = 7 * 86400
MONTH = 30 * 86400


def snap(windows, plan=None, raw=None, fetched_at=None):
    return SimpleNamespace(
        available=True,
        windows=[
            SimpleNamespace(
                label=window["label"],
                used_percent=window.get("used_percent", 10.0),
                reset_at=window.get("reset_at"),
                scope=window.get("scope", "account"),
            )
            for window in windows
        ],
        fetched_at=fetched_at,
        plan=plan,
        raw=raw,
    )


def codex_raw(primary=None, secondary=None):
    """An invented Codex body with the two rate_limit windows."""
    return {
        "plan_type": "free",
        "rate_limit": {"primary_window": primary, "secondary_window": secondary},
    }


def in_seconds(seconds):
    return datetime.now(timezone.utc) + timedelta(seconds=seconds)


def _stamp(when):
    """The row's ISO form, floored to the minute like _iso_from_epoch."""
    epoch = when.timestamp()
    return datetime.fromtimestamp(epoch - epoch % 60.0, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


class SnapshotWindowFitTest(unittest.TestCase):
    def test_a_session_resetting_in_fourteen_days_becomes_monthly(self):
        p = API._snap_payload(
            "openai-codex",
            snap([{"label": "Session", "used_percent": 12.0, "reset_at": in_seconds(14 * 86400)}]),
        )
        row = p["windows"][0]
        self.assertEqual(row["label"], "Monthly")
        self.assertEqual(row["key"], "monthly")
        self.assertEqual(row["duration_seconds"], MONTH)

    def test_a_session_resetting_in_three_hours_stays_five_hours(self):
        p = API._snap_payload(
            "openai-codex",
            snap([{"label": "Session", "used_percent": 12.0, "reset_at": in_seconds(3 * 3600)}]),
        )
        row = p["windows"][0]
        self.assertEqual(row["label"], "5h")
        self.assertEqual(row["key"], "5h")
        self.assertEqual(row["duration_seconds"], FIVE_HOURS)

    def test_a_reset_beyond_every_known_length_keeps_the_core_label(self):
        p = API._snap_payload(
            "openai-codex",
            snap([{"label": "Session", "used_percent": 12.0, "reset_at": in_seconds(45 * 86400)}]),
        )
        row = p["windows"][0]
        self.assertEqual(row["label"], "Session")
        self.assertNotIn("duration_seconds", row)
        self.assertNotIn("key", row)

    def test_an_anthropic_week_resetting_in_five_days_stays_weekly(self):
        p = API._snap_payload(
            "anthropic",
            snap(
                [{"label": "Current week", "used_percent": 20.0, "reset_at": in_seconds(5 * 86400)}]
            ),
        )
        row = p["windows"][0]
        self.assertEqual(row["label"], "Weekly")
        self.assertEqual(row["key"], "weekly")
        self.assertEqual(row["duration_seconds"], WEEK)

    def test_a_model_row_keeps_its_model_key_when_the_length_moves(self):
        p = API._snap_payload(
            "anthropic",
            snap(
                [
                    {
                        "label": "Opus week",
                        "used_percent": 30.0,
                        "reset_at": in_seconds(20 * 86400),
                        "scope": "model",
                    }
                ]
            ),
        )
        row = p["windows"][0]
        self.assertEqual(row["scope"], "model")
        self.assertEqual(row["label"], "Opus")
        self.assertEqual(row["key"], "opus:monthly")
        self.assertEqual(row["duration_seconds"], MONTH)

    def test_a_session_just_past_five_hours_inside_the_tolerance_stays_five_hours(self):
        # 2% past the length is well inside the 10% tolerance.
        p = API._snap_payload(
            "openai-codex",
            snap(
                [
                    {
                        "label": "Session",
                        "used_percent": 12.0,
                        "reset_at": in_seconds(FIVE_HOURS + FIVE_HOURS * 0.02),
                    }
                ]
            ),
        )
        row = p["windows"][0]
        self.assertEqual(row["label"], "5h")
        self.assertEqual(row["duration_seconds"], FIVE_HOURS)

    def test_a_three_day_session_becomes_weekly_not_monthly(self):
        p = API._snap_payload(
            "openai-codex",
            snap([{"label": "Session", "used_percent": 12.0, "reset_at": in_seconds(3 * 86400)}]),
        )
        row = p["windows"][0]
        self.assertEqual(row["label"], "Weekly")
        self.assertEqual(row["key"], "weekly")
        self.assertEqual(row["duration_seconds"], WEEK)

    def test_a_session_just_past_a_week_inside_the_tolerance_stays_weekly(self):
        p = API._snap_payload(
            "openai-codex",
            snap(
                [
                    {
                        "label": "Session",
                        "used_percent": 12.0,
                        "reset_at": in_seconds(WEEK + WEEK * 0.02),
                    }
                ]
            ),
        )
        row = p["windows"][0]
        self.assertEqual(row["label"], "Weekly")
        self.assertEqual(row["duration_seconds"], WEEK)

    def test_a_naive_reset_fourteen_days_out_is_read_as_utc(self):
        naive = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=14)
        p = API._snap_payload(
            "openai-codex",
            snap([{"label": "Session", "used_percent": 12.0, "reset_at": naive}]),
        )
        row = p["windows"][0]
        self.assertEqual(row["label"], "Monthly")
        self.assertEqual(row["duration_seconds"], MONTH)


class RawCodexSnapshotTest(unittest.TestCase):
    """The snapshot's raw body wins: limit_window_seconds is the truth."""

    def test_a_raw_thirty_day_window_resetting_in_three_days_is_monthly(self):
        fetched = (datetime.now(timezone.utc) - timedelta(seconds=200)).replace(microsecond=0)
        p = API._snap_payload(
            "openai-codex",
            snap(
                [{"label": "Session", "used_percent": 12.0, "reset_at": in_seconds(3 * 86400)}],
                plan="Free",
                fetched_at=fetched,
                raw=codex_raw(
                    {
                        "limit_window_seconds": MONTH,
                        "reset_after_seconds": 3 * 86400,
                        "used_percent": 12,
                    }
                ),
            ),
        )
        row = p["windows"][0]
        self.assertEqual(row["label"], "Monthly")
        self.assertEqual(row["key"], "monthly")
        self.assertEqual(row["duration_seconds"], MONTH)
        self.assertEqual(row["resets_at"], _stamp(fetched + timedelta(seconds=3 * 86400)))
        self.assertEqual(p["tag"], "Free")

    def test_the_raw_path_counts_the_reset_from_the_snapshot_fetch_time(self):
        fetched = (datetime.now(timezone.utc) - timedelta(seconds=200)).replace(microsecond=0)
        p = API._snap_payload(
            "openai-codex",
            snap(
                [{"label": "Session", "used_percent": 12.0, "reset_at": in_seconds(7200)}],
                fetched_at=fetched,
                raw=codex_raw(
                    {
                        "limit_window_seconds": FIVE_HOURS,
                        "reset_after_seconds": 7200,
                        "used_percent": 12,
                    }
                ),
            ),
        )
        self.assertEqual(p["windows"][0]["resets_at"], _stamp(fetched + timedelta(seconds=7200)))

    def test_a_raw_thirty_day_window_resetting_in_two_hours_is_monthly(self):
        p = API._snap_payload(
            "openai-codex",
            snap(
                [{"label": "Session", "used_percent": 12.0, "reset_at": in_seconds(2 * 3600)}],
                raw=codex_raw(
                    {
                        "limit_window_seconds": MONTH,
                        "reset_after_seconds": 2 * 3600,
                        "used_percent": 12,
                    }
                ),
            ),
        )
        row = p["windows"][0]
        self.assertEqual(row["label"], "Monthly")
        self.assertEqual(row["key"], "monthly")
        self.assertEqual(row["duration_seconds"], MONTH)

    def test_raw_five_hour_and_week_windows_keep_their_lengths(self):
        p = API._snap_payload(
            "openai-codex",
            snap(
                [
                    {"label": "Session", "reset_at": in_seconds(3600)},
                    {"label": "Weekly", "reset_at": in_seconds(86400)},
                ],
                raw=codex_raw(
                    {
                        "limit_window_seconds": FIVE_HOURS,
                        "reset_after_seconds": 3600,
                        "used_percent": 12,
                    },
                    {
                        "limit_window_seconds": WEEK,
                        "reset_after_seconds": 86400,
                        "used_percent": 30,
                    },
                ),
            ),
        )
        rows = p["windows"]
        self.assertEqual([row["label"] for row in rows], ["5h", "Weekly"])
        self.assertEqual([row["key"] for row in rows], ["5h", "weekly"])
        self.assertEqual([row["duration_seconds"] for row in rows], [FIVE_HOURS, WEEK])

    def test_a_raw_body_without_rate_limit_falls_back_to_the_guess(self):
        p = API._snap_payload(
            "openai-codex",
            snap(
                [{"label": "Session", "used_percent": 12.0, "reset_at": in_seconds(3 * 86400)}],
                raw={"plan_type": "free"},
            ),
        )
        self.assertEqual(p["windows"][0]["label"], "Weekly")
        self.assertEqual(p["windows"][0]["duration_seconds"], WEEK)

    def test_a_raw_body_with_null_windows_falls_back_to_the_guess(self):
        p = API._snap_payload(
            "openai-codex",
            snap(
                [{"label": "Session", "used_percent": 12.0, "reset_at": in_seconds(3 * 86400)}],
                raw=codex_raw(),
            ),
        )
        self.assertEqual(p["windows"][0]["label"], "Weekly")
        self.assertEqual(p["windows"][0]["duration_seconds"], WEEK)

    def test_a_non_dict_rate_limit_falls_back_to_the_guess(self):
        for bad in ([{"limit_window_seconds": MONTH}], "not-a-mapping"):
            with self.subTest(rate_limit=repr(bad)):
                p = API._snap_payload(
                    "openai-codex",
                    snap(
                        [
                            {
                                "label": "Session",
                                "used_percent": 12.0,
                                "reset_at": in_seconds(3 * 86400),
                            }
                        ],
                        raw={"plan_type": "free", "rate_limit": bad},
                    ),
                )
                self.assertEqual(p["windows"][0]["label"], "Weekly")
                self.assertEqual(p["windows"][0]["duration_seconds"], WEEK)

    def test_a_non_codex_snapshot_ignores_a_codex_shaped_raw_body(self):
        p = API._snap_payload(
            "anthropic",
            snap(
                [
                    {
                        "label": "Current week",
                        "used_percent": 20.0,
                        "reset_at": in_seconds(5 * 86400),
                    }
                ],
                raw=codex_raw(
                    {
                        "limit_window_seconds": MONTH,
                        "reset_after_seconds": 3 * 86400,
                        "used_percent": 12,
                    }
                ),
            ),
        )
        row = p["windows"][0]
        self.assertEqual(row["label"], "Weekly")
        self.assertEqual(row["key"], "weekly")
        self.assertEqual(row["duration_seconds"], WEEK)


class SnapshotPlanTagTest(unittest.TestCase):
    def test_a_snapshot_plan_becomes_the_provider_tag(self):
        p = API._snap_payload(
            "openai-codex",
            snap([{"label": "Session", "reset_at": None}], plan="free"),
        )
        self.assertEqual(p["tag"], "Free")

    def test_no_snapshot_plan_keeps_the_default_tag(self):
        p = API._snap_payload("openai-codex", snap([{"label": "Session", "reset_at": None}]))
        self.assertNotIn("tag", p)


class DirectCodexLengthTest(unittest.TestCase):
    def setUp(self):
        self._read_text = API._read_text
        self._http_json = API._http_json
        API._read_text = lambda path: '{"tokens": {"access_token": "sentinel"}}'

    def tearDown(self):
        API._read_text = self._read_text
        API._http_json = self._http_json

    def serve(self, body):
        API._http_json = lambda url, headers, **kwargs: body

    def test_a_thirty_day_primary_window_is_monthly(self):
        API._http_json = lambda url, headers, **kwargs: json.loads(
            (base.FIXTURES / "codex" / "monthly_only.json").read_text(encoding="utf-8")
        )
        p = API._codex_direct()
        row = p["windows"][0]
        self.assertEqual(row["label"], "Monthly")
        self.assertEqual(row["key"], "monthly")
        self.assertEqual(row["duration_seconds"], MONTH)
        self.assertEqual(row["percent"], 12.0)
        self.assertEqual(p["tag"], "Free")

    def test_a_week_length_alone_names_the_primary_window_weekly(self):
        self.serve(
            {
                "rate_limit": {
                    "primary_window": {"used_percent": 10, "limit_window_seconds": WEEK},
                },
                "plan_type": "free",
            }
        )
        row = API._codex_direct()["windows"][0]
        self.assertEqual(row["label"], "Weekly")
        self.assertEqual(row["key"], "weekly")

    def test_missing_seconds_fall_back_to_position(self):
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

    def test_an_unrecognised_length_keeps_the_positional_label(self):
        self.serve(
            {
                "rate_limit": {
                    "primary_window": {"used_percent": 10, "limit_window_seconds": 3600},
                }
            }
        )
        row = API._codex_direct()["windows"][0]
        self.assertEqual(row["label"], "5h")
        self.assertEqual(row["duration_seconds"], 3600)
        self.assertEqual(row["key"], "3600s")


if __name__ == "__main__":
    unittest.main()
