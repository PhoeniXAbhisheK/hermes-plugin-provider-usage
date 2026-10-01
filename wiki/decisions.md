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
