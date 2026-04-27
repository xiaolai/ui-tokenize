# Revisions Log — Post-Codex-Review

Date: 2026-04-27
Source: `dev-docs/06-codex-review.md`
Effect: amends 02-spec.md, 03-interfaces.md, 04-plan.md, 05-decisions.md

This document is the authoritative record of changes between the original v0.1-draft and the post-review v0.1-rev1. Where this document and any earlier doc disagree, this document wins.

---

## R-01 — Rewrite-first hooks (was: deny-first)

**Before:** PreToolUse hook hard-blocks on every detected literal. Agent retries up to 3 times against the same `(file, region, literal)`. Soft-allow on attempt 4+.

**After:** PreToolUse uses Claude Code's native `PreToolUse` JSON output. For confidence-1.0 exact matches, return `permissionDecision: "allow"` with `updatedInput` mutating the literal to the rendered token reference — the write proceeds silently with the corrected value. Reserve `permissionDecision: "deny"` for: multi-candidate near-misses, no-candidate cases, dynamic constructions, and cases where consumer-API discovery is uncertain about the rendered surface.

**Why:** Repeated denial loops cause apologies, evasive edits, and context bloat. When we know the right answer, applying it is cheaper than negotiating with the model. Codex critique #1.

**Supersedes:** D-004, D-010 (in part), and the retry-sequence in `02-spec.md` §8.

---

## R-02 — JSON hook output (was: stderr fixed-field plain text)

**Before:** Block message emitted to stderr as a fixed-field plain-text payload; one message per violation; exit code 2 to signal block.

**After:** Hooks emit a single JSON payload to stdout matching Claude Code's hook protocol: `{ permissionDecision, permissionDecisionReason, updatedInput?, additionalContext? }`. The structured suggestion (token name, value, surface, alternates) lives in `additionalContext` as compact JSON, not as decorative field-label text. Multi-violation tool calls emit one consolidated payload listing all violations under a single `permissionDecision`.

**Why:** Native protocol; no parsing fragility; matches what the model actually sees in tool-result-error frames. Codex critique #2.

**Supersedes:** D-010 (fully); `03-interfaces.md` §3 wire format.

---

## R-03 — Retry budget per tool-call, not per literal

**Before:** Budget keyed by `(file_path, line_range, literal_value)`; soft-allow at attempt 4+.

**After:** Budget keyed by tool-call invocation count per session for unresolved violations. After 2 consecutive deny outcomes for any unresolved violation, the third response is `deny + additionalContext` instructing the agent to invoke the `tokenize__propose` MCP tool (R-06). No silent soft-allow. If the agent ignores the propose instruction, all subsequent tool calls touching the same file are denied with a hard-stop message that surfaces in the run log for human review.

**Why:** Per-region keying resets when line numbers shift and explodes on MultiEdit touching N files with the same literal. Soft-allow teaches the model the gate can be worn down. Codex critique #3.

**Supersedes:** D-005; FR-LOOP-L3; `02-spec.md` §8 retry sequence.

---

## R-04 — Discovery precedence: per-category authority

**Before:** Single global precedence order (`DTCG > CSS-vars > SCSS > LESS > TS > Tailwind > CSS-in-JS`) — and inconsistent between D-009 and `03-interfaces.md` §2.5.

**After:** Single source of truth in `03-interfaces.md` §6 — and that order is the **default per-category** precedence. Users may override per category in `.tokenize/config.json`:

```json
{
  "precedence": {
    "color":      ["css-vars", "dtcg-json", "tailwind"],
    "spacing":    ["tailwind", "dtcg-json"],
    "_default":   ["dtcg-json", "css-vars", "scss-vars", "less-vars", "ts-export", "tailwind", "css-in-js"]
  }
}
```

Catalog merger respects per-category overrides. Conflicts logged to `.tokenize/conflicts.json` regardless. Alias detection added to FR-DISC: if a CSS variable's value is `var(--color-primary)` and `color.primary` exists in DTCG, treat as alias not as conflict.

**Why:** Real repos have category-split authority (spacing in Tailwind, colors in CSS vars, motion in JSON). One global order produces surprising merges. Codex critique #4 + spec-bug fix.

**Supersedes:** D-009; reconciles `02-spec.md` §FR-DISC-2 vs `03-interfaces.md` §2.5.

---

## R-05 — Consumer-API discovery (new requirement)

**Before:** Renderer used a static surface table that assumed `tokens.X`, `vars.X`, `theme.X`, `text-danger`, `p-4` are universal patterns.

