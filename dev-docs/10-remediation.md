# Remediation log — Claude audit (`09-claude-audit.md`) → v0.1.1

Date: 2026-04-27
Source: `dev-docs/09-claude-audit.md`
Scope: 1 Critical, 2 High, 6 Medium, 5 Low items addressed in one pass; remaining
Low items either rejected with rationale or rolled into v0.2 backlog.

This document maps every audit finding to the file/line where it now lives, the
test that pins the fix, and (where the audit asked a question) the contract the
fix commits to. Future readers should be able to confirm "audit said X, code now
does Y" in one diff.

Tests at remediation time: **113 / 113 passing** under Node ≥20 (was 103 / 103).

---

## Resolution table

| # | Severity | Finding | Resolution | Test |
|---|----------|---------|------------|------|
| 1 | Critical | Shell injection via `audit --baseline` | `commands/cli.mjs:11` switches to `execFileSync` (no shell); `commands/cli.mjs:21` adds defense-in-depth allowlist `GIT_REF_RE`; `changedLineRanges` rejects refs that don't match before invoking git. `defaultBaseline()` also moved to `execFileSync`. | `tests/audit.test.mjs` "audit --baseline rejects shell metacharacters" + "audit --baseline accepts legitimate git refs" |
| 2 | High | `require('node:fs').statSync` always throws in ESM → `fix <directory>` was a silent no-op | `commands/cli.mjs:4` adds `statSync` to the top ESM import; `statSyncSafe` calls it directly. | `tests/fix.test.mjs` "fix <directory> rewrites violations in nested files" |
| 3 | High | `--allow-existing` was dead code in `--changed-only`; the flag's only working effect was hidden in `--full-repo` exit logic | Contract committed: `--allow-existing` reports pre-existing findings as informational (`preExisting: true`) without failing the gate. In `--full-repo` mode, every finding is pre-existing by construction (no baseline diff), so the gate never fires. Logic centralized in one filter at the exit-code site (`commands/cli.mjs` `cmdAudit` exit block). | `tests/audit.test.mjs` "audit --changed-only --allow-existing reports pre-existing without failing" + "audit --full-repo --allow-existing reports findings without failing" |
| 4 | Medium | Hooks failed open on malformed event JSON | `hooks/pre-tool-use.mjs:23` switches malformed-event handler from `passthrough` to `failClosed`. New helper emits a structured deny with reason `"malformed hook event; refusing to make a security decision"`. | `tests/hooks.test.mjs` "PreToolUse: malformed event JSON denies (fails closed)" |
| 5 | Medium | Race / silent overwrite in `tokens.proposed.json` writes | New `lib/json-io.mjs` exports `atomicWriteJson` (tmp + rename) and `readJsonStrict` (distinguishes missing vs malformed). MCP `proposeToken` and CLI `cmdPropose` both use them. Missing file → fresh `{ proposals: [] }`. Malformed file → throw, surface via `isError: true` (MCP) or process error (CLI); the broken file is preserved untouched. | `tests/mcp.test.mjs` "MCP: propose refuses to overwrite a corrupted tokens.proposed.json" |
| 6 | Medium | `cmdPropose` had no try/catch around `JSON.parse` | Now uses `readJsonStrict`; same helper as MCP — single source of truth. | (covered by the same MCP test conceptually; CLI path uses identical helper) |
| 7 | Medium | `walkAllFiles` ignored `.gitignore` / `.tokenize/ignore` | `commands/cli.mjs` `walkAllFiles` and `expandGlob` now construct `loadIgnore(root, readConfig(root).ignore)` and pass it through `walkDir`. The hardcoded blocklist is gone. | `tests/audit.test.mjs` "audit --full-repo respects .gitignore" + `tests/fix.test.mjs` "fix respects .gitignore" |
| 8 | Medium | MCP `add_token` schema enum and `validateType` allow-list disagreed | Single source of truth introduced as `ALLOWED_TOKEN_TYPES` in `mcp/server.mjs`; the schema enum on `tokenize__add_token.inputSchema` is kept identical with a comment forbidding drift. Schema was widened to match validator (the validator accepted the wider set already). | (existing `tests/mcp.test.mjs` `add_token` tests cover the path; widening was a no-op for them) |
| 9 | Medium | `cmdFix` ignored `--suppressions` | `cmdFix` now calls `parseFlags`, builds `readSuppressionsFile(...)` like `cmdAudit`, and skips matching files. | `tests/fix.test.mjs` "fix honors --suppressions" |
| 10 | Low | Duplicate `nameFromIntent` / `camelize` between MCP and CLI | New `lib/proposal.mjs` exports `camelizeFromIntent`, `kebabFromIntent`, `nameFromIntent`. Both call sites import from there. The CLI's ad-hoc color/dimension regex is gone — now both paths agree on what counts as a color (via `parseColor`) and a dimension (via `parseDimension`). | (covered by existing propose tests in MCP and CLI) |
| 11 | Low | Duplicate glob-to-regex between `commands/cli.mjs` and `lib/ignore.mjs` | `lib/ignore.mjs` now exports `globToRegExpStr`. The CLI's `globToRegexCli` is deleted; `readSuppressionsFile` uses the exported helper. | (no new test — behavior unchanged; existing `audit --suppressions` test exercises the path) |
| 12 | Low | Dead `void sourceCount` + unused `_root` param in `lib/catalog.mjs` | Both removed. `readSource` signature is now `(file, out)`. | (compile passes; existing catalog tests cover behavior) |
| 13 | Low | Scanner `DIMENSION_RE` excludes `%` without explanation | Comment added at `lib/scanner.mjs:20` explaining the rationale (high false-positive rate; revisit in v0.2). | n/a (documentation-only) |
| 14 | Low | `spawnSync('npx', …)` resolves through PATH | `hooks/post-tool-use.mjs` now resolves `node_modules/.bin/<linter>` directly via `execFileSync`, removing PATH from the trust set. Cross-platform `.cmd` shim handled for Windows. | (existing post-tool-use test path unaffected; behavior is best-effort by design) |

