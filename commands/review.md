---
description: Semantic review of token usage — verifies that the right token was chosen, not just that some token was used
argument-hint: "[--changed-only|--full-repo] [--baseline <ref>]"
---

Run a semantic review of design-token usage in this project. Complementary to `/tokenize:audit` — audit checks that no hardcoded literals remain; this command checks that the chosen tokens fit their context (the `semantics-unchecked` label audit emits).

## Steps

1. **Dispatch the `token-reviewer` agent** via the Task tool with the user's arguments. The agent will:
   - Run `node ${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs review-prep $ARGUMENTS` to enumerate token usages with surrounding context
   - Classify each usage as `correct`, `mis-pick`, or `unclear`
   - Emit a Markdown report listing every `mis-pick` and `unclear` finding with cited evidence
2. **Surface the agent's report verbatim.** Do not paraphrase, summarize away findings, or rerank verdicts.

## When to use

- After `/tokenize:audit` returns clean — to verify the *right* tokens were chosen, not just *some* tokens
- When inheriting a codebase and you don't trust the design-system discipline
- Before a release as a periodic semantic-correctness pass
- When you suspect a specific component is using a token whose name doesn't match its context

## Notes

- Default scope is `--changed-only` against `origin/main` (or `main`), like audit.
- Use `--full-repo` for a comprehensive sweep; expect more findings and longer runtime.
- The agent reads the catalog (`.tokenize/catalog.json`) for token names, types, descriptions, and deprecation flags. If the catalog is empty, the run aborts with `No catalog. Run /tokenize:init first.`
- The agent does **not** modify files. It produces recommendations; you (or a human reviewer) apply them.
