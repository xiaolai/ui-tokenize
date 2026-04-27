# Codex code-level audit of v0.1 implementation

Date: 2026-04-27
Reviewer: OpenAI Codex (gpt-5.4 via `codex exec`, ~232k tokens)
Scope: hooks, lib, mcp, commands, tests against `02-spec.md`, `03-interfaces.md`, `05-decisions.md`, `07-revisions.md`
Protocol references checked: Claude Code hooks docs, MCP 2024-11-05 transports/lifecycle, MCP 2025-06-18 schema. Hook field names are current; the issues below are behavioral.

Codex empirically verified the CIE Lab ΔE2000 implementation against Sharma's reference vector — `deltaE2000({L:50,a:2.6772,b:-79.7751},{L:50,a:0,b:-82.7485}) = 2.0424596802` vs. published 2.0425. Color math is correct.

---

## CRITICAL — bugs that cause incorrect behavior in normal use

1. **Retry state ignores sessionId and nets all rewrites against all blocks across sessions** — `lib/ledger.mjs:95`, `hooks/pre-tool-use.mjs:90`. Old sessions and unrelated fixes can hard-stop current edits. Pass current session into ledger reads; track consecutive denied tool calls per (session, file), not `blocks - rewrites`.

2. **`MultiEdit` exact-match rewrites are corrupted** — `hooks/pre-tool-use.mjs:161,172`. Report-to-edit mapping is inferred from array position; each edit-rewrite rebuilds from the original `edits` array, so only the last modified edit survives. Carry the candidate index through scanning; apply all rewrites into one accumulated `updatedInput`.

3. **MCP tool exceptions return JSON-RPC errors instead of `CallToolResult.isError`** — `mcp/server.mjs:96,134,241`. Claude cannot see tool-level failures and self-correct. Convert handler failures into `result: { content, isError: true }`; keep protocol errors for unknown methods/tools only.

4. **`audit --changed-only` is not changed-line gating** — `commands/cli.mjs:172,225`. Scans whole changed files, ignores unstaged/staged working-tree edits. Diff hunks against the baseline plus working tree; filter findings to touched lines.

5. **Retry budget counted per denied violation, not per denied tool call** — `hooks/pre-tool-use.mjs:95`, `lib/ledger.mjs:108`. One write with multiple literals can exhaust the budget immediately. Append one deny event per (tool-call, file); compute retries from consecutive deny outcomes per R-03/D-019.

## MAJOR — correctness or safety gaps to fix before release

6. **Scanner skips entire mixed-definition lines** — `lib/scanner.mjs:21,80`. `:root { --x:#fff; } .y { color:#abc; }` loses the real violation. Strip only the definition span, or scan the line remainder.

7. **Tailwind arbitrary values broken end-to-end** — `lib/scanner.mjs:97`, `lib/suggester.mjs:31`, `lib/render.mjs:111`. Scanner emits `tailwind-arbitrary`, suggester refuses that type, renderer emits invalid `space-4`. Parse bracket payload as color/dimension; render mapped utility or `[var(--token)]`.

8. **JS token rendering only brackets pure numerics** — `lib/render.mjs:100`. `space.4xl` produces invalid `tokens.space.4xl`. Bracket any segment that is not a valid JS identifier.

9. **`tokenize__add_token` / `tokenize__deprecate` do plain read-modify-write on `tokens.json`** — `mcp/server.mjs:177,203,217`. Concurrent calls can lose updates; crash can truncate. Write to temp + atomic rename; retry on concurrent modification.

10. **`setName` can corrupt `tokens.json`** — `mcp/server.mjs:220,263`. Can create children under an existing token node; `deprecateToken` happily marks a group path as deprecated. Reject intermediate/target nodes unless they are valid for the requested operation.

11. **Maintainer-mode validation is incomplete** — `mcp/server.mjs:197,283`. No real DTCG/schema/tier validation; no value-uniqueness warning logging; `validateValue('color')` accepts arbitrary bare identifiers. Validate token-node shape and alias syntax explicitly; log same-value collisions to `.tokenize/conflicts.json`.

12. **Consumer-mode token-source protection only recognizes JSON files** — `hooks/pre-tool-use.mjs:37,194`, `lib/discover/css-vars.mjs:21`. Discovered CSS variable sources can still be edited directly. Classify token-source paths from discovery/catalog data; handle consistently.

13. **PostToolUse never runs the promised Stylelint/ESLint passes** — `hooks/post-tool-use.mjs:27,41`. Only emits catalog refreshes for `tokens.json`/`design-tokens.json`, not CSS token-source edits. Add linter integration; refresh on any discovered token-source path.

14. **`.tokenize/config.json.ignore` and the D-017 `.gitignore` skip rule are unused** — `lib/config.mjs:10`, `lib/scanner.mjs:51`, `commands/cli.mjs:235`. Discovery/audit/hooks still traverse excluded files. Compile and apply ignore matchers centrally.

15. **`readSource()` uses `file.split('/')` to detect token filenames** — `lib/catalog.mjs:143`. Breaks on Windows paths. Use `basename(file)` from `node:path`.

16. **Audit's revised contract is only partially implemented** — `commands/cli.mjs:196,397`. `--markdown`, `--allow-existing`, `--suppressions`, `--fail-on-deprecated`, and any real coverage metric are missing even though rev1 claims them. Either implement or cut from the spec.

## MINOR — quality issues worth tracking

17. **`compactLedger()` can race with concurrent appenders** — `lib/ledger.mjs:53`. May silently drop a partial trailing line. Snapshot complete lines only, or rotate per-session logs before compaction.

18. **Ad-hoc `sessionId` fallback is just `Date.now()`** — `hooks/session-start.mjs:18`. Same-millisecond invocations collide. Append PID/random entropy.

19. **SVG attr exemptions miss `context-fill` / `context-stroke`** — `lib/scanner.mjs:103`. Legitimate SVG paint inheritance is flagged as hardcoded color. Expand the allowlist.

20. **Critical paths are largely untested** — no MCP server tests, no maintainer-mode validation tests, no `consumer-profile` tests, no `audit --changed-only` tests, no concurrent / session-isolation ledger tests. Add E2E MCP / CLI fixtures and multi-process ledger tests.

---

## Triage decision

Per hands-off mode, addressing the 5 CRITICAL items immediately. MAJOR items #6–#16 are deferred to v0.1.1 unless they block tests. MINOR items deferred.
