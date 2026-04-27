---
description: Queue a token proposal when no existing token fits
argument-hint: "<value> \"<intent>\""
---

User-facing wrapper around the `tokenize__propose` MCP tool. Append the value + intent to `tokens.proposed.json` and return a temporary `__proposed.*` name.

Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs" propose $ARGUMENTS
```

The temporary name is usable immediately in any source file (the PreToolUse hook recognizes the `__proposed.*` namespace). The proposal stays `pending` in `tokens.proposed.json` until a maintainer reviews it.

Note: in agent flows, prefer calling the `tokenize__propose` MCP tool directly — it is the first-class autonomous-recovery channel. This slash command is for human-driven proposals.
