---
description: Scan the project for hardcoded UI values; default gates on changed lines vs baseline
argument-hint: "[--changed-only|--full-repo] [--baseline <ref>] [--json]"
---

Run the ui-tokenize audit. Default behavior is `--changed-only` against `origin/main` (or `main`), per D-026 — repo-wide coverage is a trend metric, not a PR gate.

Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs" audit $ARGUMENTS
```

Report the result. The audit is deliberately labeled `semantics-unchecked` and `deprecation-unchecked`: a literal being replaced by a token does not mean the *right* token was used. If the user wants semantic verification, recommend the `token-reviewer` subagent (v0.2+).

Exit code is non-zero if any violations are found, so this command can be used directly in CI.
