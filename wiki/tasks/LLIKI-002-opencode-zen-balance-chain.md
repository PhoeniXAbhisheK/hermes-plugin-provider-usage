---
id: "LLIKI-002"
type: task
title: "OpenCode Zen balance chain: cookie RPC, ledger estimate, honest zero"
status: completed
priority: normal
created: "2026-10-01"
updated: "2026-10-01"
tags: ["provider-usage", "opencode-zen"]
---

# Goal

Make the OpenCode Zen card show a truthful **Balance** even though Zen
exposes no public billing API: live USD when a console cookie is configured,
an estimated-cost fallback grounded in real token counts and public pricing,
and correct window semantics (month, widening to all-time only when the month
is genuinely empty).

# Context

`api.opencode.ai/zen/v1/usage` and every probed billing endpoint return
404/403/soft-404; the console device OAuth flow is server-disabled (403); the
CLI auth store carries no console token. The only live path is the login-gated
SolidStart RPC at `opencode.ai/_server` (`queryBillingInfo`), reachable with a
browser session cookie (`OPENCODE_CONSOLE_COOKIE`). User rejected showing a
dishonest `balance=0`; accepted the cookie-scrape fragility.

Second discovery during live work: the CLI ledger (`opencode.db`) only
records CLI sessions, so it reported $0 while real Hermes Zen traffic sat in
Hermes' own `state.db` (`session_model_usage`, `billing_provider =
'opencode-zen'`). The two ledgers are disjoint by session id, so they are
summed without double-count risk.

# Acceptance Criteria

- Cookie present: live USD balance via the console RPC (balance ÷ 1e8).
- No cookie: cost estimated from both ledgers x Models.dev per-1M pricing
  (`https://models.dev/api.json?type=all`, 15-min TTL cache, stale-on-error).
- Free/zero-cost month with real token traffic shows `0.0 (month)`, never a
  silent all-time widening; widening happens only when the month has no Zen
  tokens at all.
- Models.dev unreachable: raw token count under a `tokens` currency.
- No provider error body (which may echo a rejected credential) reaches the
  UI; HTTP failures report status/byte-shape only.
- Ledger scan happens once per request; sqlite failures are logged, not
  swallowed silently.

# Implementation

Commits on `main`: `21b12a4` (console RPC balance), `0d63a20` (docs/v0.4.0),
`ea89cb8` (Balance label + token fallback), `83bfdf9` (Models.dev estimator),
`4f2a62f` + `0b2c183` (Hermes state.db ledger, two-ledger merge, group-by
fix), `176d481` (credential-echo security fix), `3a5d862` (single scan,
honest zero, 1-min poll), `41d7177` (narrow catalog exception, shared
`_ro_uri`). Key sites: `dashboard/plugin_api.py` `fetch_opencode_zen`,
`_zen_ledger_rows`, `_zen_estimated_cost`, `_fetch_models_dev_catalog`,
`_zen_console_balance`; `desktop/plugin.js` `$interval`, `tokens` formatter.

# Validation

- `tests/test_provider_usage.py`: 39/39 OK (Hermes venv Python), including
  free-month regression, credential-echo regression, all-time-widening.
- Live loop (`zen_balance_loop.py check`): ledger 26 Zen rows / 66.5M tokens
  this month -> plugin `Balance 4.35 USD, source: models.dev estimate
  (month)`; re-measured ~19 min later, up from 3.98 — balance tracks traffic.
- `hermes plugins validate` (15 checks, security scan: safe) and
  `hermes plugins doctor` OK on the installed copy.
- Installed plugin dir byte-identical to repo; `__pycache__` cleared on each
  sync.

# Result

Done 2026-10-01, shipped as v0.4.0. Known limits documented in README "Spend
tracking": without the cookie the card shows cumulative estimated spend under
the Balance label; the console RPC is reverse-engineered and its server-fn
content hash rotates on OpenCode deploys (silent fallback to the estimate);
Hermes must be restarted after backend code changes — the dashboard process
imports `plugin_api.py` once at mount.
