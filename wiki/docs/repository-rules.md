# Repository Rules and Protected Paths

This is the authoritative location for project-specific modification boundaries.

## Protected or Sensitive Paths

- `plugin.yaml` and `dashboard/manifest.json`: version fields must stay
  synchronized on every release change; `requires_hermes` gates the plugin.
- `dashboard/manifest.json` is strict JSON — validate with
  `python -m json.tool` after edits.
- `desktop/plugin.js` is host-loaded by Hermes with no build step; syntax is
  the only gate (`node --check`).
- Managed contract blocks in `AGENTS.md` / `CLAUDE.md`
  (`<!-- lliki:managed:start id=... -->` ... `:end`): rewrite only via
  `lliki templates sync`, never by hand.
- Generated indexes (`wiki/*/**-index.md`): rewrite only via `lliki index`,
  never by hand.
- `wiki/tasks/scratchpad.md`: local handover state, Git-ignored, bounded,
  never a transcript or copied specification.
- `.hermes/` (plans) and `media/` (README screenshots): repository-owned
  artifacts; add to them only as part of a task, don't reformat existing
  files.

## Modification Procedures

- Any backend/fetcher change: run the unittest suite, `node --check` on the
  desktop JS, `python -m json.tool` on the manifest, and `lliki doctor`
  (0 errors) before considering the change done.
- Version bumps touch `plugin.yaml` and `dashboard/manifest.json` together.
- New wiki docs: place per `wiki/wiki-rules.md`; after writing,
  `lliki templates check` and `lliki doctor`; the `NEEDS_CONTEXT`
  placeholder banner comes off only once sections are evidence-backed.
  (Do not quote the banner's full literal marker in prose — `lliki doctor`
  matches it raw and reports the doc as `needs-context`.)
- Task metadata changes (status, task_type, refs) require `lliki index`
  before completion.

## Repository Structure and Ownership

- `dashboard/` — Python API payload builder (backend fetchers + manifest).
- `desktop/` — plugin.js UI (status bar, popover).
- `tests/` — stdlib unittest suite for the backend.
- `wiki/` — project knowledge owned by the implementing agent (see
  `CLAUDE.md` Wiki Updates).
- `media/` — screenshots referenced by `README.md`.
- `plugin.yaml`, `README.md`, `IDEA.md` — top-level plugin identity/docs.

## Prohibited Changes

- Hand-editing managed blocks or generated indexes.
- Adding third-party runtime dependencies to the backend (stdlib-only
  design; SQLite is accessed via the stdlib `sqlite3` module).
- Recording secrets, API keys, or token values anywhere in the repository —
  usage data is display-only.
- Credential-probing live provider endpoints during wiki updates
  (redaction-safety incident on kanban card t_4bbce823).

## Validation Evidence

`lliki doctor` reports 0 errors / 0 needs-context warnings after these docs
were filled (2026-10-01).
