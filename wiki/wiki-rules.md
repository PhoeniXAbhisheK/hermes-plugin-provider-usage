<!-- lliki:managed:start id=wiki-rules -->
# Wiki Rules

The wiki is derived project knowledge. Repository files, tests, generated
configuration, accepted specifications, and explicit task instructions are the
evidence layer. The root agent contract defines stable agent behavior; this
file defines how project knowledge moves through the wiki.

## Entry Points

- Resume active local work from `wiki/tasks/scratchpad.md`; `wiki/tasks/tasks-index.md`
  routes the current task and lists all tasks by status.
- Start new work or switch workstreams from `wiki/wiki-index.md`.
- Use `wiki/tasks/tasks-index.md` for task navigation and overall status.
- Follow named folder indexes before scanning folders. Never recursively read
  `wiki/**/*.md` unless specifically necessary.

## Folder Index Contract

Every directory inside `wiki/` has one named index:

```text
wiki/wiki-index.md
wiki/<folder>/<folder-name>-index.md
```

- An index answers only "what exists here and where do I go next": links plus
  optional one-token metadata. Never duplicate child content into an index.
- Indexes are collection nodes: they link child folder indexes and documents.
  The tasks index catalogs open and closed task files; closed entries use
  ID-only links to keep navigation cheap. Its generated `## Current Task`
  region routes the single scratchpad-selected task, not history.
- Generated regions sit between
  `<!-- lliki:generated:start id=folder-index -->` markers; manual content
  outside them is preserved. `lliki index` regenerates them
  deterministically without an LLM.
- A new folder such as `wiki/research/` gets `research-index.md` automatically
  on `lliki init`, `lliki update`, or `lliki index`.

## Markdown and Obsidian Format

- Open `wiki/` as the vault root. Folder indexes and generated document links
  use ordinary `[[path/from/vault/root|optional label]]` wikilinks; backlinks
  remain available without plugins. The CLI does not depend on Obsidian.
- Lliki-created task, note, and exploratory documents start with YAML front
  matter delimited by `---` lines. `type` identifies the document where
  applicable; `title`, `created`, `updated`, and `tags` are metadata. Task
  documents also use `id`, `status`, and `priority`. Tags are a YAML list,
  including `[]` when empty. Keep manually authored content outside generated
  regions; no Dataview or Templater syntax is required.

## Navigation Model

New work:

```text
wiki/wiki-index.md -> relevant <folder>-index.md -> relevant document
```

Resumed work:

```text
wiki/tasks/scratchpad.md -> active task -> linked knowledge
```

## Information Placement

Each piece of project knowledge should have one authoritative home.

- Current validated project behavior belongs in `wiki/docs/`.
- Unresolved analysis belongs in `wiki/exploratory/`.
- Work definition and overall task status belong in `wiki/tasks/`.
- Accepted rationale belongs in `wiki/decisions.md`.
- Confirmed reusable findings belong in `wiki/lessons_learned.md`.
- Temporary active execution and handover context belongs in
  `wiki/tasks/scratchpad.md`.
- Task files preserve stable intent and concise final outcomes; do not use them
  as execution logs.

Reference existing knowledge with links instead of copying it into multiple
files.

## Ingest Workflow

Use when authoritative evidence enters the repository: requirements, code or
architecture changes, specifications, errata, completed investigations,
incidents, measurements, test reports, or accepted external constraints.

1. Identify the authoritative source and its scope.
2. Search the existing wiki before creating a new page.
3. Update the one maintained location for each affected fact.
4. Preserve useful source references and validation evidence.
5. Identify contradictions with existing docs, decisions, lessons, or tasks.
6. Update links and indexes only when navigation changed.
7. Do not copy source content wholesale into the wiki.
8. Mark unresolved conclusions as exploratory or `Needs validation`.

## Query Workflow

Use for normal engineering and coding requests.

1. Resume from `wiki/tasks/scratchpad.md` when local active work exists.
2. Otherwise start from `wiki/wiki-index.md`.
3. Read only relevant wiki pages.
4. Verify implementation-sensitive claims against current source code, tests,
   configuration, Git state, or authoritative specifications.
