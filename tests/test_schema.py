"""Payload contract tests: the schema, the validator subset and the row fields."""

import copy
import json
import os
import time
import unittest
from datetime import datetime, timedelta, timezone

from tests import test_fixture_cases as base

API = base.API
SCHEMA_PATH = base.ROOT / "schema" / "usage.schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

ALLOWED_KEYWORDS = {
    "$schema",
    "title",
    "description",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "minimum",
    "maximum",
    "$defs",
    "$ref",
}


class SchemaError(Exception):
    """The instance or the schema broke the supported subset."""


def check_keywords(schema):
    """Raise when a schema node uses a keyword outside the subset."""
    if not isinstance(schema, dict):
        raise SchemaError("a schema node must be an object")
    extra = set(schema) - ALLOWED_KEYWORDS
    if extra:
        raise SchemaError("unsupported keyword(s): %s" % ", ".join(sorted(extra)))
    for name, sub in (schema.get("properties") or {}).items():
        if not isinstance(sub, dict):
            raise SchemaError("property %s is not a schema object" % name)
        check_keywords(sub)
    for name, sub in (schema.get("$defs") or {}).items():
        if not isinstance(sub, dict):
            raise SchemaError("definition %s is not a schema object" % name)
        check_keywords(sub)
    if "items" in schema:
        check_keywords(schema["items"])


def is_type(value, name):
    if name == "object":
        return isinstance(value, dict)
    if name == "array":
        return isinstance(value, list)
    if name == "string":
        return isinstance(value, str)
    if name == "boolean":
        return isinstance(value, bool)
    if name == "null":
        return value is None
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    raise SchemaError("unsupported type name: %s" % name)


def validate(instance, schema=None):
    """Validate against the supported subset, refusing anything it cannot check."""
    root = SCHEMA if schema is None else schema
    check_keywords(root)
    validate_node(instance, root, root)


def validate_node(value, schema, root):
    if "$ref" in schema:
        ref = schema["$ref"]
        prefix = "#/$defs/"
        if not isinstance(ref, str) or not ref.startswith(prefix):
            raise SchemaError("unsupported $ref: %r" % (ref,))
        name = ref[len(prefix) :]
        target = (root.get("$defs") or {}).get(name)
        if target is None:
            raise SchemaError("unknown $ref: %s" % ref)
        validate_node(value, target, root)
        return

    types = schema.get("type")
    if types is not None:
        names = [types] if isinstance(types, str) else types
        if not any(is_type(value, name) for name in names):
            raise SchemaError("%r does not match type %s" % (value, names))

    allowed = schema.get("enum")
    if allowed is not None and value not in allowed:
        raise SchemaError("%r is not one of %r" % (value, allowed))

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            raise SchemaError("%r is below the minimum %r" % (value, schema["minimum"]))
        if "maximum" in schema and value > schema["maximum"]:
            raise SchemaError("%r is above the maximum %r" % (value, schema["maximum"]))

    if isinstance(value, dict):
        props = schema.get("properties") or {}
        for name in schema.get("required") or []:
            if name not in value:
                raise SchemaError("missing required field %s" % name)
        if schema.get("additionalProperties") is False:
            extra = set(value) - set(props)
            if extra:
                raise SchemaError("unexpected field(s): %s" % ", ".join(sorted(extra)))
        for name, sub in props.items():
            if name in value:
                validate_node(value[name], sub, root)

    if isinstance(value, list) and "items" in schema:
        for item in value:
            validate_node(item, schema["items"], root)


def schema_property_names(schema):
    names = set()
    for name, sub in (schema.get("properties") or {}).items():
        names.add(name)
        names |= schema_property_names(sub)
    if "items" in schema:
        names |= schema_property_names(schema["items"])
    for sub in (schema.get("$defs") or {}).values():
        names |= schema_property_names(sub)
    return names


def payload_keys(value):
    keys = set()
    if isinstance(value, dict):
        keys |= set(value)
        for item in value.values():
            keys |= payload_keys(item)
    elif isinstance(value, list):
        for item in value:
            keys |= payload_keys(item)
    return keys


