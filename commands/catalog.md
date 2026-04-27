---
description: Print the live design-token catalog grouped by category
argument-hint: "[<filter-pattern>]"
---

Print the merged ui-tokenize catalog. Optionally filter token names by a substring pattern.

## Steps

1. **Run the catalog printer.**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs" catalog $ARGUMENTS
   ```
2. **Show the result to the user verbatim.** Tokens marked `[primitive]` are sealed from the suggestion engine; `[DEPRECATED]` will not appear in suggestions — keep both labels visible so the user understands what is and is not a viable target.

## Output format

One section per token type (color, dimension, radius, shadow, duration, other), each in this shape:

```
## <type>
  <token.name>                           <value>[ [primitive]][ [DEPRECATED]]
```

Tokens are alphabetically sorted within their type. If `<filter-pattern>` is passed, only token names containing that substring appear. If the catalog is empty, the CLI prints `No tokens. Run /tokenize:init.` — surface that line directly.
