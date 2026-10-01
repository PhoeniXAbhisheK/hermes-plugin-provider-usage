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
  `auth.json`/config keys, env vars (e.g. `OPENCODE_GO_API_KEY`), and the
  local OpenCode CLI ledger (`~/.local/share/opencode/opencode.db`) for Zen
  spend.
- Zen/Go billing-split design: [[tasks/LLIKI-001-opencode-zen-go-billing-split-in-provider-usage|LLIKI-001]]
  and [[decisions]].

## Current Phase and Durable Constraints

v0.2.0 (`plugin.yaml`) with the OpenCode Zen/Go split landed; live e2e
verification tracked on kanban card t_4bbce823. Backend is Python stdlib
only (SQLite via read-only URI, no extra deps) so the Hermes venv runs it
as-is; tests are stdlib `unittest`. See
[[docs/development-workflow|Development Workflow and Commands]] for the
verified commands.

## Evidence

[[../README|README.md]], `plugin.yaml`, `dashboard/manifest.json`,
`.hermes/plans/2026-10-01_000755-opencode-zen-go-billing-split.md`,
[[tasks/LLIKI-001-opencode-zen-go-billing-split-in-provider-usage|LLIKI-001]].
