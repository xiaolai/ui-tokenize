# ui-tokenize

Block hardcoded UI values from LLM-written code. Enforce design tokens through a closed-loop control system: a `PreToolUse` hook **rewrites** literals to token references on the way to disk, falls back to a structured deny when a rewrite is uncertain, and surfaces a first-class `tokenize__propose` MCP tool when no token fits.

> No Tailwind required. No Style Dictionary required. No Stylelint or ESLint required. Detects whatever's there and adapts.

## What it does

- **Discovers tokens** from any combination of: DTCG JSON, CSS `:root` custom properties, SCSS / LESS variables, TS theme exports, Tailwind config, CSS-in-JS theme objects.
- **Detects literals** (hex colors, `rgb`/`hsl`/`oklch`, raw `px`/`rem`/`em`/`%` dimensions, inline `style={{}}` numbers, Tailwind arbitrary brackets, SVG color attrs) in your source.
- **Rewrites on write.** When a literal exactly matches a token's value, the `PreToolUse` hook silently mutates the agent's `Write`/`Edit` to use the token reference, rendered for the file's surface (`var(--space-4)` in CSS, `tokens.space[4]` in TSX, etc.). The agent never sees an error — the right code just lands.
- **Denies with structure** when there's no exact match. The deny payload includes nearest-token candidates and an instruction to invoke `tokenize__propose` if the value should become a new token.
- **Closes the loop** with `PostToolUse` re-verification and a session ledger that prevents brute-force retries.
- **Stays out of your way.** Discovery walks up to find the nearest token root in monorepos. Per-category precedence is configurable. Coverage is a trend metric, not a PR gate.

## Install

```bash
claude plugin install ui-tokenize@xiaolai --scope project
```

Or via direct git:

```bash
claude plugin install <repo-url>
```

## Quickstart

1. **Bootstrap a project that has no tokens:**
   ```
   /tokenize:init --starter shadcn
   ```
   Generates `tokens.json` (DTCG), `tokens.css` (custom properties), `tokens.ts` (typed export). Pick any starter, or run with no flag to scaffold an empty file you fill yourself.

2. **Discover what's already there:**
   ```
   /tokenize:init
   ```
   Reads any DTCG JSON, CSS variables, SCSS / LESS / TS / Tailwind / CSS-in-JS theme already in your repo and produces a discovery report.

3. **Verify:**
   ```
   /tokenize:catalog
   ```
   Prints the live merged catalog grouped by category.

4. **From here**, every `Write`/`Edit` from any agent in this project is intercepted. Hardcoded literals matching a token are rewritten silently. Literals without a match are denied with a structured suggestion the agent can act on.

## Operation modes

Set in `.tokenize/config.json`:

| Mode | Effect |
|---|---|
| `consumer` (default) | Agent cannot edit `tokens.json`. PreToolUse on `tokens.json` writes is denied with an instruction to use `tokenize__propose`. |
| `maintainer` | MCP tools `tokenize__add_token` and `tokenize__deprecate` are exposed. They write to `tokens.json` after DTCG / naming / collision validation. Direct `Write`/`Edit` of `tokens.json` is still denied; only validated MCP tools can mutate. |

## MCP tools (always available to the agent)

| Tool | Mode | Purpose |
|---|---|---|
| `tokenize__list_tokens(category?)` | both | Query the live catalog |
| `tokenize__find_closest(value, type)` | both | Find nearest matching token |
| `tokenize__propose(value, intent)` | both | Append to `tokens.proposed.json`; return temp `__proposed.*` name for immediate use |
| `tokenize__add_token(name, value, type, description)` | maintainer | Append to `tokens.json` with strict validation |
| `tokenize__deprecate(name, reason, replacement?)` | maintainer | Mark token deprecated; future suggestions exclude it |

## Slash commands

| Command | What it does |
|---|---|
| `/tokenize:init` | Discover existing token sources or scaffold new ones (`--starter shadcn|material`) |
| `/tokenize:catalog [pattern]` | Print the live catalog grouped by category |
| `/tokenize:audit [--changed-only] [--baseline <ref>] [--full-repo] [--json]` | Scan for violations; default gates on changed-lines vs baseline |
| `/tokenize:fix [<glob>]` | Apply suggested replacements in-place |
| `/tokenize:propose <value> "<intent>"` | User wrapper around the MCP `propose` tool |
| `/tokenize:metrics` | Session ledger: blocks, rewrites, escalations, fabrications |

## Design

The plugin is a closed-loop control system. The four loop layers, in order of latency:

| Layer | Where | What |
|---|---|---|
| L0 | `SessionStart` hook | Inject the live merged catalog into agent context, plus known fabrications from prior sessions |
| L1 | `PreToolUse` hook | Rewrite-first on confidence-1.0 matches; deny on multi-candidate / no-match with structured suggestion |
| L2 | `PostToolUse` hook | Re-verify the written file; emit `Catalog updated` when a token-source file was edited |
| L3 | Per-PID NDJSON ledger | Bounded retry budget; instruct `tokenize__propose` after two unresolved denies |

Read `dev-docs/` for the full spec, interfaces, plan, decisions log, and Codex critical review.

## Status

v0.1 — pre-release. Surface coverage is regex-only; AST scanners (full JSX, Vue, Svelte, Astro, CSS-in-JS) follow in v0.2 along with daemon-mode latency optimization.

## License

MIT