## Findings tracked but deferred to v0.2 backlog

- **#16** — `commands/cli.mjs` is 652 lines (now 668 with the regression-test
  hooks). Per-subcommand split deferred to the v0.2 AST-scanner work where the
  seams will naturally widen anyway.
- **#17/18/19** — Test backfill: addressed by `tests/fix.test.mjs` (new),
  `tests/audit.test.mjs` (3 new tests), `tests/hooks.test.mjs` (1 new test),
  `tests/mcp.test.mjs` (1 new test). 10 new tests in total.
- **#20** — Direct-bin invocation of stylelint/eslint shipped in v0.1.1 (was
  marked "cleanup" in the audit).

## What changed in repo layout

| New file | Purpose |
|---|---|
| `lib/json-io.mjs` | `atomicWriteJson` + `readJsonStrict` — shared by MCP and CLI |
| `lib/proposal.mjs` | `camelizeFromIntent` / `kebabFromIntent` / `nameFromIntent` — shared by MCP and CLI |
| `tests/fix.test.mjs` | Regression coverage for `cmdFix` (directory walk, suppressions, ignore) |

| Removed | Replaced by |
|---|---|
| `mcp/server.mjs` `safeReadJson` | `lib/json-io.mjs` `readJsonStrict` |
| `mcp/server.mjs` `atomicWriteJson` | `lib/json-io.mjs` `atomicWriteJson` |
| `mcp/server.mjs` `camelize` / `kebab` / local `nameFromIntent` | `lib/proposal.mjs` exports |
| `commands/cli.mjs` `globToRegexCli` | `lib/ignore.mjs` `globToRegExpStr` |
| `commands/cli.mjs` local `kebabToCamel` / `nameFromIntent` | `lib/proposal.mjs` exports |

## Decision-log impact

No new top-level decisions; all changes flow from existing R-01 through R-15 in
`07-revisions.md`. The `--allow-existing` contract clarification (finding #3) is
the only behavior change worth flagging in release notes — see the test names
for the precise contract.

## Verification

```sh
npm test
# tests 113   pass 113   fail 0
```

Manual smoke: ran `node commands/cli.mjs audit --changed-only --baseline 'HEAD; touch /tmp/canary'` against a temporary repo; canary did not appear, stderr emitted `[ui-tokenize] WARN: rejected unsafe baseline ...`. Critical-finding regression confirmed live, not just in fixture.
