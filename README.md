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

| Command                                                                     | Purpose                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `/tokenize:catalog [pattern]`                                               | Print the live token catalog                                          |
| `/tokenize:audit [--changed-only\|--full-repo] [--baseline <ref>] [--json]` | Scan for hardcoded values; default gates on changed lines vs baseline |
| `/tokenize:fix [<path>]`                                                    | Apply exact-match rewrites in place                                   |
| `/tokenize:propose <value> "<intent>"`                                      | Queue a new token proposal                                            |
| `/tokenize:metrics`                                                         | Session ledger: blocks, rewrites, fabrications, escalations           |

### Modes

`.tokenize/config.json`:

| Mode                 | Effect                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consumer` (default) | Agent cannot write `tokens.json` directly. New tokens go through `tokenize__propose`.                                                                                                                 |
| `maintainer`         | `tokenize__add_token` and `tokenize__deprecate` MCP tools are exposed; they write to `tokens.json` after DTCG / naming / collision validation. Direct `Write`/`Edit` of `tokens.json` remains denied. |

### Verify

```bash
npm test
```

Currently 113 / 113 passing.

## Status

v0.1.1 — pre-release. Regex-based scanners cover CSS, SCSS, LESS, JSX inline styles, Tailwind arbitrary brackets, SVG color attrs, and styled-components / emotion / vanilla-extract template literals (best-effort). Full AST coverage and daemon-mode latency follow in v0.2.

See `dev-docs/` for spec, interfaces, decisions log, and audit history.

## License

[ISC License](LICENSE) — free to use, copy, modify, and distribute.
