---
description: Scan the project for hardcoded UI values; default gates on changed lines vs baseline
argument-hint: "[--changed-only|--full-repo] [--baseline <ref>] [--json]"
---

Run the ui-tokenize audit. Default behavior is `--changed-only` against `origin/main` (or `main`), per D-026 — repo-wide coverage is a trend metric, not a PR gate.

## Steps

1. **Run the audit.**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs" audit $ARGUMENTS
   ```
2. **Report the result to the user.** Surface the file/line/literal/suggestion list verbatim; do not paraphrase. Always carry forward the `semantics-unchecked` and `deprecation-unchecked` labels — a literal being replaced by a token does not mean the *right* token was used. If the user wants semantic verification, recommend `/ui-tokenize:review`, which dispatches the `token-reviewer` subagent.
3. **Honor the exit code.** Non-zero exit means violations were found; this command can be wired into CI directly.
   The CLI also exits 1 when it fails outright: then stderr carries an `Error: <message>` line and no findings list is printed. In that case show stderr verbatim and stop; do not report it as violations. An unusable `--baseline` ref or a malformed `.tokenize/config.json` does not fail the run — the CLI prints a `[ui-tokenize] WARN:` line and falls back to a full-repo scan or the default config — so relay any such WARN line verbatim alongside the result, since the scan covered a different scope than requested.

## Output format

When run without `--json` or `--markdown`, the CLI prints:

- `Scanned <N> files (<mode>)`
- `Found <K> hardcoded value(s)`
- `Coverage: <pct>%  (<tokenized>/<total> declarations)`
- A NOTE line carrying the `semantics-unchecked, deprecation-unchecked` labels
- One indented line per finding: `  <file>:<line>  <literal>  →  <suggestion>`

With `--json`: a single JSON object with `mode`, `baseline`, `filesScanned`, `findings[]`, `deprecatedUsage[]`, `coverage`, `coverageDisclaimer`. With `--markdown`: a heading + a table per section. Pass these flags through unchanged when the user requests them.