**After:** New requirement **FR-CONSUMER-DISC**: at session start, after token discovery, scan a sample of existing source files (default: 30 files spanning the largest detected surface types) to learn *how this project actually references tokens*. Build a `consumerProfile` that records observed patterns per surface:

```json
{
  "css":    { "convention": "var(--*)", "exampleUsages": [...] },
  "tsx":    { "convention": "tokens.*", "exampleUsages": [...] },
  "scss":   { "convention": "$*",       "exampleUsages": [...] }
}
```

If a surface has zero observed usages, the renderer falls back to the conservative default for that surface and **labels the suggestion `convention-inferred`** in the JSON additionalContext so the model knows to verify.

If observed usages are inconsistent (e.g. some files use `tokens.X` and others use `theme.X`), the suggestion includes both candidates with a note about the codebase split.

**Why:** Without this, every replacement is plausible-looking fiction in projects that don't match the assumed conventions. Codex critique #5 + blocker #2.

**Adds to:** `02-spec.md` §FR-DISC; `03-interfaces.md` §7.

---

## R-06 — `tokenize__propose` as MCP tool, not slash-command-only

**Before:** `/tokenize:propose <value> "<intent>"` was a slash command; assumed agent would self-invoke.

**After:** Plugin ships an MCP server (stdio) exposing first-class tools the agent can call without going through the user. Slash command becomes a thin user-facing wrapper.

| MCP tool | Purpose | Available in mode |
|---|---|---|
| `tokenize__list_tokens(category?)` | Query the live catalog | both |
| `tokenize__find_closest(value, type)` | Lookup nearest token to a value | both |
| `tokenize__propose(value, intent)` | Append to `tokens.proposed.json`; return temp `__proposed.*` name | both |
| `tokenize__add_token(name, value, type, description)` | Append to `tokens.json` with DTCG validation + naming-convention check | maintainer mode only |
| `tokenize__deprecate(name, reason, replacement?)` | Mark token deprecated; future suggestions exclude it | maintainer mode only |

Hooks instruct the agent to call these tools when they're the right move (e.g. PreToolUse deny additionalContext: `"No matching token; call tokenize__propose with this value if it should become one."`).

**Why:** Slash commands are user entry points; the model invokes MCP tools far more reliably as part of its normal recovery loop. Hooks cannot trigger slash commands. Codex critique #6 + blocker #3.

**Supersedes:** D-011 (MCP deferred → MCP required for v1); FR-PROPOSE-1.

---

## R-07 — Two operation modes: consumer vs maintainer

**Before:** Plugin "must never modify `tokens.json`" without explicit slash-command invocation (D-015, NFR-SAFETY-3).

**After:** Two modes in `.tokenize/config.json`:

```json
{ "mode": "consumer" | "maintainer" }
```

**Consumer mode (default):** behaves as originally specified. `tokens.json` is read-only to the agent. PreToolUse on `Write`/`Edit` of `tokens.json` is denied with a `additionalContext` instruction to propose via `tokenize__propose` instead.

**Maintainer mode:** `tokenize__add_token` and `tokenize__deprecate` MCP tools are exposed. They write directly to `tokens.json` after validating DTCG schema, naming convention, no-name-collision, and value-uniqueness within category. Direct `Write`/`Edit` to `tokens.json` from the agent is still denied; the only path is through the validated MCP tools.

**Why:** Some projects want the agent to manage tokens. Forbidding it absolutely breaks legitimate workflows. Codex critique #10.

**Supersedes:** D-015, NFR-SAFETY-3.

---

## R-08 — Implementation language: pure Node.js ESM, no build

**Before:** TypeScript via Bun with Node fallback; "compiled single-file scripts to avoid `node_modules` install" (D-007).

**After:** Pure Node.js ESM (`.mjs`), targeting Node 20+. JSDoc for type annotations. **Zero runtime dependencies** in v0.1. No build step; source files are the shipped artifacts. Hooks invoke `node` directly via shebang or wrapper shell script.

For AST in v0.2+, the plan is to add `oxc-parser` (Rust core, prebuilt binaries via `npm install`) only when an AST parse is genuinely needed; until then, regex covers the v0.1 surface set.

**Why:** Bun-as-primary requires Bun on every user's machine. Compiled artifacts add a build pipeline maintenance burden for a v0.1. Pure Node ESM with zero deps means the plugin Just Runs after `claude plugin install`. Codex critique #7.

**Supersedes:** D-007.

---

## R-09 — Honest latency budget; daemon mode deferred to v0.2