def iso_at(epoch):
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fixture_payloads():
    """Run every ok and error fixture case through _collect, one provider each."""
    out = []
    for pid, cases in base.CASES.items():
        for files, mode, expect in cases:
            if expect not in ("ok", "error"):
                continue
            names = files if isinstance(files, tuple) else (files,)
            bodies = [
                json.loads(base.fixture_path(pid, name).read_text(encoding="utf-8"))
                for name in names
            ]
            driver = base.FixtureCaseTest("test_cases")
            driver.setUp()
            saved_order = API.FETCH_ORDER
            try:
                driver._reset()
                driver._apply(pid, mode, bodies)
                API.FETCH_ORDER = (pid,)
                payload = API._collect()
            finally:
                API.FETCH_ORDER = saved_order
                driver.tearDown()
            out.append(("%s %s" % (pid, names[0]), payload))
    return out


def seed_fresh_history(test):
    """A collection with enough seeded history to project windows and money."""
    now = time.time()
    API._secret = lambda *names: "sentinel"
    API._history[("zai", "session_5h")] = [[now - 2400, 40.0], [now - 300, 55.0]]
    API._history[("openrouter", "money:balance:usd")] = [
        [now - 2400, 30.0],
        [now - 300, 40.0],
    ]

    def http(url, headers, **kwargs):
        if "quota" in url:
            return {
                "data": {
                    "limits": [
                        {
                            "type": "TOKENS_LIMIT",
                            "percentage": 60,
                            "nextResetTime": int((now + 7200) * 1000),
                        }
                    ]
                }
            }
        if url.endswith("/key"):
            return {"data": {"limit": 50, "usage": 10}}
        return {"data": {"total_credits": 100, "total_usage": 40}}

    API._http_json = http
    return test.collect(("zai", "openrouter"))


class Base(unittest.TestCase):
    NAMES = ("FETCHERS", "FETCH_ORDER", "_secret", "_http_json", "_read_text")

    def setUp(self):
        self.saved = {name: getattr(API, name) for name in self.NAMES}
        self.saved_state = {
            name: copy.deepcopy(getattr(API, name)) for name in ("_holds", "_last_good", "_history")
        }
        self.saved_inflight = dict(API._inflight)
        for name in ("_holds", "_last_good", "_history"):
            getattr(API, name).clear()
        API._inflight.clear()
        API._HOST_WINNERS.clear()
        self.addCleanup(self.restore)

    def restore(self):
        for name, value in self.saved.items():
            setattr(API, name, value)
        for name, value in self.saved_state.items():
            live = getattr(API, name)
            live.clear()
            live.update(value)
        API._inflight.clear()
        API._inflight.update(self.saved_inflight)
        API._HOST_WINNERS.clear()

    def collect(self, order):
        API.FETCH_ORDER = tuple(order)
        return API._collect()


class FixtureSchemaTest(unittest.TestCase):
    def test_every_ok_and_error_case_validates(self):
        payloads = fixture_payloads()
        self.assertTrue(payloads)
        for name, payload in payloads:
            with self.subTest(case=name):
                validate(payload)


class RarePayloadTest(Base):
    def test_a_hold_with_a_last_good_reading(self):
        API._last_good["zai"] = {
            "id": "zai",
            "status": "ok",
            "windows": [
                {
                    "label": "5h",
                    "percent": 42.0,
                    "resets_at": None,
                    "status": "ok",
                    "scope": "account",
                }
            ],
        }
        API._holds["zai"] = time.time() + 120
        payload = self.collect(("zai",))
        provider = payload["providers"][0]
        self.assertTrue(provider["stale"])
        self.assertIn("hold_until", provider)
        validate(payload)

    def test_a_hold_without_a_reading(self):
        API._holds["zai"] = time.time() + 120
        payload = self.collect(("zai",))
        provider = payload["providers"][0]
        self.assertEqual(provider["status"], "error")
        self.assertTrue(provider["error"].startswith("rate limited until"))
        validate(payload)

    def test_a_timeout_result(self):
        def slow():
            time.sleep(0.25)
            return {"id": "zai", "status": "ok", "windows": []}

        API.FETCHERS = dict(API.FETCHERS, zai=slow)
        payload = API._collect(deadline=time.monotonic() + 0.05)
        provider = payload["providers"][0]
        self.assertEqual(provider["status"], "error")
        self.assertEqual(provider["error"], "timeout")
        event = API._inflight.get("zai")
        if event is not None:
            event.wait(2.0)
        validate(payload)

    def test_the_stale_snapshot_path(self):
        snap = base.snapshot_from(
            {
                "available": True,
                "windows": [
                    {"label": "5h", "used_percent": 33.0, "reset_at": "2026-01-01T00:00:00Z"}
                ],
            }
        )
        stale = API._last_reading("zai", snap)
        self.assertIsNotNone(stale)
        API.FETCHERS = dict(API.FETCHERS, zai=lambda: stale)
        payload = self.collect(("zai",))
        provider = payload["providers"][0]
        self.assertTrue(provider["stale"])
        self.assertIn("fetched_at", provider)
        validate(payload)

    def test_codex_direct_carries_a_plan(self):
        payloads = dict(fixture_payloads())
        payload = payloads["openai-codex ok.json"]
        self.assertEqual(payload["providers"][0]["plan"], "plus")
        validate(payload)

    def test_fresh_history_produces_projections(self):
        payload = seed_fresh_history(self)
        rows = {p["id"]: p for p in payload["providers"]}
        window = rows["zai"]["windows"][0]
        balance = next(m for m in rows["openrouter"]["money"] if m["label"] == "Balance")
        self.assertIn("eta_seconds", window)
        self.assertIsNotNone(window["actionable_eta"])
        self.assertIn("depletes_in_seconds", balance)
        self.assertIsNotNone(balance["actionable_eta"])
        validate(payload)


