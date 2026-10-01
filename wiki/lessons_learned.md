# Lessons Learned

Record only confirmed, reusable, and non-obvious findings.

<!--
## LL-001: Lesson title

- **Date:** YYYY-MM-DD
- **Observed behavior:** What happened
- **Root cause:** Confirmed cause
- **Resolution:** What fixed or mitigated it
- **Prevention:** What should be done differently next time
- **Evidence:** Logs, measurements, code, test, or specification references
- **Related tasks:** [[tasks/task-file]]
-->

## API "success" can be a non-JSON error body
- **Date:** 2026-10-01
- **Status:** Confirmed (2026-10-01, provider-usage live fetch)
- **Trigger:** Adding any HTTP usage endpoint to the plugin fetch layer
- **Lesson:** Some gateways (observed: `api.opencode.ai/zen/v1/usage`) return
  HTTP 200 with a plain-text or HTML error body (`"Not Found"`). Bare
  `json.loads` then raises an opaque decode error. Route every HTTP JSON body
  through `_decode_json_body()` in `dashboard/plugin_api.py`, which validates
  the body looks like JSON and raises a clear `ValueError` naming the
  endpoint otherwise.
- **Scope:** dashboard fetchers; any future provider integration.

## `if not estimate:` treats a legitimate $0 as missing data
- **Date:** 2026-10-01
- **Observed behavior:** Zen month estimate widened to all-time whenever the
  month held only free-model traffic; the card quietly showed stale, wider
  data.
- **Root cause:** `_zen_estimated_cost` returns `None` for "no data" and
  `0.0` for "data costing zero"; `not 0.0` is truthy-false, so the sentinel
  check conflated them.
- **Resolution:** Window selection keys on the month token total (`> 0`) and
  `est is None` separately (`3a5d862`), with a free-month regression test.
- **Prevention:** Any function returning "number or None" must be tested with
  `is None`, never truthiness; make "zero is real data" an explicit acceptance
  criterion.
- **Evidence:** reviewer finding (simplify-code R2) + test
  `test_...free month...` in `tests/test_provider_usage.py`.
- **Related tasks:** [[tasks/LLIKI-002-opencode-zen-balance-chain|LLIKI-002]]

## Dashboard plugin Python is imported once at mount — file syncs are not live
- **Date:** 2026-10-01
- **Observed behavior:** Updated `plugin_api.py`/`plugin.js` produced no
  visible change; the balance looked "stuck" while the estimator itself
  computed correct live values when run standalone.
- **Root cause:** `hermes_cli.web_server` imports the plugin api file at
  dashboard/serve startup; the desktop default poll was also 5 minutes,
  compounding the staleness.
- **Resolution:** Restart Hermes desktop/dashboard after backend plugin
  changes; default poll lowered to 1 minute; verify with a standalone loop
  that reads the module fresh (`zen_balance_loop.py check`).
- **Prevention:** Treat "value not updating" as three separate suspects —
  estimator math, server cache/TTL, UI cadence/process lifetime — and test
  each in isolation before touching code.
- **Evidence:** gui.log mount timestamps vs file sync times; desktop.log 404
  headless-backend errors; standalone probe GREEN while UI looked frozen.
- **Related tasks:** [[tasks/LLIKI-002-opencode-zen-balance-chain|LLIKI-002]]