**Before:** PreToolUse < 50ms p95 (NFR-PERF-1).

**After:** PreToolUse < 250ms p95 with per-call process model (honest target including Node cold start ~30-80ms on macOS). Internal computation budget < 100ms. Daemon mode (resident process, hooks as Unix-socket clients, < 20ms total) is a v0.2 optimization with explicit migration path documented.

**Why:** Cold-start a Node process + parse stdin JSON + read catalog + scan + lookup + write ledger does not fit in 50ms. Pretending it does ships a perf-budget that fails out of the gate. Codex critique #8.

**Supersedes:** NFR-PERF-1, NFR-PERF-2, NFR-PERF-3.

---

## R-10 — Audit ships unchecked-labels in v1

**Before:** `/tokenize:audit` reports a coverage metric. Semantic review and deprecation tracking deferred to v0.2.

**After:** Audit output always carries explicit `semantics-unchecked` and `deprecation-unchecked` labels per finding. Coverage report includes a top-level disclaimer: *"Token coverage measures literal-replacement only. Tokens may be semantically wrong or deprecated; see `tokenize__deprecate` to manage lifecycle. Run a human or LLM review for semantic correctness."* `/tokenize:audit --fail-on-deprecated` flag added.

**Why:** Without these labels teams over-trust the audit and assume "tokenized = correct." Codex critique #9.

**Adds to:** FR-AUDIT, FR-OBS.

---

## R-11 — CI gate: changed-lines, not repo-wide coverage

**Before:** `/tokenize:audit` exits non-zero on any violation; coverage is the gate metric (FR-AUDIT-3).

**After:** Default CI behavior is `--changed-only` against `--baseline <ref>` (defaults to `origin/main` or `main`). Gate on **no new violations on changed lines**, not absolute coverage. Coverage remains as a trend metric, surfaced in `/tokenize:metrics` and the audit report header. New flags:

| Flag | Behavior |
|---|---|
| `--changed-only` | Only report violations introduced by changed lines vs baseline |
| `--baseline <ref>` | Git ref to diff against (default: `origin/main` or `main`) |
| `--full-repo` | Disable changed-only; report everything (for migration audits) |
| `--allow-existing` | Don't fail on pre-existing violations; only fail on new ones (default with `--changed-only`) |
| `--suppressions <file>` | Path to suppressions file for known-acceptable violations |

**Why:** Repo-wide coverage as PR gate is noisy on legitimate new components and on unsupported surfaces. Codex critique #12.

**Supersedes:** FR-AUDIT-1, FR-AUDIT-3.

---

## R-12 — Surface coverage: scoped statement + roadmap

**Before:** FR-DETECT-1 through FR-DETECT-13 implied broad coverage of "anything web."

**After:** Explicit **supported v0.1** list (regex-only, no AST):

| Surface | v0.1 status |
|---|---|
| `.css` / `.scss` / `.less` declaration values | supported |
| Plain HTML `<style>` blocks and `style="…"` attributes | supported |
| Vue SFC `<style>` blocks | supported |
| Svelte `<style>` blocks | supported |
| Astro `<style>` blocks | supported |
| Tailwind arbitrary brackets `[…]` (regex on className strings) | supported when Tailwind detected |
| SVG color attribute literals | supported |
| `.tsx` / `.jsx` inline `style={{}}` literals | **best-effort regex; AST in v0.2** |
| styled-components / emotion tagged template literals | **best-effort regex; AST in v0.2** |
| vanilla-extract `style({…})` | **best-effort regex; AST in v0.2** |
| MUI `sx={{…}}`, Chakra `<Box {...}>` | **v0.2** |
| JSS, Linaria, Compiled, Panda, UnoCSS, kuma-ui | **v0.3** |
| Lit/Stencil static styles, web components shadow DOM | **v0.3** |
| MDX | **v0.3** |
| Tailwind `@apply` (CSS) | **v0.2** |
| CSS Modules `:export` / `composes` | **v0.3** |
| `el.style.x = …` DOM mutations, `style.cssText` | **v0.3** |
| CSS `@property` registered custom properties | **v0.3** |
| Animation shorthands / cubic-bezier / gradient stops | **v0.2** |

Anything not in the list is **silently un-flagged** in v0.1 and **MUST** be labeled in audit reports as "Surface not supported in this version — unflagged literals may exist."

**Why:** Claiming universal coverage when regex misses half the CSS-in-JS ecosystem creates false confidence. Codex critique #5.

**Supersedes:** FR-DETECT scope statement (the list of items remains as long-term targets).

