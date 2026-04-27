---
description: Apply exact-match token rewrites in place across the project
argument-hint: "[<path-or-directory>]"
---

Run the ui-tokenize fix command. It scans the project (or the specified path) for hardcoded values that exactly match a token's value, and rewrites them in place to use the token reference rendered for each file's surface.

Only **confidence 1.0** matches are auto-fixed. Near-misses are left for human review or the `tokenize__propose` flow.

Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs" fix $ARGUMENTS
```

After the run completes, report which files were modified. Recommend the user inspect the diff before committing.
