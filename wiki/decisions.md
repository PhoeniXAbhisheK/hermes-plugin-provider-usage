# Architecture Decision Log

This file is append-only. Supersede decisions; do not erase history.

<!--
## DEC-001: Decision title

- **Date:** YYYY-MM-DD
- **Status:** Proposed | Accepted | Rejected | Superseded
- **Context:** Why a decision was required
- **Options considered:** Alternatives evaluated
- **Decision:** What was decided
- **Consequences:** Benefits, costs, constraints, and follow-up work
- **Evidence:** Datasheet, measurement, code, test, or analysis references
- **Related tasks:** [[tasks/task-file]]
-->

## Zen spend comes from the local OpenCode ledger, not an HTTP API
- **Date:** 2026-10-01
- **Status:** Accepted
- **Context:** OpenCode Zen is a metered (pay-per-use) API but exposes no
  spend endpoint; `api.opencode.ai/zen/v1/usage` answers HTTP 200 with the
  literal text `"Not Found"`. The previous card sent the Zen key to the Go
  usage endpoint and produced a 403 error card.
- **Decision:** Show Zen cost as `Spend (month)` (USD) summed from the local
  OpenCode CLI ledger at `~/.local/share/opencode/opencode.db`
  (`session.cost`, provider `opencode`, calendar month to date), opened
  read-only via SQLite URI. `fetch_opencode_go()` resolves only a real Go
  key (`opencode-go` entry / `OPENCODE_GO_API_KEY`); a 403 means no Go
  entitlement and hides the card instead of erroring.
- **Consequences:** Zen numbers reflect what the OpenCode CLI recorded
  locally, not provider-side billing truth; a machine without the CLI ledger
  shows no Zen spend. The card set stays honest by hiding providers the user
  does not have rather than rendering error states.

## Zen Balance is a cookie-RPC/estimate chain, not a public API
- **Date:** 2026-10-01
- **Status:** Accepted (supersedes the CLI-ledger-only design of the previous
  entry)
- **Context:** Zen has no spend/balance HTTP API; all eight probed endpoints
  404/403, the console device OAuth flow is server-disabled, and the CLI auth
  store carries no console token. The CLI ledger alone reported $0 while real
  Hermes Zen traffic lived in Hermes' `state.db`.
- **Decision:** Three-tier chain: (1) live USD via the login-gated console
  RPC `queryBillingInfo` when `OPENCODE_CONSOLE_COOKIE` is set; (2) estimated
  cost = tokens from BOTH ledgers (Hermes `session_model_usage` + CLI
  `session`, disjoint by session id) x public Models.dev per-1M pricing,
  month window keyed on month token total, widening to all-time only when the
  month is empty; (3) raw token count when Models.dev is unreachable. Label
  stays "Balance"; README documents that tiers 2/3 are cumulative spend.
- **Consequences:** Accurate number for all users without a cookie;
  cookie-path fragility accepted (server-fn hash rotates on OpenCode deploys,
  silent fallback); an extra read-only dependency on Hermes' own state.db;
  `estimated_cost_usd` in state.db is unusable for Zen (no pricing entry,
  stores 0) so cost is recomputed from tokens.
- **Evidence:** live probe 4.35 USD (month) with 26 Zen rows / 66.5M tokens;
  39/39 tests; commits `21b12a4..41d7177`.
- **Related tasks:** [[tasks/LLIKI-002-opencode-zen-balance-chain|LLIKI-002]]
