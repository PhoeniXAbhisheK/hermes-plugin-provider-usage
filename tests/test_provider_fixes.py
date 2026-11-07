"""Tests for the Step 4b provider fixes.

Every value here is invented. The network is replaced by a fake ``_http_json``
and the secret scope by a fake ``_secret``; both are restored in tearDown.
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

CODING_URL = "https://api.kimi.com/coding/v1/usages"
AI_URL = "https://api.moonshot.ai/v1/users/me/balance"
CN_URL = "https://api.moonshot.cn/v1/users/me/balance"
MINIMAX_CN_API = "https://api.minimaxi.com/v1/token_plan/remains"
MINIMAX_CN_WWW = "https://www.minimax.cn/v1/token_plan/remains"
MINIMAX_GLOBAL_API = "https://api.minimax.io/v1/token_plan/remains"
MINIMAX_GLOBAL_WWW = "https://www.minimax.io/v1/token_plan/remains"
MINIMAX_OK = {"model_remains": [{"current_interval_remaining_percent": 50}]}


class Base(unittest.TestCase):
    def setUp(self):
        self._http = API._http_json
        self._secret = API._secret
        self.calls = []
        API._HOST_WINNERS.clear()

    def tearDown(self):
        API._http_json = self._http
        API._secret = self._secret
        API._HOST_WINNERS.clear()

    def route(self, table):
        """Answer from a url -> body or Exception table; anything else is a 404."""

        def fake_http(url, headers, **kwargs):
            self.calls.append(url)
            answer = table.get(url)
            if answer is None:
                raise FileNotFoundError("HTTP 404: endpoint not offered for this account")
            if isinstance(answer, Exception):
                raise answer
            return answer

        API._http_json = fake_http

    def secrets(self, **values):
        API._secret = lambda *names: values.get(names[0])


class MoonshotCurrencyTest(Base):
    def _usage(self, table):
        self.secrets(KIMI_API_KEY="sentinel")
        self.route(table)
        return API.fetch_kimi()

    def test_the_international_host_is_usd(self):
        p = self._usage(
            {
                CODING_URL: PermissionError("HTTP 401"),
                AI_URL: {"data": {"available_balance": 18.02}},
            }
        )
        self.assertEqual(p["money"][0]["cur"], "USD")

    def test_the_china_host_is_cny(self):
        p = self._usage(
            {
                CODING_URL: PermissionError("HTTP 401"),
                AI_URL: PermissionError("HTTP 401"),
                CN_URL: {"data": {"available_balance": 18.02}},
            }
        )
        self.assertEqual(p["money"][0]["cur"], "CNY")

    def test_currency_follows_the_host_that_answers_after_a_cn_win(self):
        self._usage(
            {
                CODING_URL: PermissionError("HTTP 401"),
                AI_URL: PermissionError("HTTP 401"),
                CN_URL: {"data": {"available_balance": 1.0}},
            }
        )
        self.calls.clear()
        p = self._usage(
            {
                CODING_URL: PermissionError("HTTP 401"),
                AI_URL: {"data": {"available_balance": 2.0}},
                CN_URL: PermissionError("HTTP 401"),
            }
        )
        # The remembered CN host is tried first, then the international one
        # answers, and the currency follows the answer rather than the order.
        self.assertEqual(self.calls, [CODING_URL, CN_URL, AI_URL])
        self.assertEqual(p["money"][0]["cur"], "USD")


class MinimaxHostsTest(Base):
    def test_the_cn_family_falls_back_from_api_to_www(self):
        self.secrets(MINIMAX_CN_API_KEY="sentinel")
        self.route(
            {
                MINIMAX_CN_API: FileNotFoundError("HTTP 404"),
                MINIMAX_CN_WWW: MINIMAX_OK,
            }
        )
        p = API.fetch_minimax()
        self.assertEqual(self.calls, [MINIMAX_CN_API, MINIMAX_CN_WWW])
        self.assertEqual(p["windows"][0]["percent"], 50.0)

    def test_the_global_family_falls_back_from_api_to_www(self):
        self.secrets(MINIMAX_API_KEY="sentinel")
        self.route(
            {
                MINIMAX_GLOBAL_API: FileNotFoundError("HTTP 404"),
                MINIMAX_GLOBAL_WWW: MINIMAX_OK,
            }
        )
        p = API.fetch_minimax()
        self.assertEqual(self.calls, [MINIMAX_GLOBAL_API, MINIMAX_GLOBAL_WWW])
        self.assertEqual(p["windows"][0]["percent"], 50.0)

    def test_hosts_are_listed_api_before_www(self):
        self.assertEqual(API.MINIMAX_CN_URLS, (MINIMAX_CN_API, MINIMAX_CN_WWW))
        self.assertEqual(API.MINIMAX_GLOBAL_URLS, (MINIMAX_GLOBAL_API, MINIMAX_GLOBAL_WWW))


class OpenrouterCreditsTest(Base):
    def _run(self, table):
        self.secrets(OPENROUTER_API_KEY="sentinel")
        self.route(table)
        return API.fetch_openrouter()

    def test_a_denied_balance_keeps_the_key_cap(self):
        p = self._run(
            {
                "https://openrouter.ai/api/v1/key": {"data": {"limit": 20, "usage": 5}},
                "https://openrouter.ai/api/v1/credits": PermissionError("HTTP 403"),
            }
        )
        self.assertEqual([row["label"] for row in p["money"]], ["Key cap"])
        self.assertEqual(p["money"][0]["left"], 15.0)

    def test_a_denied_balance_without_a_cap_is_an_error(self):
        with self.assertRaises(API._ProviderError) as caught:
            self._run(
                {
                    "https://openrouter.ai/api/v1/key": {"data": {}},
                    "https://openrouter.ai/api/v1/credits": PermissionError("HTTP 403"),
                }
            )
        self.assertEqual(str(caught.exception), "OpenRouter: balance needs a management key")

    def test_a_rate_limited_balance_still_propagates(self):
        with self.assertRaises(API._RateLimited):
            self._run(
                {
                    "https://openrouter.ai/api/v1/key": {"data": {"limit": 20, "usage": 5}},
                    "https://openrouter.ai/api/v1/credits": API._RateLimited(time.time() + 60),
                }
            )

    def test_a_timed_out_balance_still_propagates(self):
        with self.assertRaises(API._Timeout):
            self._run(
                {
                    "https://openrouter.ai/api/v1/key": {"data": {"limit": 20, "usage": 5}},
                    "https://openrouter.ai/api/v1/credits": API._Timeout(),
                }
            )


class KimiUsageTest(Base):
    def _run(self, payload):
        self.secrets(KIMI_API_KEY="sentinel")
        self.route({CODING_URL: payload})
        return API.fetch_kimi()

    def test_string_numbers_are_read(self):
        p = self._run(
            {
                "usage": {"limit": "100", "used": "26", "resetTime": "2026-02-11T17:32:50Z"},
                "limits": [
                    {
                        "window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
                        "detail": {"limit": "100", "used": "15"},
                    }
                ],
            }
        )
        self.assertEqual([row["label"] for row in p["windows"]], ["Weekly", "5h"])
        self.assertEqual([row["percent"] for row in p["windows"]], [26.0, 15.0])

    def test_a_missing_used_falls_back_to_remaining(self):
        p = self._run({"usage": {"limit": "100", "remaining": "74"}})
        self.assertEqual(p["windows"][0]["percent"], 26.0)

    def test_no_used_and_no_remaining_makes_no_row(self):
        p = self._run(
            {
                "usage": {"limit": "100"},
                "limits": [{"percentage": "40", "window": "5h"}],
            }
        )
        self.assertEqual([row["label"] for row in p["windows"]], ["5h"])

    def test_an_unknown_unit_uses_the_detail_name(self):
        p = self._run(
            {
                "limits": [
                    {
                        "window": {"duration": 3, "timeUnit": "TIME_UNIT_FORTNIGHT"},
                        "detail": {"limit": "10", "used": "4", "name": "Burst"},
                    }
                ]
            }
        )
        self.assertEqual(p["windows"][0]["label"], "Burst")
        self.assertEqual(p["windows"][0]["percent"], 40.0)

    def test_a_zero_limit_is_skipped(self):
        p = self._run(
            {
                "usage": {"limit": "100", "used": "26"},
                "limits": [{"detail": {"limit": "0", "used": "5"}}],
            }
        )
        self.assertEqual([row["label"] for row in p["windows"]], ["Weekly"])

    def test_the_flat_path_still_works(self):
        p = self._run(
            {
                "limits": [
                    {
                        "percentage": "40",
                        "window": "Weekly",
                        "name": "Ignored",
                        "resetTime": "2026-02-07T12:32:50Z",
                    }
                ]
            }
        )
        row = p["windows"][0]
        self.assertEqual((row["label"], row["percent"]), ("Weekly", 40.0))
        self.assertEqual(row["resets_at"], "2026-02-07T12:32:50Z")

    def test_a_non_string_reset_becomes_none(self):
        p = self._run({"usage": {"limit": "100", "used": "26", "resetTime": 12345}})
        self.assertIsNone(p["windows"][0]["resets_at"])

    def test_a_usage_reset_at_is_accepted(self):
        p = self._run(
            {
                "usage": {
                    "limit": "100",
                    "used": "26",
                    "reset_at": "2026-02-11T17:32:50Z",
                }
            }
        )
        self.assertEqual(p["windows"][0]["resets_at"], "2026-02-11T17:32:50Z")

    def test_a_limit_detail_reset_at_is_accepted(self):
        p = self._run(
            {
                "limits": [
                    {
                        "window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
                        "detail": {
                            "limit": "100",
                            "used": "15",
                            "reset_at": "2026-02-07T12:32:50Z",
                        },
                    }
                ]
            }
        )
        self.assertEqual(p["windows"][0]["resets_at"], "2026-02-07T12:32:50Z")

    def test_a_flat_reset_time_is_accepted(self):
        p = self._run(
            {
                "limits": [
                    {
                        "percentage": "40",
                        "window": "Weekly",
                        "reset_time": "2026-02-07T12:32:50Z",
                    }
                ]
            }
        )
        self.assertEqual(p["windows"][0]["resets_at"], "2026-02-07T12:32:50Z")

    def test_hour_unit_labels_five_hours(self):
        p = self._run(
            {
                "limits": [
                    {
                        "window": {"duration": 5, "timeUnit": "TIME_UNIT_HOUR"},
                        "detail": {"limit": "100", "used": "15"},
                    }
                ]
            }
        )
        self.assertEqual(p["windows"][0]["label"], "5h")

    def test_day_unit_labels_seven_days(self):
        p = self._run(
            {
                "limits": [
                    {
                        "window": {"duration": 7, "timeUnit": "TIME_UNIT_DAY"},
                        "detail": {"limit": "100", "used": "15"},
                    }
                ]
            }
        )
        self.assertEqual(p["windows"][0]["label"], "Weekly")

    def test_bare_minute_unit_labels_five_hours(self):
        p = self._run(
            {
                "limits": [
                    {
                        "window": {"duration": 300, "timeUnit": "MINUTE"},
                        "detail": {"limit": "100", "used": "15"},
                    }
                ]
            }
        )
        self.assertEqual(p["windows"][0]["label"], "5h")

    def test_bare_hour_and_day_units(self):
        p = self._run(
            {
                "limits": [
                    {
                        "window": {"duration": 5, "timeUnit": "HOUR"},
                        "detail": {"limit": "100", "used": "15"},
                    },
                    {
                        "window": {"duration": 7, "timeUnit": "DAY"},
                        "detail": {"limit": "100", "used": "15"},
                    },
                ]
            }
        )
        self.assertEqual([row["label"] for row in p["windows"]], ["5h", "Weekly"])

    def test_thirty_days_is_monthly(self):
        p = self._run(
            {
                "limits": [
                    {
                        "window": {"duration": 30, "timeUnit": "TIME_UNIT_DAY"},
                        "detail": {"limit": "100", "used": "15"},
                    }
                ]
            }
        )
        self.assertEqual(p["windows"][0]["label"], "Monthly")


if __name__ == "__main__":
    unittest.main()
