---
description: Print the live design-token catalog grouped by category
argument-hint: "[<filter-pattern>]"
---

Print the merged ui-tokenize catalog. Optionally filter token names by a substring pattern.

Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs" catalog $ARGUMENTS
```

Show the result to the user. Group is by token type (color, dimension, etc.). Tokens marked `[primitive]` are sealed from the suggestion engine; `[DEPRECATED]` will not appear in suggestions.
