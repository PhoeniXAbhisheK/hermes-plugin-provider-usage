# Project Overview

## Purpose and Scope

Hermes desktop plugin `provider-usage`: per-provider quota and balance
readout in the desktop status bar and popover. Providers appear only when
their credentials are usable; unconfigured providers are hidden rather than
shown as error cards.

## Target and Architecture

- **Backend:** `dashboard/plugin_api.py` — one fetcher function per provider
  (`fetch_opencode_zen`, `fetch_opencode_go`, ...), registered in
  `PROVIDER_META` / `FETCH_ORDER` / `FETCHERS`; builds the JSON payload
  (quota windows, money rows) consumed by the UI. HTTP JSON bodies go
  through `_decode_json_body()`.
- **Frontend:** `desktop/plugin.js` — status-bar codes and popover rendering;
  `CODE` map assigns short bar labels per provider id.
- **Registration:** `plugin.yaml` and `dashboard/manifest.json` must carry
  the same version.
- **Data sources:** provider HTTP usage endpoints, Hermes
  `auth.json`/config keys, env vars (e.g. `OPENCODE_GO_API_KEY`,
  `OPENCODE_CONSOLE_COOKIE`), Models.dev public pricing
  (`https://models.dev/api.json`), and two read-only local ledgers for Zen
  spend: Hermes `state.db` (`session_model_usage`) and the OpenCode CLI
  `~/.local/share/opencode/opencode.db`.
- Zen/Go billing-split design: [[tasks/LLIKI-001-opencode-zen-go-billing-split-in-provider-usage|LLIKI-001]]
- Zen balance chain (v0.4.0): [[tasks/LLIKI-002-opencode-zen-balance-chain|LLIKI-002]]
  and [[decisions]].

## Current Phase and Durable Constraints

v0.4.0 (`plugin.yaml`) with the Zen balance chain shipped and verified
2026-10-01. Backend is Python stdlib + httpx (already a Hermes dep); SQLite
via read-only URI so no extra deps; tests are stdlib `unittest`. Dashboard
plugin Python is imported once at server mount — restart Hermes after
backend changes. See
[[docs/development-workflow|Development Workflow and Commands]] for the
verified commands.

## Evidence

[[../README|README.md]], `plugin.yaml`, `dashboard/manifest.json`,
`.hermes/plans/2026-10-01_000755-opencode-zen-go-billing-split.md`,
`.hermes/plans/2026-10-01_211000-zen-balance-latency-fixes.md`,
[[tasks/LLIKI-002-opencode-zen-balance-chain|LLIKI-002]].