class CoverageTest(Base):
    def test_every_schema_property_appears_in_a_payload(self):
        payloads = fixture_payloads()
        API._last_good["zai"] = {
            "id": "zai",
            "status": "ok",
            "windows": [
                {
                    "label": "5h",
                    "percent": 42.0,
                    "resets_at": None,
                    "status": "ok",
                    "scope": "account",
                }
            ],
        }
        API._holds["zai"] = time.time() + 120
        payloads.append(("hold", self.collect(("zai",))))
        API._holds.clear()
        API._last_good.clear()
        payloads.append(("fresh", seed_fresh_history(self)))

        seen = set()
        for _name, payload in payloads:
            seen |= payload_keys(payload)
        missing = schema_property_names(SCHEMA) - seen
        self.assertEqual(missing, set(), "schema fields never seen in a payload")


class ValidatorTest(unittest.TestCase):
    def base_payload(self):
        payloads = dict(fixture_payloads())
        return copy.deepcopy(payloads["zai ok.json"])

    def test_rejects_a_wrong_type(self):
        payload = self.base_payload()
        payload["fetched_at"] = 5
        with self.assertRaises(SchemaError):
            validate(payload)

    def test_rejects_a_missing_required_field(self):
        payload = self.base_payload()
        del payload["fetched_at"]
        with self.assertRaises(SchemaError):
            validate(payload)

    def test_rejects_an_extra_field(self):
        payload = self.base_payload()
        payload["extra"] = 1
        with self.assertRaises(SchemaError):
            validate(payload)

    def test_rejects_used_pct_over_100(self):
        payload = self.base_payload()
        payload["providers"][0]["windows"][0]["used_pct"] = 101
        with self.assertRaises(SchemaError):
            validate(payload)

    def test_rejects_a_value_outside_an_enum(self):
        payload = self.base_payload()
        payload["providers"][0]["status"] = "maybe"
        with self.assertRaises(SchemaError):
            validate(payload)

    def test_rejects_an_unsupported_keyword(self):
        schema = {"type": "object", "oneOf": []}
        with self.assertRaises(SchemaError):
            validate({}, schema)


