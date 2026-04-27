---
description: Queue a token proposal when no existing token fits
argument-hint: "<value> \"<intent>\""
---

User-facing wrapper around the `tokenize__propose` MCP tool. Append the value + intent to `tokens.proposed.json` and return a temporary `__proposed.*` name.

## Steps

1. **Validate arguments.** If `$ARGUMENTS` is empty or missing the intent string, stop and tell the user the required form: `/tokenize:propose <value> "<intent>"`. Do not run the CLI.
2. **Run the proposer.**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs" propose $ARGUMENTS
   ```
3. **Surface the result.** Print the temporary `__proposed.*` name and the path to `tokens.proposed.json` so the user can use the name immediately and review the queued entry.

## Output format

Three lines, in this order:

- `Proposed: <id>` — the proposal id (e.g. `prop_2026-04-27_001`)
- `Use: __proposed.<name>` — the temporary token name, usable in source files
- `File: <absolute path>/tokens.proposed.json` — where the proposal was queued

The temporary name is usable immediately in any source file (the PreToolUse hook recognizes the `__proposed.*` namespace). The proposal stays `pending` until a maintainer reviews it.

Note: in agent flows, prefer calling the `tokenize__propose` MCP tool directly — it is the first-class autonomous-recovery channel. This slash command is for human-driven proposals.
