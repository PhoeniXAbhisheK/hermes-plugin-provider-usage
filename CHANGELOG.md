# Changelog

## 0.4.0

- **OpenCode Zen card shows live USD Balance.** Zen has no key-authenticated
  balance API (upstream anomalyco/opencode#10447/#10448/#44189), so the number
  is scraped read-only from the login-gated console billing RPC
  (`GET https://opencode.ai/_server`, SolidStart server-fn; port of openusage's
  `console_rpc.go`), authenticated with a user-supplied `auth` session cookie
  set as `OPENCODE_CONSOLE_COOKIE` in the Hermes `.env`. The console workspace
  id auto-discovers from `opencode.db` (override: `OPENCODE_WORKSPACE_ID`). On
  success the card returns the same Balance money row the panel renders for
  Kimi. Known limitations by design: the cookie expires (re-paste) and the
  pinned server-fn hash rotates after OpenCode deploys — in both cases the
  card automatically falls back to the previous month-to-date ledger Spend
  readout, never a blank or an error.

## 0.3.0

- **Anthropic card via Claude Code OAuth fallback.** `fetch_anthropic()` now
  falls back to the Claude Code OAuth token in `~/.claude/.credentials.json`
  when Hermes' account-usage helper cannot run (desktop plugin host): GET
  `https://api.anthropic.com/api/oauth/usage` with `anthropic-beta:
  oauth-2025-04-20`, parsing the `five_hour` / `seven_day` ratio windows into
  5h/7d percent + reset rows (same semantics as the Copilot ratio windows; no
  money rows). A missing or malformed credentials file surfaces as the
  in-band error "Claude Code credentials not found" — never an exception that
  blanks the panel.
- **Kimi/Moonshot card works with international accounts.** `fetch_kimi()`
  resolves `KIMI_API_KEY` or `MOONSHOT_API_KEY`, probes the international
  platform `https://api.moonshot.ai/v1/users/me/balance` first and falls back
  to `api.moonshot.cn`, and parses the nested `data.available_balance` (CNY)
  shape (the legacy flat `available` key is kept as a fallback).
- **OpenCode Zen spend limitation documented (plan A).** Zen spend still comes
  from the read-only OpenCode CLI ledger at `~/.local/share/opencode/opencode.db`
  (current-month window); the README gains a "Spend tracking" section
  explaining that the ledger is written only when the `opencode` CLI runs, so
  spend is stale when usage goes through Hermes desktop, and that OpenCode Go
  (subscription) is intentionally hidden from the spend readout. No data-source
  change.

## 0.2.0

- OpenCode Zen and Go registered as separate providers, with distinct status
  bar codes.
- Zen spend read from the local OpenCode CLI ledger (`session.cost` sums for
  provider `opencode`, month to date).
- JSON-body guard on provider HTTP responses.
