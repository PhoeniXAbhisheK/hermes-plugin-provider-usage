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