class ContractRuleTest(unittest.TestCase):
    NOW = 1_000_000.0

    def rows(self, windows=(), money=()):
        p = {"windows": [dict(row) for row in windows], "money": [dict(row) for row in money]}
        API._assign_keys(p)
        API._contract_rows(p, self.NOW)
        return p

    def test_key_slug_and_suffixes(self):
        rows = self.rows(
            windows=[
                {"label": "Session (5h)", "percent": 10.0},
                {"label": "Session (5h)", "percent": 20.0},
                {"label": "Session (5h)", "percent": 30.0},
            ]
        )
        self.assertEqual(
            [row["key"] for row in rows["windows"]],
            ["session_5h", "session_5h:2", "session_5h:3"],
        )

    def test_money_key_includes_the_currency(self):
        rows = self.rows(money=[{"label": "Key cap", "left": 5.0, "cur": "USD"}])
        self.assertEqual(rows["money"][0]["key"], "money:key_cap:usd")

    def test_two_currencies_need_no_suffix(self):
        rows = self.rows(
            money=[
                {"label": "Balance", "left": 5.0, "cur": "CNY"},
                {"label": "Balance", "left": 6.0, "cur": "USD"},
            ]
        )
        self.assertEqual(
            [row["key"] for row in rows["money"]],
            ["money:balance:cny", "money:balance:usd"],
        )

    def test_kind_is_set(self):
        rows = self.rows(
            windows=[{"label": "5h", "percent": 10.0}],
            money=[{"label": "Balance", "left": 1.0, "cur": "USD"}],
        )
        self.assertEqual(rows["windows"][0]["kind"], "window")
        self.assertEqual(rows["money"][0]["kind"], "money")

    def test_money_used_pct_with_and_without_total(self):
        rows = self.rows(
            money=[
                {"label": "Balance", "left": 60.0, "total": 100.0, "cur": "USD"},
                {"label": "Top-up", "left": 7.0, "cur": "USD"},
            ]
        )
        self.assertEqual(rows["money"][0]["used_pct"], 40.0)
        self.assertIsNone(rows["money"][1]["used_pct"])

    def test_money_used_pct_is_clamped(self):
        rows = self.rows(money=[{"label": "Balance", "left": -10.0, "total": 100.0}])
        self.assertEqual(rows["money"][0]["used_pct"], 100.0)

    def test_window_warn_at_the_threshold(self):
        rows = self.rows(
            windows=[
                {"label": "a", "percent": 79.9},
                {"label": "b", "percent": 80.0},
            ]
        )
        self.assertFalse(rows["windows"][0]["warn"])
        self.assertTrue(rows["windows"][1]["warn"])

    def test_only_a_key_cap_money_row_warns(self):
        rows = self.rows(
            money=[
                {"label": "Key cap", "left": 10.0, "total": 100.0},
                {"label": "Balance", "left": 10.0, "total": 100.0},
            ]
        )
        self.assertTrue(rows["money"][0]["warn"])
        self.assertFalse(rows["money"][1]["warn"])

    def test_window_actionable_eta_boundaries(self):
        reset = iso_at(self.NOW + 7200)
        rows = self.rows(
            windows=[
                {"label": "equal", "percent": 50.0, "eta_seconds": 7200, "resets_at": reset},
                {"label": "under", "percent": 50.0, "eta_seconds": 7199, "resets_at": reset},
                {
                    "label": "past",
                    "percent": 50.0,
                    "eta_seconds": 60,
                    "resets_at": iso_at(self.NOW - 5),
                },
                {"label": "week", "percent": 50.0, "eta_seconds": 7 * 86400, "resets_at": None},
                {"label": "over", "percent": 50.0, "eta_seconds": 7 * 86400 + 1, "resets_at": None},
                {"label": "none", "percent": 50.0, "resets_at": None},
            ]
        )
        got = {row["label"]: row["actionable_eta"] for row in rows["windows"]}
        self.assertEqual(
            got,
            {
                "equal": None,
                "under": 7199,
                "past": None,
                "week": 7 * 86400,
                "over": None,
                "none": None,
            },
        )

    def test_money_actionable_eta_boundaries(self):
        rows = self.rows(
            money=[
                {"label": "a", "left": 1.0, "depletes_in_seconds": 14 * 86400},
                {"label": "b", "left": 1.0, "depletes_in_seconds": 14 * 86400 - 1},
                {"label": "c", "left": 1.0},
            ]
        )
        got = {row["label"]: row["actionable_eta"] for row in rows["money"]}
        self.assertEqual(got, {"a": None, "b": 14 * 86400 - 1, "c": None})

    def test_a_label_with_no_slug_gives_row(self):
        rows = self.rows(
            windows=[{"label": "!!!", "percent": 10.0}],
            money=[{"label": "", "left": 1.0, "cur": "USD"}],
        )
        self.assertEqual(rows["windows"][0]["key"], "row")
        self.assertEqual(rows["money"][0]["key"], "money:row:usd")

    def test_zero_eta_is_not_actionable(self):
        rows = self.rows(
            windows=[{"label": "a", "percent": 50.0, "eta_seconds": 0, "resets_at": None}],
            money=[{"label": "b", "left": 1.0, "depletes_in_seconds": 0}],
        )
        self.assertIsNone(rows["windows"][0]["actionable_eta"])
        self.assertIsNone(rows["money"][0]["actionable_eta"])

    def test_money_used_pct_rounds_to_one_decimal(self):
        rows = self.rows(money=[{"label": "Balance", "left": 2.0, "total": 3.0}])
        self.assertEqual(rows["money"][0]["used_pct"], 33.3)


