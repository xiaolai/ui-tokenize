---
description: Apply exact-match token rewrites in place across the project
argument-hint: "[<path-or-directory>]"
---

Run the ui-tokenize fix command. It scans the project (or the specified path) for hardcoded values that exactly match a token's value, and rewrites them in place to use the token reference rendered for each file's surface.

Only **confidence 1.0** matches are auto-fixed. Near-misses are left for human review or the `tokenize__propose` flow.

## Steps

1. **Run the fixer.**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs" fix $ARGUMENTS
   ```
2. **Report which files changed** to the user, verbatim from the CLI's per-file lines.
3. **Recommend a diff review** before the user commits — the rewrite is exact-match, but a literal that *exactly* matched a token may still have been used in a context where a different token would have been semantically correct.

## Output format

The CLI prints one indented line per modified file (`  fixed <K> in <relative-path>`) followed by a summary line:

`Done. <N> exact-match rewrite(s) across <M> file(s).`

Surface both the per-file lines and the summary. If `M` is 0, say so plainly — there's nothing to review.
