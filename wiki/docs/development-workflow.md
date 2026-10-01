# Development Workflow and Commands

This is the authoritative location for project-specific commands and
environment assumptions. Keep every recorded command executable and verified.

## Prerequisites

- Hermes desktop app (plugin host; `requires_hermes: ">=0.21.0"`).
- Hermes venv Python for backend/tests (system `python3` may be missing on
  this Windows host): `HV="$HOME/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe"`.
- `node` for the desktop JS syntax check; `lliki` CLI for wiki mechanics.
- On Windows the user home may contain a space: quote every path.
  Native tools (git, node, python) need `C:/...` forward-slash paths, not
  MSYS `/c/...` paths.

## Build

No build step. Plugin files (`plugin.yaml`, `dashboard/`, `desktop/`) are
consumed directly by Hermes.

## Test and Static Analysis

Verified 2026-10-01:

- `"$HV" -m unittest discover -s tests` — full suite (also
  `"$HV" -m unittest tests.test_provider_usage`; 12 tests, OK).
- `node --check desktop/plugin.js`
- `"$HV" -m json.tool dashboard/manifest.json`
- `lliki doctor` — wiki lint (expects 0 errors).

## Flash, Run, and Debug

The plugin loads inside the Hermes app; there is no standalone server. The
dashboard API builds its payload in-process; to probe it without the app,
import `dashboard/plugin_api.py` via
`importlib.util.spec_from_file_location` in the Hermes venv and call the
module's `payload()` function.

## Validation Evidence

Task-level results go in the task file's `Validation` / `Result` sections
(e.g. [[tasks/LLIKI-001-opencode-zen-go-billing-split-in-provider-usage|LLIKI-001]]);
live-app verification is tracked on the kanban board (v0.2.0 e2e: card
t_4bbce823).
