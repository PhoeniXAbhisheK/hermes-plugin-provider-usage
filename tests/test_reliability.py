"""Reliability tests: budgets, deadlines, single-flight, labels and identity.

Every fetcher is replaced with a fake, so nothing here touches the network or a
real credential. Budgets are patched to fractions of a second and waits are real
but short.
"""

import contextvars
import importlib.util
import sys
import threading
import time
import unittest
from pathlib import Path

import httpx

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


class Base(unittest.TestCase):
    def setUp(self):
        self._saved = {
            "fetchers": dict(API.FETCHERS),
            "deadline": getattr(API, "DEADLINE_S", None),
            "budget": getattr(API, "PROVIDER_BUDGET_S", None),
            "http": API._http_json,
            "lock": API._lock,
            "helpers": {
                name: getattr(API, name)
                for name in (
                    "_hermes_usage",
                    "_cached_snapshot",
                    "_fetch_usage",
                    "_read_text",
                    "_secret",
                )
            },
        }
        self._reset_state()
        API._lock = API.threading.Lock()

    def tearDown(self):
        API.FETCHERS.clear()
        API.FETCHERS.update(self._saved["fetchers"])
        if self._saved["deadline"] is not None:
            API.DEADLINE_S = self._saved["deadline"]
        if self._saved["budget"] is not None:
            API.PROVIDER_BUDGET_S = self._saved["budget"]
        API._http_json = self._saved["http"]
        API._lock = self._saved["lock"]
        for name, value in self._saved["helpers"].items():
            setattr(API, name, value)
        self._reset_state()

    def _reset_state(self):
        with API._lock:
            API._cache["at"] = 0.0
            API._cache["payload"] = None
            running = getattr(API, "_running", None)
            if running is not None:
                running["run"] = None
        API._last_good.clear()
        API._holds.clear()
        API._history.clear()
        API._helper_cooldown.clear()
        inflight = getattr(API, "_inflight", None)
        if inflight is not None:
            inflight.clear()
        winners = getattr(API, "_HOST_WINNERS", None)
        if winners is not None:
            winners.clear()
        direct = getattr(API, "_direct_cooldown", None)
        if direct is not None:
            direct.clear()
        readings = getattr(API, "_direct_readings", None)
        if readings is not None:
            readings.clear()

    def use(self, mapping):
        """Install exactly the fetchers in mapping; everything else skips."""
        API.FETCHERS.clear()
        for pid in API.FETCH_ORDER:
            API.FETCHERS[pid] = mapping.get(pid) or (lambda pid=pid: _skip(pid))


def _skip(pid):
    raise API._Skip(pid)