class EpochTest(unittest.TestCase):
    def test_the_stamps_that_differ_across_pythons(self):
        cases = {
            "2026-11-07T10:00:00+0000": datetime(2026, 11, 7, 10, tzinfo=timezone.utc),
            "2026-11-07T10:00:00.12Z": datetime(2026, 11, 7, 10, 0, 0, 120000, tzinfo=timezone.utc),
            "2026-11-07T10:00:00.123456789Z": datetime(
                2026, 11, 7, 10, 0, 0, 123456, tzinfo=timezone.utc
            ),
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(API._epoch_from_iso(text), expected.timestamp())

    def test_offsets_and_loose_forms(self):
        india = timezone(timedelta(hours=5, minutes=30))
        west = timezone(timedelta(hours=-8))
        cases = {
            "2026-11-07T10:00:00+05:30": datetime(2026, 11, 7, 10, tzinfo=india).timestamp(),
            "2026-11-07T10:00:00-0800": datetime(2026, 11, 7, 10, tzinfo=west).timestamp(),
            "2026-11-07": datetime(2026, 11, 7, tzinfo=timezone.utc).timestamp(),
            "2026-11-07 10:00": datetime(2026, 11, 7, 10, tzinfo=timezone.utc).timestamp(),
            "2026-11-07T10:00:00Z": datetime(2026, 11, 7, 10, tzinfo=timezone.utc).timestamp(),
            "2026-11-07T10:00:00.123Z": datetime(
                2026, 11, 7, 10, 0, 0, 123000, tzinfo=timezone.utc
            ).timestamp(),
            "2026-11-07T10:00:00.123456Z": datetime(
                2026, 11, 7, 10, 0, 0, 123456, tzinfo=timezone.utc
            ).timestamp(),
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(API._epoch_from_iso(text), expected)

    def test_rejected_forms(self):
        for value in ("", "1762509600", "not a date", "2026-13-01", 1762509600, None):
            with self.subTest(value=value):
                self.assertIsNone(API._epoch_from_iso(value))

    def test_offsets_out_of_range_give_none(self):
        for text in ("2026-11-07T10:00:00+24:00", "2026-11-07T10:00:00+05:60"):
            with self.subTest(text=text):
                self.assertIsNone(API._epoch_from_iso(text))

    def test_forms_fromisoformat_accepts_but_we_reject(self):
        for text in ("20261107", "2026-W45-6", "2026-11-07T10"):
            with self.subTest(text=text):
                self.assertIsNone(API._epoch_from_iso(text))

    def test_trailing_text_gives_none(self):
        for text in ("2026-11-07T10:00:00Z junk", "2026-11-07T10:00:00Zjunk"):
            with self.subTest(text=text):
                self.assertIsNone(API._epoch_from_iso(text))

    def test_surrounding_spaces_are_allowed(self):
        self.assertEqual(
            API._epoch_from_iso(" 2026-11-07T10:00:00Z "),
            API._epoch_from_iso("2026-11-07T10:00:00Z"),
        )

    def test_no_zone_is_utc_on_a_non_utc_host(self):
        if not hasattr(time, "tzset"):
            self.skipTest("tzset is not available")
        saved = os.environ.get("TZ")
        try:
            os.environ["TZ"] = "Pacific/Kiritimati"
            time.tzset()
            self.assertEqual(
                API._epoch_from_iso("2026-11-07T10:00:00"),
                API._epoch_from_iso("2026-11-07T10:00:00Z"),
            )
        finally:
            if saved is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = saved
            time.tzset()


class SchemaValueTest(unittest.TestCase):
    def base_payload(self):
        return copy.deepcopy(dict(fixture_payloads())["zai ok.json"])

    def test_a_window_status_may_be_null(self):
        payload = self.base_payload()
        payload["providers"][0]["windows"][0]["status"] = None
        validate(payload)

    def test_a_window_status_may_be_an_upstream_value(self):
        payload = self.base_payload()
        payload["providers"][0]["windows"][0]["status"] = "critical"
        validate(payload)

    def test_actionable_eta_rejects_a_boolean(self):
        payload = self.base_payload()
        payload["providers"][0]["windows"][0]["actionable_eta"] = True
        with self.assertRaises(SchemaError):
            validate(payload)

    def test_used_pct_rejects_a_negative(self):
        payload = self.base_payload()
        payload["providers"][0]["windows"][0]["used_pct"] = -1
        with self.assertRaises(SchemaError):
            validate(payload)


if __name__ == "__main__":
    unittest.main()
