<!-- lliki:managed:start id=lliki-contract -->
# CLAUDE.md - Repository Agent Contract

This file defines stable repository-wide behavior for coding agents. It is not
project status or project documentation. Changing project knowledge belongs
under `wiki/`.

## Context Routing

When resuming active local work:

1. Read this stable contract.
2. Read `wiki/tasks/scratchpad.md` first.
3. If the scratchpad identifies an active task, read that task file.
4. Verify the recorded repository snapshot before trusting handover state.
5. Load only the listed focus files and relevant docs.
6. Continue from the exact next action.

For new work, a missing or inactive scratchpad, or a workstream switch:

1. Read this stable contract.
2. Start from `wiki/wiki-index.md`.
3. Use a named folder index (docs-index, tasks-index, or exploratory-index) to find
   relevant context.
4. Read only required pages and repository files.
5. Initialize or replace the scratchpad for the selected active task.

Do not recursively load the entire wiki or repository. Read
`wiki/wiki-rules.md` when maintaining or reorganizing the wiki, creating a new
wiki document type, or when information placement is unclear.

## Active Task Handover

Use `wiki/tasks/scratchpad.md` as the only local handover state. Keep it bounded and
replace obsolete content. Do not keep a terminal transcript, full command
output, or a copy of the task specification.

The scratchpad is local, ignored by Git, non-authoritative, and limited to one
active task and one writing agent per worktree. Parallel tasks should use
separate worktrees.

## Evidence and Scope

Prefer explicit user instructions and repository evidence over assumptions.
Treat measurements, authoritative specifications, source code, accepted
project decisions, and maintained documentation according to the authority
order defined in `wiki/wiki-rules.md`.

Do not invent requirements, hardware values, commands, protected paths,
architecture, task status, build results, or validation outcomes. Mark missing
information as `Unknown`, `TBD`, or `Needs validation`.

Before editing, understand the active task's goal, scope, constraints,
acceptance criteria, and expected evidence. Make the smallest coherent change
that satisfies the request. Avoid unrelated refactors, formatting sweeps,
renames, dependency upgrades, generated-file churn, and cleanup outside scope.
Keep task acceptance criteria stable during execution; record checkpoint
progress in `wiki/tasks/scratchpad.md` instead of adding checkbox churn to the
task file.

Project commands and toolchain procedures belong in
`wiki/docs/development-workflow.md`. Project-specific protected paths, generated
or vendor boundaries, and modification procedures belong in
`wiki/docs/repository-rules.md`. Do not duplicate them here.

## Agent and Skill Usage

Use specialist skills, subagents, or agent tools only when they are available
and materially relevant to the task. Inspect their actual instructions before
using them. Project evidence and the user's intent remain authoritative over
generic specialist guidance.

When the `lliki` CLI is available, agents may use it internally for
mechanical operations such as structural inspection, managed-template checks,
index refresh, safe appends, context routing, and wiki validation.
The
user should not need to invoke these commands during normal development.

## Wiki Updates

The implementing agent owns semantic wiki updates caused by its work.

Review whether a wiki update is needed after meaningful task events and at the
end of each completed user request. When project truth did not change, do not
edit the wiki merely to update a timestamp.

Apply focused changes only:

- update the active task with a concise final result and validation summary;
- append an accepted decision only when a real decision was made;
- append a lesson only when the finding is confirmed and reusable;
- update maintained documentation only when durable project truth changed;
- refresh the generated tasks index when task metadata changed;
- reset `wiki/tasks/scratchpad.md` at task completion.

Detailed ingest, query, lint, promotion, provenance, staleness, and
contradiction rules belong in `wiki/wiki-rules.md`.

## Completion and Reporting

A task is complete when its acceptance criteria are met with traceable evidence,
applicable validation has been performed or omissions are explicit, the diff is
focused, durable project knowledge is current, the task has a concise result
and validation summary, the tasks index is refreshed when
needed, and the
scratchpad is reset.

The final report must identify changed files, validation performed, verified
results, omitted checks, remaining assumptions or risks, and follow-up work.
Never claim a build, flash, test, measurement, or target result that was not
actually performed.
<!-- lliki:managed:end id=lliki-contract -->

## Tool Efficiency

Prefer one deterministic inspection over iterative probing.

Before issuing a third tool call for the same question:

1. summarize what is known;
2. identify the missing fact;
3. construct one bounded command/script that resolves it.

Do not probe ports, paths, files, or endpoints individually when they can be
enumerated and tested in one command. If verification requires more than 3
related shell probes, write a temporary deterministic verification script and
run it once instead.

Do not reread files already read in the current task unless the file changed,
the previous read was partial, or exact evidence is required.

Filter tool output at source: grep only required lines, use head/tail/ranges,
emit counts/status rather than full dumps, and save large diagnostics to a file
returning only the path plus a summary.