class BudgetTest(Base):
    def test_provider_past_its_budget_returns_timeout_on_time(self):
        API.PROVIDER_BUDGET_S = 0.2
        API.DEADLINE_S = 5.0
        self.use({"zai": lambda: (time.sleep(2.0), {"id": "zai", "status": "ok"})[1]})
        started = time.monotonic()
        out = API._collect()
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 1.0, "collection waited for the worker")
        row = {p["id"]: p for p in out["providers"]}["zai"]
        self.assertEqual(row["status"], "error")
        self.assertEqual(row["error"], "timeout")

    def test_overall_deadline_bounds_the_collection(self):
        API.PROVIDER_BUDGET_S = 5.0
        API.DEADLINE_S = 0.25
        self.use(
            {"kimi-coding": lambda: (time.sleep(2.0), {"id": "kimi-coding", "status": "ok"})[1]}
        )
        started = time.monotonic()
        out = API._collect()
        self.assertLess(time.monotonic() - started, 1.0)
        row = {p["id"]: p for p in out["providers"]}["kimi-coding"]
        self.assertEqual(row["error"], "timeout")

    def test_chain_uses_the_remaining_budget(self):
        seen = {}

        class FakeClient:
            def __init__(self, **kwargs):
                seen["timeout"] = kwargs.get("timeout")

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def get(self, url, headers=None):
                return httpx.Response(200, text="{}", request=httpx.Request("GET", url))

        real = API.httpx.Client
        API.httpx.Client = FakeClient
        try:
            API._deadline.set(time.monotonic() + 3.0)
            API._http_json("https://api.z.ai/x", {})
            self.assertLessEqual(seen["timeout"], 3.0)
            self.assertGreater(seen["timeout"], 1.0)
            API._deadline.set(time.monotonic() - 1.0)
            with self.assertRaises(API._Timeout):
                API._http_json("https://api.z.ai/x", {})
        finally:
            API.httpx.Client = real
            API._deadline.set(None)

    def test_last_good_is_marked_stale_on_timeout(self):
        API.DEADLINE_S = 5.0
        self.use(
            {
                "zai": lambda: {
                    "id": "zai",
                    "status": "ok",
                    "windows": [{"label": "5h", "percent": 5}],
                }
            }
        )
        API._collect()
        self.assertIn("zai", API._last_good)
        API.PROVIDER_BUDGET_S = 0.15
        self.use(
            {
                "zai": lambda: (
                    time.sleep(1.0),
                    {"id": "zai", "status": "ok", "windows": [{"label": "5h", "percent": 5}]},
                )[1]
            }
        )
        out = API._collect()
        row = {p["id"]: p for p in out["providers"]}["zai"]
        self.assertTrue(row.get("stale"))
        self.assertEqual(row["windows"][0]["percent"], 5)

    def test_moonshot_winner_is_remembered(self):
        calls = []

        def fake_http(url, headers, **kwargs):
            calls.append(url)
            if url.startswith("https://api.moonshot.ai"):
                raise FileNotFoundError("HTTP 404: endpoint not offered for this account")
            return {"data": {"available_balance": 1.0}}

        API._http_json = fake_http
        API._fetch_moonshot_balance({"Authorization": "Bearer sentinel"})
        first = list(calls)
        calls.clear()
        API._fetch_moonshot_balance({"Authorization": "Bearer sentinel"})
        second = list(calls)
        self.assertEqual(first[0], "https://api.moonshot.ai/v1/users/me/balance")
        self.assertEqual(second[0], "https://api.moonshot.cn/v1/users/me/balance")

    def test_winning_host_is_remembered(self):
        calls = []

        def fake_http(url, headers, **kwargs):
            calls.append(url)
            if url.startswith(("https://api.minimaxi.com", "https://www.minimax.cn")):
                raise FileNotFoundError("HTTP 404: endpoint not offered for this account")
            return {"model_remains": [{"current_interval_remaining_percent": 50}]}

        API._http_json = fake_http
        API._secret = lambda *names: "sentinel" if names[0] == "MINIMAX_CN_API_KEY" else None
        API._minimax_credentials()
        API.fetch_minimax()
        first = list(calls)
        calls.clear()
        API.fetch_minimax()
        second = list(calls)
        self.assertEqual(first[0], "https://api.minimaxi.com/v1/token_plan/remains")
        self.assertEqual(second[0], "https://api.minimax.io/v1/token_plan/remains")


class LateWorkerTest(Base):
    def test_late_worker_cannot_change_results_or_state(self):
        API.PROVIDER_BUDGET_S = 0.1
        API.DEADLINE_S = 0.2

        def slow():
            time.sleep(0.5)
            return {"id": "zai", "status": "ok", "windows": [{"label": "5h", "percent": 9}]}

        self.use({"zai": slow})
        out = API._collect()
        self.assertEqual({p["id"]: p for p in out["providers"]}["zai"]["error"], "timeout")
        time.sleep(0.7)
        self.assertNotIn("zai", API._last_good)
        self.assertNotIn("zai", API._holds)
        self.assertFalse(any(key[0] == "zai" for key in API._history))

    def test_late_helper_read_cannot_set_a_cooldown(self):
        API.PROVIDER_BUDGET_S = 0.1
        API.DEADLINE_S = 0.2
        finished = threading.Event()

        def slow_helper(provider):
            time.sleep(0.3)
            return None

        def slow():
            time.sleep(0.3)
            try:
                return API._hermes_usage("zai")
            finally:
                finished.set()

        API._fetch_usage = slow_helper
        API._cached_snapshot = lambda provider: None
        self.use({"zai": slow})
        API.payload(fresh=True)
        self.assertTrue(finished.wait(3.0), "the late worker never finished")
        self.assertNotIn("zai", API._helper_cooldown)

    def test_no_second_worker_while_the_first_is_running(self):
        release = threading.Event()
        calls = []

        def blocked():
            calls.append(1)
            release.wait(2.0)
            return {"id": "zai", "status": "ok", "windows": [{"label": "5h", "percent": 1}]}

        API.PROVIDER_BUDGET_S = 0.1
        API.DEADLINE_S = 0.2
        self.use({"zai": blocked})
        API._collect()
        API._collect()
        self.assertEqual(len(calls), 1, "a second worker started for a running provider")
        release.set()
        time.sleep(0.3)


