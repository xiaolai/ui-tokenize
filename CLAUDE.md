# ui-tokenize plugin instructions

This plugin rewrites and blocks hardcoded UI values in your `Write`/`Edit`/`MultiEdit` tool calls. It works by inspecting your tool input before it lands on disk and either:

1. **Silently rewriting** the literal to a token reference when a token's value exactly matches (you will see no error — the corrected code just lands)
2. **Denying** the call with a structured suggestion when the match is uncertain (you will see a tool-result-error containing nearest candidates and an instruction)
3. **Allowing** the call when no UI literals are present

## Prerequisites

- Node.js ≥ 20 (the hooks and CLI are pure ESM `.mjs`, no build step).
- A git repository at the project root (the audit's default `--changed-only` mode diffs against `origin/main` or `main`).
- Zero runtime dependencies; no `npm install` is required for this plugin itself.

## Install

From the project where you want the plugin active:

```bash
claude plugin install ui-tokenize@xiaolai --scope project
```

Then in that project, bootstrap the catalog once:

```bash
/tokenize:init
```

## Verify

After install, run the test suite from the plugin directory to confirm hooks and MCP tools are wired correctly:

```bash
npm test
```

Expected: `tests <N>   pass <N>   fail 0` (currently 147 / 147).

## What you should know

- **Always prefer using existing tokens** over hardcoded values. Hex colors, `rgb()`, `hsl()`, raw pixel values, inline `style={{}}` numerics — all of these will trigger the plugin.

- **Use the `tokenize__*` MCP tools** when you need to interact with the catalog programmatically. They are the primary recovery channel:
  - `tokenize__list_tokens(category?)` — see what tokens exist
  - `tokenize__find_closest(value, type)` — find the nearest match for a value
  - `tokenize__propose(value, intent)` — when no token fits, propose a new one and use the temporary `__proposed.*` name immediately
  - `tokenize__add_token(name, value, type, description)` — *maintainer mode only* — add a real token after validation
  - `tokenize__deprecate(name, reason, replacement?)` — *maintainer mode only*

- **If you receive a deny with a suggestion, apply it.** Do not retry the same hardcoded value. Do not invent a new token name — use one of the candidates returned in `additionalContext`, or call `tokenize__propose` if none fit.

- **You may not directly `Write`/`Edit` `tokens.json`** unless the project is in maintainer mode (set via `.tokenize/config.json`). Always go through `tokenize__add_token` or `tokenize__propose`.

- **The catalog refreshes automatically** when a token-source file is modified. After a token-file edit, expect a `Catalog updated` tool-result indicating what changed.

## Mode awareness

Read `.tokenize/config.json` if present. Two independent fields shape behavior:

`mode` — controls which MCP tools are available:

- `consumer` (default): no token-mutation tools; use `tokenize__propose` for new tokens (queues them for human review)
- `maintainer`: `tokenize__add_token` and `tokenize__deprecate` are available

`strictness` — controls how the PreToolUse hook reacts to uncertain literals:

- `strict` (default): exact-match rewrite + deny-with-suggestions on uncertain values; hard-stops after 3 consecutive denies on the same file in a session
- `advisory`: exact-match rewrite + passthrough on uncertain values; PostToolUse surfaces residuals as `additionalContext` with nearest-token suggestions; no deny budget, no hard-stop

The two fields compose. `strictness: advisory` does not weaken structural protections — direct edits to token-source files (e.g. `tokens.json`) remain denied in consumer mode regardless.

## Recovery patterns

When the PreToolUse hook denies your call (strict mode):

1. Read the `additionalContext` field for the structured suggestion
2. If a `nearestTokens` array is present and one is acceptable, use it directly in your retry
3. If `nearestTokens` is empty or none are acceptable, call `tokenize__propose` with the value and a short intent string; it returns a temporary token name you can use immediately
4. Never repeat the same hardcoded value across retries — the ledger tracks unresolved violations and will hard-stop after two repeated denies

In advisory mode, treat the PostToolUse `additionalContext` finding the same way — apply the suggested token in the next edit, or call `tokenize__propose` if no candidate fits.

## Audit awareness

`/tokenize:audit` reports tagged with `semantics-unchecked` and `deprecation-unchecked` mean the audit only verified that literal-replacement happened — it did not verify that the *right* token was used. A token may be syntactically present but semantically wrong (e.g. `color.text.danger` used for an info banner). A passing audit proves no hardcoded literals remain on changed lines; it does not prove the chosen tokens are semantically correct. Use the `token-reviewer` subagent (v0.2+) or a human reviewer for that.
