# Hermes Compression and Agent Config

Last reviewed: 2026-10-01

Durable record of the Hermes host settings applied to this machine's
`$HERMES_HOME/config.yaml` on 2026-10-01 for context-compression and
agent-loop behavior. These are host-level settings, not repository
configuration; the file is the authority and this page records the intent.

## Applied Values

| Key | Value | Effect |
| --- | --- | --- |
| `compression.proactive_prune_tokens` | `48000` | Prune oversized tool results from context once the session exceeds this many tokens. |
| `compression.protect_first_n` | `0` | No protected head messages; early context is prunable. |
| `compression.protect_last_n` | `12` | Last 12 messages are never compressed away. |
| `compression.min_tail_user_messages` | `2` | Always keep at least 2 recent user messages verbatim. |
| `compression.idle_compact_after_seconds` | `1800` | Auto-compact after 30 minutes idle. |
| `auxiliary.compression.reasoning_effort` | `none` | Compression summarizer runs with no reasoning effort (cheaper, faster). |
| `agent.max_turns` | `60` | Hard cap of 60 tool-use turns per agent run. |

Pre-existing unchanged context: `compression.enabled: true`,
`threshold: 0.5`, `target_ratio: 0.2`, `agent.reasoning_effort: medium`.

## Evidence

- Source: `$HERMES_HOME/config.yaml`
  (lines for `agent.max_turns`, `compression.*`, `auxiliary.compression`)
- Backup of prior state: `$HERMES_HOME/config.yaml.bak-<timestamp>`
- Validated by re-reading config.yaml on 2026-10-01.

## Related

- [[docs/development-workflow|Development Workflow and Commands]] — Hermes
  venv and tool paths used to verify these settings.