5. Perform the requested work.
6. Record current handover details only in the scratchpad.
7. Promote only validated durable conclusions.
8. Do not update the wiki merely because files were read or commands were run.

## Task Workflow

Task files are stable work specifications plus final outcomes. Keep goal,
background, required behavior, constraints, and acceptance criteria stable
during execution. Do not check off acceptance criteria step by step during
implementation; record temporary progress, current checkpoint, blockers, and
next action in `wiki/tasks/scratchpad.md`.

At completion, update the task status and add only a concise result and
validation summary. Link to `wiki/decisions.md` and `wiki/lessons_learned.md`
when durable rationale or reusable findings were promoted there. Do not create
`wiki/tasks/archive/`. Start a next task only after the current task satisfies
its acceptance criteria, passes required validation, has no unresolved blocker,
and records its final result.

## Scratchpad Workflow

`wiki/tasks/scratchpad.md` is local, ignored, non-authoritative handover
context for one active task and one writing agent per worktree. Keep only the
task reference, current state, one concrete next action, and blocker (or
`None`). Raw session capture, when available, is additional provenance rather
than a substitute for this checkpoint. Parallel tasks use separate worktrees.
Do not store transcripts, copied task specifications, or chronological progress
logs here. Replace stale state; reset after task completion.

## Lint Workflow

Deterministic structural lint is owned by `lliki doctor`. It checks local files
without an LLM, network service, credential, vector store, or embedding system.

Semantic lint is owned by the `review-wiki` prompt. It checks meaning,
freshness, contradictions, evidence, and information placement. Semantic lint
must make focused evidence-supported corrections and must not rewrite the whole
wiki.

## Promotion Workflow

Use at task completion or when a conclusion becomes durable.

1. Verify acceptance criteria and validation evidence.
2. Update the task's overall status, concise final result, and validation
   summary.
3. Promote accepted rationale to `wiki/decisions.md` only when a real decision
   was made.
4. Promote reusable confirmed findings to `wiki/lessons_learned.md`.
5. Update `wiki/docs/` only when current validated project behavior changed.
6. Resolve or clearly mark affected exploratory material.
7. Refresh the generated tasks index when task metadata changed.
8. Reset `wiki/tasks/scratchpad.md` to its inactive template.
9. Do not copy scratchpad history or long evidence dumps into the completed
   task.

## Provenance

For implementation-sensitive or high-impact claims, preserve enough evidence to
recheck the claim. Use lightweight references such as:

```markdown
## Evidence

- Source: `src/...`
- Tests: `tests/...`
- Requirement: `TASK-123` or external specification
- Validated against commit: `abc1234`
- Last reviewed: 2026-08-01
```

Do not require every page to contain every field. Prefer links and exact paths
over copied source text.

## Staleness

- A wiki statement is not authoritative merely because it is newer.
- Verify implementation-sensitive claims against source, tests, configuration,
  or specifications.
- When a page is suspected stale, mark the affected statement or section rather
  than invalidating unrelated content.
- Use `Needs validation` when evidence is incomplete.
- Update `Last reviewed` only after a real evidence-backed review.
- Never create timestamp-only edits.
- Scratchpad snapshots are hints for staleness detection, not authority.

## Contradictions

Use this authority order and do not silently discard material contradictions:

1. Applicable safety, security, and legal constraints.
2. Explicit instructions for the current task.
3. Reproducible measurements and approved hardware evidence.
4. Exact-part authoritative specifications, schematics, and errata.
5. Source code, generated configuration, build configuration, and linker data.
6. Accepted decisions and maintained documentation.
7. Active tasks and confirmed lessons.
8. Exploratory material.
9. Local scratchpad handover.
10. Generic model or skill knowledge.

When claims conflict, identify the conflicting claims and evidence, prefer the
higher-authority evidence when resolvable, correct the maintained page instead
of creating a parallel conflicting page, mark replaced decisions as superseded,
and preserve unresolved conflicts with the evidence required to resolve them.
<!-- lliki:managed:end id=wiki-rules -->