---

## R-13 — New failure-mode handling

Three new failure modes added to `02-spec.md` §8 failure-mode table:

| Failure | Handling |
|---|---|
| **MultiEdit edits `tokens.json` + consumer file in same call** | PreToolUse processes edits in dependency order: token-source edits first → re-discover catalog → validate consumer edits against the **new** catalog. If a maintainer-mode `tokenize__add_token` is used to add the token, the consumer edit using that name passes. |
| **Monorepo with multiple token roots** | Catalog scoped to nearest ancestor directory containing a token source (`tokens.json`, `tailwind.config.*`, etc.). Each scope has its own `.tokenize/` dir. Discovery walks up from the file being edited, stops at first matching root. |
| **Concurrent hook invocations writing the ledger** | Ledger uses per-PID append-only NDJSON log file (`.tokenize/ledger/<pid>.ndjson`); compaction to canonical `session.json` happens at SessionStart and at `/tokenize:metrics`. No file locks; conflict-free by construction. |

**Why:** Codex critique #11. These failures occur in real projects; ignoring them ships a tool that breaks under load.

---

## R-14 — Maintainer-mode safe-guards

Token mutation MCP tools (`add_token`, `deprecate`) require:

| Check | Enforcement |
|---|---|
| DTCG schema validity | reject if `$value` / `$type` malformed |
| Naming convention | reject if name doesn't match `^[a-z][a-z0-9.-]*$` and tier convention (no primitives in semantic group, etc.) |
| No name collision | reject if name already exists in catalog |
| Value-uniqueness within category (warning only) | log to `.tokenize/conflicts.json` if same value already mapped to different name |
| Type-correctness | `$type` must match category (color tokens get color values, dimension tokens get dimension values) |

**Why:** Maintainer-mode safety. Without these, the agent can corrupt the catalog as easily as hardcoding.

**Adds to:** R-07; new requirement FR-MAINTAINER-1 through FR-MAINTAINER-5.

---

## R-15 — Scope cut for v0.1

Given the above expansions, v0.1 scope is reduced from the original M0–M4 plan to:

| Component | v0.1 status |
|---|---|
| Token discovery: DTCG JSON + CSS `:root` | **in v0.1** |
| Token discovery: SCSS / LESS / TS / Tailwind / CSS-in-JS | **v0.2** |
| Catalog merge + per-category precedence | **in v0.1** |
| Consumer-API discovery (regex-based) | **in v0.1** |
| Scanner (regex layer only) | **in v0.1** |
| Suggester (exact + nearest-neighbor for color/dimension) | **in v0.1** |
| Renderer (CSS / inline-style / styled-components / Vue / Svelte / HTML / Tailwind detection) | **in v0.1** |
| Hooks: SessionStart, PreToolUse (rewrite-first), PostToolUse (re-scan + catalog-update) | **in v0.1** |
| Ledger: per-PID NDJSON append + compaction | **in v0.1** |
| MCP server: `list_tokens`, `find_closest`, `propose` | **in v0.1** |
| MCP server: `add_token`, `deprecate` (maintainer mode) | **in v0.1** |
| Slash commands: `init`, `audit` (with --changed-only), `catalog`, `metrics`, `propose`, `fix` | **in v0.1** |
| Starters: `shadcn`, `material` | **in v0.1** |
| Audit: changed-lines gate, semantics-unchecked labels | **in v0.1** |
| AST scanners (jsx, vue, svelte, astro, css-in-js full) | **v0.2** |
| Daemon mode for sub-100ms latency | **v0.2** |
| `token-reviewer` semantic-review subagent | **v0.2** |
| Multi-mode catalog (light/dark) | **v0.2** |
| Monorepo multi-root scoping | **partial v0.1** (discovery walks up; full scope isolation v0.2) |
| Native mobile / React Native | **v0.3+** |

---

## Decision-log impact

The following entries in `05-decisions.md` are superseded:

| Old decision | Status | Superseded by |
|---|---|---|
| D-004 (deny default) | superseded | R-01, D-018 |
| D-005 (per-region retry budget) | superseded | R-03, D-019 |
| D-007 (TS via Bun) | superseded | R-08, D-020 |
| D-009 (single global precedence) | superseded | R-04, D-021 |
| D-010 (plain-text block message) | superseded | R-02, D-022 |
| D-011 (MCP deferred) | superseded | R-06, D-023 |
| D-015 (no agent token writes) | superseded | R-07, D-024 |

New decisions D-018 through D-027 appear in the updated `05-decisions.md`.
