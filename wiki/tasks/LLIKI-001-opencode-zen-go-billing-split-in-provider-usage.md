---
id: "LLIKI-001"
type: task
title: "OpenCode Zen/Go billing split in Provider Usage"
status: completed
priority: normal
created: "2026-10-01"
updated: "2026-10-01"
tags: ["provider-usage"]
---

# Goal

Replace the single broken "OpenCode Zen / Go" card with two correctly
classified cards: **OpenCode Zen** showing actual dollar spend only (metered
API, calendar month to date), and **OpenCode Go** showing session quota
windows and hiding silently when the account has no Go subscription. Harden
the fetch layer against the two observed OpenCode failure modes.

# Context

Plan of record: `.hermes/plans/2026-10-01_000755-opencode-zen-go-billing-split.md`.
Kanban cards: t_1e9eb3dd (backend, done), t_ae7bac0a (desktop/manifest, done),
t_4bbce823 (live e2e verification, running as of this snapshot).

Original bug: a Zen API key was sent to the Go usage endpoint (wrong
auth.json fallback), producing a 403 error card; and
`api.opencode.ai/zen/v1/usage` answers HTTP 200 with the literal text
`"Not Found"`, producing JSON decode errors. OpenCode Zen exposes no spend
HTTP API, so cost is read from the local OpenCode CLI ledger.

# Acceptance Criteria

- `fetch_opencode_zen()` returns a single `money` row `Spend (month)` (USD)
  summed from `~/.local/share/opencode/opencode.db` (`session.cost`, provider
  `opencode`, calendar month to date), opened read-only.
- `fetch_opencode_go()` resolves only a real Go key (`opencode-go` entry /
  `OPENCODE_GO_API_KEY`), treats 403 as no-entitlement and skips the
  provider, and skips when no window carries a numeric `percent`.
- `_decode_json_body()` raises a clear `ValueError` on non-JSON bodies
  (catch-all `"Not Found"`, HTML).
- Both ids registered in `PROVIDER_META` / `FETCH_ORDER` / `FETCHERS`;
  `desktop/plugin.js` has distinct bar codes `zen` and `go`.
- Stdlib unittest suite (`tests/test_provider_usage.py`) passes with the
  Hermes venv Python.
- Version bumped to 0.2.0 in `plugin.yaml` and `dashboard/manifest.json`.
- Subscription providers (`anthropic`, `openai-codex`) unaffected: quota
  windows, never money rows.

# Implementation

Committed on `main`: `f2243d4` (separate provider registration), `3216093`
(desktop bar codes), `ff52e4b` (month-to-date spend from local ledger),
`7347462` (Go-key-only auth, 403 hides card), `858d5a6` (v0.2.0 release,
JSON-body guard). Key sites: `dashboard/plugin_api.py:172`
(`fetch_opencode_go`), `:218` (`_opencode_db_uri`), `:232`
(`fetch_opencode_zen`), `desktop/plugin.js:106-107` (`CODE` map).

# Validation

- 2026-10-01: `"python -m unittest tests.test_provider_usage"` (Hermes venv
  Python) — 12 tests, OK.
- `node --check desktop/plugin.js` OK; `dashboard/manifest.json` parses.
- Live payload probe and ledger cross-check: owned by running kanban card
  t_4bbce823 — record its result here when it completes. `Needs validation`
  until then.

# Result

Closed 2026-10-01. Zen/Go split shipped in v0.2.0 (`858d5a6`); live
verification (t_4bbce823) and its follow-ups completed. Superseded scope:
the `Spend (month)` ledger design was replaced by the Balance/estimate chain
in v0.4.0 — see [[tasks/LLIKI-002-opencode-zen-balance-chain|LLIKI-002]] and
DEC entries in [[decisions]].
