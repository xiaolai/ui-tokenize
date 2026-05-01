# ui-tokenize

A Claude Code plugin that blocks hardcoded UI values and enforces design tokens at the moment the agent writes them.

## What

When the agent calls `Write`, `Edit`, or `MultiEdit`, ui-tokenize inspects the content *before* it lands on disk and does one of three things:

1. **Silent rewrite** — when a hardcoded literal exactly matches a known token's value, the hook rewrites the literal to the correct token reference for that file's surface (`var(--color-primary)` in CSS, `tokens.color.primary` in TSX, etc.). The agent never sees an error.
2. **Structured deny** — when the match is inexact or missing, the hook returns a tool-result-error with nearest-token candidates and an instruction to call the `tokenize__propose` MCP tool.
3. **Allow** — when no UI literals are involved.

It also ships a CLI for `init`, `catalog`, `audit`, `fix`, `propose`, and `metrics`, plus an MCP server exposing five `tokenize__*` tools.

## Why

LLM-generated frontend code drifts away from a design system fast. The agent guesses `#3b82f6` when the team has `color.primary`, picks `padding: 17px` when the spacing scale only goes 4/8/16/24, and invents new color names when a token already exists. Style Dictionary, Stylelint, and ESLint can catch some of this in CI — but by then the literal is already in the diff, in the agent's context, and likely repeated across files.

ui-tokenize moves the gate to the write itself. The agent's wrong literal is corrected on the way to disk, or it is rejected with the right answer attached. Either way, the design system stays intact and the loop closes in one round-trip instead of three.

Zero runtime dependencies. No build step. Pure Node ESM, ≥ 20.

## How

### Install

```bash
claude plugin install ui-tokenize@xiaolai --scope project
```

> **Install fails with "Plugin not found in marketplace 'xiaolai'"?** Your local marketplace clone is stale. Run `claude plugin marketplace update xiaolai` and retry — `plugin install` does not auto-refresh.

### Bootstrap

In a project with existing tokens (DTCG `tokens.json`, CSS `:root` vars, SCSS / LESS / TS / Tailwind / CSS-in-JS):

```
/tokenize:init
```

In a project with no tokens yet:

```
/tokenize:init --starter shadcn
```

### Use

After `init`, every `Write`/`Edit`/`MultiEdit` from any agent in this project is intercepted automatically. The remaining slash commands are for inspection and CI:

| Command                                                                      | Purpose                                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `/tokenize:catalog [pattern]`                                                | Print the live token catalog                                                             |
| `/tokenize:audit [--changed-only\|--full-repo] [--baseline <ref>] [--json]`  | Scan for hardcoded values; default gates on changed lines vs baseline                    |
| `/tokenize:review [--changed-only\|--full-repo] [--baseline <ref>]`          | Semantic review: dispatch the `token-reviewer` agent to flag mis-picked tokens           |
| `/tokenize:fix [<path>]`                                                     | Apply exact-match rewrites in place                                                      |
| `/tokenize:propose <value> "<intent>"`                                       | Queue a new token proposal                                                               |
| `/tokenize:metrics`                                                          | Session ledger: blocks, rewrites, fabrications, escalations                              |

### Modes

`.tokenize/config.json`:

| Mode                 | Effect                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consumer` (default) | Agent cannot write `tokens.json` directly. New tokens go through `tokenize__propose`.                                                                                                                 |
| `maintainer`         | `tokenize__add_token` and `tokenize__deprecate` MCP tools are exposed; they write to `tokens.json` after DTCG / naming / collision validation. Direct `Write`/`Edit` of `tokens.json` remains denied. |

### Strictness

`.tokenize/config.json` `strictness` controls how the PreToolUse hook reacts to literals that don't match a known token exactly:

| Strictness            | Effect                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strict` (default)    | Exact-match literals are rewritten silently; uncertain literals are denied with structured suggestions. Three consecutive denies on the same file in a session hard-stop further edits.               |
| `advisory`            | Exact-match literals are still rewritten silently; uncertain literals pass through and PostToolUse surfaces them as `additionalContext` with nearest-token suggestions. No deny budget, no hard-stop. |

Pick `strict` for mature design systems where you want every off-catalog value caught at write-time; pick `advisory` for onboarding projects with sparse catalogs where the deny path would fire too often. `strictness` does not weaken structural protections — direct edits to token-source files (`tokens.json`, catalog CSS files in consumer mode) remain denied in either setting.

### Surfaces

`.tokenize/config.json` `surfaces` is an allowlist of file kinds the hook will scan. By default (`null` or omitted) every recognized surface is scanned. Set it to an array to narrow scanning per project.

```json
{
  "mode": "maintainer",
  "strictness": "advisory",
  "surfaces": ["css", "scss", "tsx"]
}
```

Recognized values: `css`, `scss`, `less`, `tsx`, `ts`, `vue`, `svelte`, `astro`, `html`, `svg`. Files outside the list are ignored by both PreToolUse and PostToolUse — no rewrite, no scan, no deny budget impact, no findings. Unknown entries are dropped with a stderr warning; if every entry is unknown the config falls back to the default. An explicit empty list (`[]`) means "scan nothing" and is reported on stderr (use `"disabled": true` if that is the intent).

When to narrow:

| Situation | Suggested `surfaces` |
| --- | --- |
| Pure CSS-in-JS project; tokens are TS exports | `["ts", "tsx"]` |
| Stylesheet-heavy project; styles never live in JSX | `["css", "scss"]` |
| Static-site generator; only HTML and CSS | `["css", "html"]` |
| Mixed React + CSS Modules; no Vue/Svelte/Astro to police | `["css", "scss", "tsx"]` |

When in doubt, leave it unset — the default catches violations across the full surface area.

### Semantic review

`/tokenize:audit` confirms that hardcoded literals were replaced by tokens. It does **not** confirm that the *right* token was chosen. The canonical mis-pick: `color.text.danger` used in a component called `InfoBanner` — the literal got tokenized, but the token's *meaning* contradicts the context.

`/tokenize:review` dispatches the `token-reviewer` subagent to apply that semantic judgment:

```
/tokenize:review                                # changed-only vs origin/main
/tokenize:review --full-repo                    # everything
/tokenize:review --baseline main                # against a specific ref
```

The deterministic half is `cli.mjs review-prep`, which finds catalog-resolved token usages with surrounding context and emits structured JSON. The agent reads that JSON and classifies each usage as `correct`, `mis-pick`, or `unclear`, citing the specific context line that triggered each verdict. The agent does not modify files — it produces a Markdown report; you (or a human reviewer) apply the fixes.

Pair `/tokenize:audit` with `/tokenize:review` for full coverage: audit catches missing tokenization deterministically, review catches semantic mis-picks via LLM judgment.

### Verify

```bash
npm test
```

Currently 161 / 161 passing.

## Status

v0.4.0 — pre-release. Regex-based scanners cover CSS, SCSS, LESS, JSX inline styles, Tailwind arbitrary brackets, SVG color attrs, and styled-components / emotion / vanilla-extract template literals (best-effort). `strictness: advisory`, per-project `surfaces` allowlist, and the `token-reviewer` semantic-review subagent (`/tokenize:review`) supported. Full AST coverage and daemon-mode latency follow in a later milestone.

See `dev-docs/` for spec, interfaces, decisions log, and audit history.

## Marketplace

Part of the [xiaolai plugin marketplace](https://github.com/xiaolai/claude-plugin-marketplace).

## License

[ISC License](LICENSE) — free to use, copy, modify, and distribute.