class SingleFlightTest(Base):
    def test_two_callers_share_one_collection(self):
        calls = []

        def counted():
            calls.append(1)
            time.sleep(0.2)
            return {"id": "zai", "status": "ok", "windows": [{"label": "5h", "percent": 2}]}

        self.use({"zai": counted})
        out = {}
        threads = [
            threading.Thread(target=lambda: out.setdefault("a", API.payload(fresh=True))),
            threading.Thread(target=lambda: out.setdefault("b", API.payload(fresh=True))),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
        self.assertEqual(len(calls), 1)
        self.assertEqual(out["a"], out["b"])

    def test_warm_cache_answers_during_a_refresh(self):
        for kwargs, label in (
            ({}, "scheduled"),
            ({"fresh": True}, "fresh"),
            ({"refresh": True}, "manual refresh"),
        ):
            with self.subTest(caller=label):
                API._cache["payload"] = {"fetched_at": "2026-01-01T00:00:00Z", "providers": []}
                API._cache["at"] = time.time()
                started = threading.Event()

                def slow():
                    started.set()
                    time.sleep(0.8)
                    return {"id": "zai", "status": "ok", "windows": [{"label": "5h", "percent": 1}]}

                self.use({"zai": slow})
                t = threading.Thread(target=lambda: API.payload(fresh=True))
                t.start()
                self.assertTrue(started.wait(2.0))
                began = time.monotonic()
                cached = API.payload(**kwargs)
                elapsed = time.monotonic() - began
                self.assertLess(elapsed, 0.1, label + " caller waited for the collection")
                self.assertEqual(cached["providers"], [])
                t.join(5)

    def test_collector_error_does_not_wedge_the_next_caller(self):
        def boom():
            raise RuntimeError("collector exploded")

        real = API._collect
        API._collect = boom
        try:
            with self.assertRaises(RuntimeError):
                API.payload(fresh=True)
        finally:
            API._collect = real
        API.FETCHERS["zai"] = lambda: {"id": "zai", "status": "ok", "windows": []}
        result = API.payload(fresh=True)
        self.assertIn("providers", result)


class EmptyRowsTest(Base):
    def test_helper_payload_without_rows_is_skipped(self):
        for pid in ("anthropic", "openai-codex"):
            with self.subTest(pid=pid):
                API._hermes_usage = lambda provider, pid=pid: {
                    "id": pid,
                    "status": "ok",
                    "windows": [],
                }
                with self.assertRaises(API._Skip):
                    API.FETCHERS[pid]()

    def test_codex_without_windows_is_skipped(self):
        API._hermes_usage = lambda provider: None
        API._read_text = lambda path: '{"tokens": {"access_token": "sentinel"}}'
        API._http_json = lambda url, headers, **kw: {"rate_limit": {}}
        with self.assertRaises(API._Skip):
            API.fetch_openai_codex()

    def test_openrouter_without_money_is_skipped(self):
        API._secret = lambda *names: "sentinel"
        API._http_json = lambda url, headers, **kw: {}
        with self.assertRaises(API._Skip):
            API.fetch_openrouter()


class CodexLabelTest(Base):
    def _codex(self, windows):
        return lambda: {"id": "openai-codex", "status": "ok", "windows": windows}

    def test_weekly_only_reports_seven_days(self):
        body = {
            "rate_limit": {
                "primary_window": {"used_percent": 10, "limit_window_seconds": 604800},
            }
        }
        API._http_json = lambda url, headers, **kw: body
        API._secret = lambda *names: None
        API._hermes_usage = lambda provider: None
        API._read_text = lambda path: '{"tokens": {"access_token": "sentinel"}}'
        out = API.fetch_openai_codex()
        self.assertEqual([w["label"] for w in out["windows"]], ["7d"])

    def test_monthly_only_reports_monthly(self):
        body = {
            "rate_limit": {
                "primary_window": {"used_percent": 10, "limit_window_seconds": 2592000},
            }
        }
        API._http_json = lambda url, headers, **kw: body
        API._hermes_usage = lambda provider: None
        API._read_text = lambda path: '{"tokens": {"access_token": "sentinel"}}'
        out = API.fetch_openai_codex()
        self.assertEqual([w["label"] for w in out["windows"]], ["Monthly"])

    def test_five_hours_and_missing_value(self):
        body = {
            "rate_limit": {
                "primary_window": {"used_percent": 10, "limit_window_seconds": 18000},
                "secondary_window": {"used_percent": 20},
            }
        }
        API._http_json = lambda url, headers, **kw: body
        API._hermes_usage = lambda provider: None
        API._read_text = lambda path: '{"tokens": {"access_token": "sentinel"}}'
        out = API.fetch_openai_codex()
        self.assertEqual([w["label"] for w in out["windows"]], ["5h", "7d"])
        self.assertEqual([w["percent"] for w in out["windows"]], [10, 20])


class CodexFallbackTest(Base):
    def test_helper_failure_uses_the_file_token(self):
        sent_headers = []

        def fake_http(url, headers, **kwargs):
            sent_headers.append(dict(headers))
            return {
                "rate_limit": {"primary_window": {"used_percent": 1, "limit_window_seconds": 18000}}
            }

        def refuse(provider):
            raise RuntimeError("helper refused")

        API._hermes_usage = lambda provider: None
        API._http_json = fake_http
        API._read_text = lambda path: (
            '{"tokens": {"access_token": "sentinel-file-token"}, "OPENAI_API_KEY": "sentinel-platform"}'
        )
        out = API.fetch_openai_codex()
        self.assertEqual(out["status"], "ok")
        self.assertEqual(sent_headers[0]["Authorization"], "Bearer sentinel-file-token")


class CurrencyIdentityTest(Base):
    def test_two_currencies_get_two_histories(self):
        self.use(
            {
                "deepseek": lambda: {
                    "id": "deepseek",
                    "status": "ok",
                    "money": [
                        {"label": "Balance", "left": 5.0, "total": 10.0, "cur": "USD"},
                        {"label": "Balance", "left": 70.0, "total": 100.0, "cur": "CNY"},
                    ],
                }
            }
        )
        API._collect()
        keys = sorted(key[1] for key in API._history if key[0] == "deepseek")
        self.assertEqual(len(keys), 2, keys)
        self.assertIn("money:Balance:USD", keys)
        self.assertIn("money:Balance:CNY", keys)


class HelperTimeoutTest(Base):
    def test_helper_call_returns_at_its_timeout(self):
        began = time.monotonic()
        with self.assertRaises(API._Timeout):
            API._helper_call(lambda: time.sleep(2.0), timeout=0.2, key="probe")
        self.assertLess(time.monotonic() - began, 1.0)

    def test_helper_is_not_stacked(self):
        release = threading.Event()
        calls = []

        def slow():
            calls.append(1)
            release.wait(2.0)

        API._HELPER_INFLIGHT.clear()
        try:
            with self.assertRaises(API._Timeout):
                API._helper_call(slow, timeout=0.1, key="probe")
            with self.assertRaises(API._Timeout):
                API._helper_call(slow, timeout=0.1, key="probe")
            self.assertEqual(len(calls), 1)
        finally:
            release.set()

    def test_nous_honours_the_helper_timeout(self):
        import sys
        import types

        package = types.ModuleType("agent")
        package.__path__ = []
        usage = types.ModuleType("agent.account_usage")
        usage.build_nous_credits_snapshot = lambda info: None
        stub = types.ModuleType("hermes_cli.nous_account")
        stub.get_nous_portal_account_info = lambda **kwargs: time.sleep(2.0)
        names = ("agent", "agent.account_usage", "hermes_cli.nous_account")
        saved = {name: sys.modules.get(name) for name in names}
        sys.modules.update(
            {
                "agent": package,
                "agent.account_usage": usage,
                "hermes_cli.nous_account": stub,
            }
        )
        API.HELPER_TIMEOUT_S = 0.2
        API._HELPER_INFLIGHT.clear()
        try:
            began = time.monotonic()
            with self.assertRaises(API._Timeout):
                API.fetch_nous()
            self.assertLess(time.monotonic() - began, 1.0)
        finally:
            for name, module in saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module
            API.HELPER_TIMEOUT_S = 10.0


class ContextThroughPayloadTest(Base):
    """The collector thread must run in the caller's context, not an empty one."""

    def _probe(self):
        return contextvars.ContextVar("probe_scope", default="default")

    def test_payload_carries_the_caller_context(self):
        probe = self._probe()
        seen = []

        def fetcher():
            seen.append(probe.get())
            return {"id": "zai", "status": "ok", "windows": [{"label": "5h", "percent": 1}]}

        self.use({"zai": fetcher})
        token = probe.set("caller-scope")
        try:
            API.payload(fresh=True)
        finally:
            probe.reset(token)
        self.assertEqual(seen, ["caller-scope"])

    def test_route_carries_the_caller_context(self):
        probe = self._probe()
        seen = []

        def fetcher():
            seen.append(probe.get())
            return {"id": "zai", "status": "ok", "windows": [{"label": "5h", "percent": 1}]}

        self.use({"zai": fetcher})
        token = probe.set("route-scope")
        try:
            API.get_usage(fresh=True)
        finally:
            probe.reset(token)
        self.assertEqual(seen, ["route-scope"])


class DirectFallbackTest(Base):
    """Decision 12: a young stale reading wins; an old one tries the token once."""

    PROVIDERS = {
        "anthropic": {
            "stale_id": "anthropic",
            "fresh": {
                "five_hour": {"utilization": 12.0, "resets_at": "2026-11-07T00:00:00Z"},
                "seven_day": {"utilization": 3.0},
            },
        },
        "openai-codex": {
            "stale_id": "openai-codex",
            "fresh": {
                "rate_limit": {
                    "primary_window": {"used_percent": 12, "limit_window_seconds": 18000}
                },
                "plan_type": "Plus",
            },
        },
    }

    def setUp(self):
        super().setUp()
        self.calls = []
        self._saved_claude = getattr(API, "_claude_code_oauth_token", None)
        API._direct_cooldown = {}
        API._HOST_WINNERS.clear()

    def tearDown(self):
        if self._saved_claude is not None:
            API._claude_code_oauth_token = self._saved_claude
        super().tearDown()

    def _stale(self, pid, age_s):
        return {
            "id": pid,
            "status": "ok",
            "stale": True,
            "fetched_at": API._iso_epoch(time.time() - age_s),
            "windows": [{"label": "5h", "percent": 5.0}],
        }

    def _prepare(self, pid):
        self.calls.clear()
        API._claude_code_oauth_token = lambda: "sentinel-token"
        API._read_text = lambda path: '{"tokens": {"access_token": "sentinel-token"}}'
        API._secret = lambda *names: "sentinel-token"

        def direct(url, headers, **kwargs):
            self.calls.append(url)
            return self.PROVIDERS[pid]["fresh"]

        API._http_json = direct

    def _run(self, pid):
        return API.FETCHERS[pid]()

    def _stale_pct(self, pid, age_s, pct):
        payload = self._stale(pid, age_s)
        payload["windows"][0]["percent"] = pct
        return payload

    def _direct_payload(self, pid, pct):
        if pid == "anthropic":
            return {
                "five_hour": {"utilization": pct, "resets_at": "2026-11-07T00:00:00Z"},
                "seven_day": {"utilization": 1.0},
            }
        return {
            "rate_limit": {"primary_window": {"used_percent": pct, "limit_window_seconds": 18000}},
            "plan_type": "Plus",
        }

    def _serve(self, pid, pct, failure=None):
        def call(url, headers, **kwargs):
            self.calls.append(url)
            if failure is not None:
                raise failure
            return self._direct_payload(pid, pct)

        API._http_json = call

    def test_young_stale_makes_no_direct_call(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                API._hermes_usage = lambda provider, pid=pid: self._stale(pid, 9 * 60)
                out = self._run(pid)
                self.assertEqual(self.calls, [], "direct token tried inside 10 minutes")
                self.assertTrue(out.get("stale"))

    def test_old_stale_tries_direct_and_returns_fresh(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                API._hermes_usage = lambda provider, pid=pid: self._stale(pid, 11 * 60)
                out = self._run(pid)
                self.assertEqual(len(self.calls), 1)
                self.assertFalse(out.get("stale"))
                self.assertTrue(out.get("windows"))

    def test_second_poll_inside_the_cooldown_makes_no_call(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                API._hermes_usage = lambda provider, pid=pid: self._stale(pid, 11 * 60)
                self._run(pid)
                self.calls.clear()
                out = self._run(pid)
                self.assertEqual(self.calls, [], "a second direct attempt inside the cooldown")
                self.assertTrue(out.get("stale"))

    def test_attempt_allowed_once_the_cooldown_passes(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                API._hermes_usage = lambda provider, pid=pid: self._stale_pct(pid, 11 * 60, 11)
                self._run(pid)
                hit = API._direct_readings[pid]
                API._direct_readings[pid] = (hit[0] - 11 * 60, hit[1])  # old enough to retry
                API._direct_cooldown[pid] = time.time() - 1
                self.calls.clear()
                self._serve(pid, 77)
                self._run(pid)
                self.assertEqual(len(self.calls), 1)

    def test_direct_failures_return_the_stale_reading(self):
        failures = [
            PermissionError("HTTP 401: credential rejected or entitlement missing"),
            FileNotFoundError("HTTP 404: endpoint not offered for this account"),
            ValueError("non-JSON response (HTTP 200, 12 bytes)"),
            API._Timeout("timeout"),
            API._Skip("no token"),
        ]
        for pid in self.PROVIDERS:
            for failure in failures:
                with self.subTest(pid=pid, failure=type(failure).__name__):
                    self._reset_state()
                    self._prepare(pid)

                    def boom(url, headers, failure=failure, **kwargs):
                        self.calls.append(url)
                        raise failure

                    API._http_json = boom
                    API._hermes_usage = lambda provider, pid=pid: self._stale(pid, 11 * 60)
                    if isinstance(failure, API._Skip):
                        out = self._run(pid)
                    else:
                        with self.assertLogs("provider_usage_api", level="WARNING"):
                            out = self._run(pid)
                    self.assertTrue(out.get("stale"))
                    self.assertEqual(out["windows"][0]["percent"], 5.0)

    def test_a_plain_failure_never_logs_its_text(self):
        pid = "anthropic"
        self._reset_state()
        self._prepare(pid)

        def boom(url, headers, **kwargs):
            raise RuntimeError("reflected SENTINEL-ANTHROPIC-KEY")

        API._http_json = boom
        API._hermes_usage = lambda provider: self._stale(pid, 11 * 60)
        with self.assertLogs("provider_usage_api", level="WARNING") as captured:
            out = self._run(pid)
        self.assertTrue(out.get("stale"))
        self.assertNotIn("SENTINEL-ANTHROPIC-KEY", "\n".join(captured.output))

    def test_429_returns_stale_and_blocks_until_the_reset(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                reset_at = time.time() + 3600  # later than one helper cooldown
                self.calls.clear()

                def limited(url, headers, **kwargs):
                    self.calls.append(url)
                    raise API._RateLimited(reset_at)

                API._http_json = limited
                API._hermes_usage = lambda provider, pid=pid: self._stale(pid, 11 * 60)
                out = self._run(pid)
                self.assertTrue(out.get("stale"))
                self.assertNotIn(pid, API._holds, "a hold replaced the stale reading")
                self.assertGreaterEqual(
                    API._direct_cooldown[pid], reset_at - 1, "the block did not reach the reset"
                )
                self.calls.clear()
                API._hermes_usage = lambda provider, pid=pid: self._stale(pid, 11 * 60)
                self._run(pid)
                self.assertEqual(self.calls, [], "retried before the provider reset")

    def test_no_stale_keeps_the_direct_fallback(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                API._hermes_usage = lambda provider: None
                out = self._run(pid)
                self.assertEqual(len(self.calls), 1)
                self.assertFalse(out.get("stale"))

    def test_no_stale_and_no_token_still_skips(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                API._read_text = lambda path: "{}"
                API._claude_code_oauth_token = lambda: None
                API._hermes_usage = lambda provider: None
                with self.assertRaises(API._Skip):
                    self._run(pid)

    def test_manual_refresh_does_not_bypass_the_direct_cooldown(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                API._hermes_usage = lambda provider, pid=pid: self._stale(pid, 11 * 60)
                self._run(pid)
                self.calls.clear()
                token = API._refresh_flag.set(True)
                try:
                    out = self._run(pid)
                finally:
                    API._refresh_flag.reset(token)
                self.assertEqual(self.calls, [])
                self.assertTrue(out.get("stale"))

    def test_closed_run_writes_no_direct_state(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)

                def boom(url, headers, **kwargs):
                    raise RuntimeError("direct failed")

                API._http_json = boom
                API._hermes_usage = lambda provider, pid=pid: self._stale(pid, 11 * 60)
                run = API._Run()
                run.closed = True
                token = API._collection.set(run)
                try:
                    out = self._run(pid)
                finally:
                    API._collection.reset(token)
                self.assertTrue(out.get("stale"))
                self.assertNotIn(pid, API._direct_cooldown)

    def test_budget_still_bounds_the_direct_request(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                clients = []

                class FakeClient:
                    def __init__(self, **kwargs):
                        clients.append(kwargs)

                    def __enter__(self):
                        return self

                    def __exit__(self, *exc):
                        return False

                    def get(self, url, headers=None):
                        raise AssertionError("a request was made past the budget")

                real_client = API.httpx.Client
                API._http_json = self._saved["http"]  # the real budget-aware function
                API.httpx.Client = FakeClient
                token = API._deadline.set(time.monotonic() - 1)
                try:
                    API._hermes_usage = lambda provider, pid=pid: self._stale(pid, 11 * 60)
                    out = self._run(pid)
                finally:
                    API._deadline.reset(token)
                    API.httpx.Client = real_client
                self.assertTrue(out.get("stale"))
                self.assertEqual(clients, [])

    def test_direct_success_is_not_overwritten_by_the_old_helper_reading(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                self._serve(pid, 77)
                API._hermes_usage = lambda provider, pid=pid: self._stale_pct(pid, 60 * 60, 11)
                first = self._run(pid)
                self.assertFalse(first.get("stale"))
                self.assertEqual(first["windows"][0]["percent"], 77)
                second = self._run(pid)
                self.assertTrue(second.get("stale"))
                self.assertEqual(second["windows"][0]["percent"], 77)

    def test_a_newer_helper_reading_wins_over_a_direct_one(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                self._serve(pid, 77)
                API._hermes_usage = lambda provider, pid=pid: self._stale_pct(pid, 60 * 60, 11)
                self._run(pid)
                hit = API._direct_readings[pid]
                API._direct_readings[pid] = (hit[0] - 5 * 60, hit[1])  # five minutes old
                self.calls.clear()
                API._hermes_usage = lambda provider, pid=pid: self._stale_pct(pid, 60, 42)
                out = self._run(pid)
                self.assertEqual(out["windows"][0]["percent"], 42)
                self.assertTrue(out.get("stale"))
                self.assertEqual(self.calls, [])

    def test_seven_minutes_after_a_direct_read_makes_no_request(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                API._direct_readings[pid] = (time.time() - 7 * 60, self._stale_pct(pid, 0, 77))
                API._hermes_usage = lambda provider, pid=pid: self._stale_pct(pid, 60 * 60, 11)
                out = self._run(pid)
                self.assertEqual(self.calls, [])
                self.assertEqual(out["windows"][0]["percent"], 77)
                self.assertTrue(out.get("stale"))

    def test_eleven_minutes_after_a_direct_read_tries_once(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                self._serve(pid, 77)
                API._direct_readings[pid] = (time.time() - 11 * 60, self._stale_pct(pid, 0, 42))
                API._hermes_usage = lambda provider, pid=pid: self._stale_pct(pid, 60 * 60, 11)
                out = self._run(pid)
                self.assertEqual(len(self.calls), 1)
                self.assertEqual(out["windows"][0]["percent"], 77)
                self.assertFalse(out.get("stale"))

    def test_a_remembered_reading_past_the_six_hour_ceiling_is_dropped(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                self._serve(pid, 77)
                API._direct_readings[pid] = (time.time() - 7 * 3600, self._stale_pct(pid, 0, 42))
                API._hermes_usage = lambda provider: None
                out = self._run(pid)
                self.assertEqual(len(self.calls), 1)
                self.assertEqual(out["windows"][0]["percent"], 77)
                self.assertFalse(out.get("stale"))

    def test_a_remembered_reading_past_the_ceiling_is_not_returned_on_failure(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                self._serve(pid, 77, failure=PermissionError("HTTP 401: credential rejected"))
                API._direct_readings[pid] = (time.time() - 7 * 3600, self._stale_pct(pid, 0, 42))
                API._hermes_usage = lambda provider: None
                with self.assertRaises(PermissionError):
                    self._run(pid)
                self.assertNotIn(pid, API._direct_readings)

    def test_a_closed_run_remembers_nothing(self):
        for pid in self.PROVIDERS:
            with self.subTest(pid=pid):
                self._reset_state()
                self._prepare(pid)
                self._serve(pid, 77)
                API._hermes_usage = lambda provider, pid=pid: self._stale_pct(pid, 60 * 60, 11)
                run = API._Run()
                run.closed = True
                token = API._collection.set(run)
                try:
                    out = self._run(pid)
                finally:
                    API._collection.reset(token)
                self.assertFalse(out.get("stale"))
                self.assertNotIn(pid, API._direct_readings)

    def test_ten_minute_constant(self):
        self.assertEqual(API.STALE_DIRECT_AFTER_S, 600.0)

    def test_helper_timeout_constant(self):
        self.assertEqual(API.HELPER_TIMEOUT_S, 10.0)


class _no_logs:
    """Context manager for paths that must not log (a missing token is normal)."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TimestampTest(Base):
    def test_fetched_at_is_utc_z(self):
        API.FETCHERS["zai"] = lambda: {
            "id": "zai",
            "status": "ok",
            "windows": [{"label": "5h", "percent": 1}],
        }
        out = API._collect()
        self.assertRegex(out["fetched_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_computed_reset_is_rounded_to_the_minute(self):
        resolved = API._iso_from_epoch(1793145034.987)
        self.assertTrue(resolved.endswith(":00Z"))


class RefreshSignalTest(Base):
    def test_manual_refresh_skips_the_snapshot_shortcut(self):
        called = []
        API._cached_snapshot = lambda provider: _snap(age_s=60)
        API._fetch_usage = lambda provider: (called.append(1), None)[1]
        API._hermes_usage("anthropic")
        self.assertEqual(called, [], "scheduled poll should answer from the snapshot")
        API._refresh_flag.set(True)
        try:
            API._hermes_usage("anthropic")
        finally:
            API._refresh_flag.set(False)
        self.assertEqual(called, [1], "manual refresh should read live")

    def test_route_accepts_the_refresh_flag(self):
        import inspect

        params = inspect.signature(API.get_usage).parameters
        self.assertIn("refresh", params)
        self.assertFalse(params["refresh"].default)


class PayloadCacheTest(Base):
    """Gaps only: TTL miss, helper freshness window, cooldown, held rows.

    A TTL hit is already covered by test_warm_cache_answers_during_a_refresh and
    fresh=True by most of this file.
    """

    def test_ttl_hit_returns_the_cache_without_a_collection(self):
        calls = []

        def fetcher():
            calls.append(1)
            return {"id": "zai", "status": "ok", "windows": [{"label": "5h", "percent": 7}]}

        self.use({"zai": fetcher})
        API._cache["payload"] = {"fetched_at": "2026-01-01T00:00:00Z", "providers": []}
        API._cache["at"] = time.time()
        out = API.payload()
        self.assertEqual(calls, [], "a warm cache inside the TTL started a collection")
        self.assertEqual(out["providers"], [])

    def test_ttl_miss_starts_a_new_collection(self):
        calls = []

        def fetcher():
            calls.append(1)
            return {"id": "zai", "status": "ok", "windows": [{"label": "5h", "percent": 7}]}

        self.use({"zai": fetcher})
        API._cache["payload"] = {"fetched_at": "2026-01-01T00:00:00Z", "providers": []}
        API._cache["at"] = time.time() - API.TTL - 1
        out = API.payload()
        self.assertEqual(len(calls), 1)
        self.assertEqual(out["providers"][0]["windows"][0]["percent"], 7)

    def test_helper_snapshot_inside_the_fresh_window_makes_no_call(self):
        called = []
        API._cached_snapshot = lambda provider: _snap(age_s=60)
        API._fetch_usage = lambda provider: (called.append(1), None)[1]
        payload = API._hermes_usage("anthropic")
        self.assertEqual(called, [])
        self.assertEqual(payload["windows"][0]["percent"], 42.0)

    def test_helper_snapshot_past_the_fresh_window_calls_once(self):
        called = []
        API._cached_snapshot = lambda provider: _snap(age_s=API.CACHE_FRESH_S + 60)
        API._fetch_usage = lambda provider: (called.append(1), _snap(age_s=0))[1]
        payload = API._hermes_usage("anthropic")
        self.assertEqual(len(called), 1)
        self.assertEqual(payload["windows"][0]["percent"], 42.0)

    def test_helper_cooldown_skips_the_call(self):
        called = []
        API._fetch_usage = lambda provider: (called.append(1), _snap(age_s=0))[1]
        API._helper_cooldown["anthropic"] = time.time() + 120
        API._hermes_usage("anthropic")
        self.assertEqual(called, [])

    def test_payload_keeps_a_held_provider_with_its_last_reading(self):
        self.use({})
        API._last_good["zai"] = {
            "id": "zai",
            "status": "ok",
            "windows": [{"label": "5h", "percent": 55}],
        }
        API._holds["zai"] = time.time() + 120
        out = API.payload(fresh=True)
        row = {p["id"]: p for p in out["providers"]}["zai"]
        self.assertTrue(row.get("stale"))
        self.assertIn("hold_until", row)
        self.assertEqual(row["windows"][0]["percent"], 55)

    def test_payload_keeps_a_held_provider_without_a_reading(self):
        self.use({})
        API._holds["zai"] = time.time() + 120
        out = API.payload(fresh=True)
        row = {p["id"]: p for p in out["providers"]}["zai"]
        self.assertEqual(row["status"], "error")
        self.assertIn("rate limited until", row["error"])


def _snap(age_s):
    import types
    from datetime import datetime, timedelta, timezone

    snap = types.SimpleNamespace()
    snap.available = True
    snap.fetched_at = datetime.now(timezone.utc) - timedelta(seconds=age_s)
    snap.windows = [types.SimpleNamespace(used_percent=42.0, label="5h", reset_at=None)]
    return snap


if __name__ == "__main__":
    unittest.main()
