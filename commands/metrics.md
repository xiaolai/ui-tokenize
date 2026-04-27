---
description: Print the session ledger — blocks, rewrites, fabrications, escalations
---

Compact the per-PID NDJSON ledger and print the resulting session metrics.

## Steps

1. **Run the metrics printer.**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs" metrics
   ```
   This compacts the per-PID NDJSON files into the canonical `session.json` first, then reads it.
2. **Surface the report to the user verbatim** using the format below. Do not paraphrase the counts; the user uses these numbers to judge whether the catalog needs more tokens.
3. **Interpret signals.** A high `escapesToProposal` count or repeated fabrications indicate the catalog is missing tokens for the values the agent keeps trying to use; recommend `/tokenize:propose` (or direct `tokenize__propose` MCP calls) to close the gap.

## Output format

The CLI prints (in order):

- `Session <session-id>`
- `  started: <iso-8601>`
- `  updated: <iso-8601>`
- `  metrics: <json blob with block / rewrite / escape counts>`
- `  fabrications:` — indented list of token names the agent invented (omitted when empty)
- `  unresolved by file:` — indented `<path>: <count>` lines (omitted when empty)

If no session ledger exists yet, the CLI prints `No session ledger yet.` — surface that line directly.

These counts indicate whether the catalog covers the project's needs (high `escapesToProposal` or repeated fabrications point to catalog gaps).
