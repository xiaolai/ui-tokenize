# ui-tokenize — Implementation Plan

Version: 0.1-rev1
Date: 2026-04-27 (post-Codex review)
Related: `02-spec.md`, `03-interfaces.md`, `05-decisions.md`, `07-revisions.md`

> **Revision notice (2026-04-27).** This plan is consolidated from the original M0–M5 to a single v0.1 cut described in R-15 of `07-revisions.md`. Implementation language changed from TS+Bun to pure Node.js ESM (D-020). Hook architecture changed from deny-first to rewrite-first (D-018). MCP server moved from v0.2 → v0.1 (D-023). Latency budget revised to honest 250ms p95 (D-025). Read `07-revisions.md` for the full narrative before reading the milestone tables below.

---

## 1. Phasing rationale

Five milestones for v1, ordered to deliver verifiable value at each step:

- **M0 — Foundation libraries.** No user-facing behavior; testable in isolation.
- **M1 — L0 + L1 enforcement.** Minimum viable feedback loop. Plugin becomes useful here.
- **M2 — L2 verification + L3 ledger.** Closes the loop; adds retry budget.
- **M3 — Bootstrap + escape valve.** Onboarding for projects without tokens; release valve for missing tokens.
- **M4 — Audit + observability.** CI integration; visibility.
- **M5+ — Deferred items** (semantic-review subagent, MCP exposure, multi-mode, native mobile).

Each milestone closes with green tests against the acceptance criteria scoped to it.

---

## 2. Directory layout

Final v1 layout:

```
ui-tokenize/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── hooks/
│   ├── session-start
│   ├── pre-tool-use
│   └── post-tool-use
├── commands/
│   ├── init.md
│   ├── audit.md
│   ├── fix.md
│   ├── propose.md
│   ├── catalog.md
│   └── metrics.md
├── lib/
│   ├── discover/
│   │   ├── dtcg.ts
│   │   ├── css-vars.ts
│   │   ├── scss-vars.ts
│   │   ├── less-vars.ts
│   │   ├── ts-export.ts
│   │   ├── tailwind.ts
│   │   └── css-in-js/
│   ├── catalog/          # in-memory + on-disk catalog; conflict resolver
│   ├── scanner/          # regex + AST violation detection
│   ├── suggester/        # lookup + distance metrics
│   ├── render/           # surface-aware replacement rendering
│   ├── ledger/           # session.json read/write; retry-budget API
│   └── format/           # block message format; tool-result formatting
├── starters/
│   ├── shadcn.json
│   ├── material.json
│   ├── polaris.json
│   └── primer.json
├── fixtures/             # test fixtures
├── tests/
├── dev-docs/             # this folder
├── CLAUDE.md
└── README.md
```

---

## 3. Implementation language

**TypeScript, run via `bun` with `node` fallback.** Decided in `05-decisions.md` D-007.

Reason: CSS / JSX / TSX / Vue / Svelte / Astro all need AST parsing. TS-side AST tooling (`oxc-parser`, `tree-sitter`, `swc`) is more mature than Python's, and projects using this plugin already have Node/Bun as a frontend toolchain prerequisite. Hooks and commands shipped as compiled single-file scripts; no `node_modules` install on the user side.

---

## 4. Milestones

### M0 — Foundation libraries

**Goal:** all `lib/` modules implemented and unit-tested in isolation. No hooks wired yet.

**Deliverables:**

| Component | What ships | Acceptance |
|---|---|---|
| `lib/discover/dtcg` | DTCG JSON parser → `Token[]` | Parses W3C DTCG 2025.10 fixtures; rejects malformed gracefully |
| `lib/discover/css-vars` | `:root { --x: …; }` extractor | Handles nested selectors, `:host`, multiple `:root` blocks |
| `lib/discover/scss-vars` | top-level `$x: …;` extractor | Handles `!default`, `!global` |
| `lib/discover/less-vars` | top-level `@x: …;` extractor | |
| `lib/discover/ts-export` | TS AST scan for `export const tokens/theme/colors/spacing` | Handles object literals, `as const`, satisfies |
| `lib/discover/tailwind` | `tailwind.config.{js,ts}` `theme.extend` + `@theme` directive | |
| `lib/discover/css-in-js/*` | vanilla-extract `createTheme`, stitches `createStitches`, styled-components `ThemeProvider` | (best-effort) |
| `lib/catalog` | merge multi-source catalogs; conflict resolution per `03-interfaces.md` §2.5; precomputed `valueIndex` | Conflicts logged; precedence rule honored |
| `lib/scanner/regex` | regex layer per `03-interfaces.md` §FR-DETECT-1..3, 9..11 | All hex / functional-color / dimension / Tailwind-arbitrary / SVG-attr fixtures pass |
| `lib/scanner/ast/jsx` | JSX inline-style + tagged-template scan | Catches `style={{padding: 16}}` and `styled.div\`padding: 16px\`` |
| `lib/scanner/ast/vue` | Vue SFC scan: `<style>`, `:style` | |
| `lib/scanner/ast/svelte` | Svelte scan: `<style>`, `style:` | |
| `lib/scanner/ast/astro` | Astro `<style>` scan | |
| `lib/scanner/obfuscation` | constant-expression evaluator (catches `8 + 8`, string concat) | |
| `lib/suggester` | exact + nearest-neighbor lookup; distance metrics per `03-interfaces.md` §8 | < 5ms p95 on 1000-token catalog |
| `lib/render` | dispatch table per `03-interfaces.md` §7 | All 14 surface variants produce syntactically valid output |
| `lib/ledger` | `session.json` schema; retry-budget API | Atomic writes; corruption-resilient |
| `lib/format` | block message formatter; tool-result formatter | Output matches `03-interfaces.md` §3 byte-for-byte |

**Tests:** unit tests per module, fixture-driven. Bench harness for perf-budgeted modules (`scanner`, `suggester`, `discover`).

**Out of scope:** any hook wiring; any slash command.

---

### M1 — L0 + L1 enforcement

**Goal:** plugin actually blocks hardcoded values when installed.

**Deliverables:**

| Component | Behavior |
|---|---|
| `hooks/session-start` | Run discovery; write `.tokenize/catalog.json`; emit categorized catalog injection per `03-interfaces.md` §4 |
| `hooks/pre-tool-use` | Read tool input; resolve target file; run scanner; on violation: query suggester + ledger; emit block message; exit 2 |
| `.claude-plugin/plugin.json` | Wires SessionStart and PreToolUse hooks |

**Acceptance criteria covered:** AC-1, AC-2, AC-9, AC-12, AC-13.

**Manual smoke test:**

1. Install plugin in fixture project with `tokens.json` containing `space.4 = 16px`
2. Ask agent to write `<button style={{padding: 16}}>X</button>`
3. Observe block; observe agent retry with `tokens.space[4]`
4. Observe second write succeeds

**Out of scope:** PostToolUse, retry-budget escalation (beyond emitting attempt counter), slash commands.

---

### M2 — L2 verification + L3 ledger

**Goal:** closed loop with retry budget and external-linter integration.

**Deliverables:**

| Component | Behavior |
|---|---|
| `hooks/post-tool-use` | Re-scan written file; run external linters if present (`stylelint`, `eslint` via `npx`); emit `"Catalog updated"` tool-result on token-source file edit; emit remaining-issues tool-result |
| `lib/ledger` (extension) | Retry-budget enforcement: hard-block attempts 1–3, soft-allow + escalation log at attempt 4+ |
| `.tokenize/escalations.json` | Generated when retries exhausted |
| `.tokenize/conflicts.json` | Generated when discovery finds conflicts |

**Acceptance criteria covered:** AC-3, AC-4, AC-10.

**Test additions:** integration test where agent emits same literal 4 times → verify soft-allow + escalation entry. Test where token-source file is mid-session edited → verify catalog-updated tool-result with delta.

---

### M3 — Bootstrap + escape valve

**Goal:** plugin works in projects with zero existing tokens.

**Deliverables:**

| Component | Behavior |
|---|---|
| `commands/init` | Detect existing sources OR scaffold empty DTCG `tokens.json` + `tokens.css` + `tokens.ts`; `--starter <name>` flag |
| `starters/{shadcn,material,polaris,primer}.json` | Curated DTCG token sets |
| `commands/propose` | Append to `tokens.proposed.json`; return `__proposed.<camelCaseName>` temp token |
| `commands/catalog` | Print categorized catalog; supports `[pattern]` filter |
| Scanner exemption for `__proposed.*` references | PreToolUse allows these without block |

**Acceptance criteria covered:** AC-5, AC-6, AC-7.

**Test additions:** `/tokenize:init` in empty dir produces expected files. `/tokenize:init --starter shadcn` populates from starter. `/tokenize:propose` emits valid temp name; subsequent edit using temp name passes PreToolUse.

---

### M4 — Audit + observability

**Goal:** CI integration and human-visible metrics.

**Deliverables:**

| Component | Behavior |
|---|---|
| `commands/audit` | Full-repo scan; coverage metric (% styled declarations using tokens); per-category breakdown; `--json` / `--markdown` output; non-zero exit on violations; `--fix` flag invokes `commands/fix` |
| `commands/fix` | Apply suggester results in-place to all violations; reports modified files |
| `commands/metrics` | Pretty-print `.tokenize/session.json`; aggregable across sessions |

**Acceptance criteria covered:** AC-8, AC-11 (perf bench at scale), AC-14.

**Test additions:** `/tokenize:audit` on a fixture with N known violations reports exactly N. `/tokenize:fix` on same fixture resolves them. Bench `audit` on 10k-file fixture meets NFR-PERF-4.

---

### M5+ — Deferred (post-v1)

| Feature | Status |
|---|---|
| `agents/token-reviewer` semantic-mis-pick subagent | shipped in v0.4 |
| MCP server exposing `list_tokens` / `find_closest_token` / `get_token_value` | v0.2 |
| Multi-mode catalog (light / dark / etc.) | v0.2 |
| React Native support | v0.3 |
| SwiftUI / Compose / Flutter | post-v0.3 |
| Codemod integration with `jscodeshift` for legacy migration | as-needed |
| Figma / Tokens Studio direct sync | not planned |

---

## 5. Test strategy

### 5.1 Test pyramid

| Layer | Tooling | Scope |
|---|---|---|
| Unit | `bun test` | Each `lib/*` module in isolation; fixture-driven |
| Integration | `bun test` | Full hook flow: stdin JSON → hook → stdout/stderr/exit + side-effect files |
| Smoke | shell script | `claude plugin install ui-tokenize` → run a scripted edit → observe block |
| Bench | custom harness | NFR-PERF-* budgets; runs in CI; fails on regression |

### 5.2 Critical fixtures

| Fixture | Purpose |
|---|---|
| `fixtures/tokens-dtcg-minimal/` | Minimal DTCG token set; happy path |
| `fixtures/tokens-dtcg-3tier/` | Full 3-tier token set with aliases |
| `fixtures/tokens-css-vars-only/` | Project with only `:root` declarations |
| `fixtures/tokens-multi-source-conflict/` | Conflicting definitions across DTCG and CSS vars |
| `fixtures/violations-css/` | Sample CSS files with hex / rgb / px violations |
| `fixtures/violations-tsx/` | Sample TSX with `style={{}}`, styled-components, JSX className |
| `fixtures/violations-vue/` | Sample Vue SFC |
| `fixtures/violations-svelte/` | Sample Svelte component |
| `fixtures/violations-obfuscated/` | `8 + 8`, `'#' + 'fff'`, `0xff5500` cases |
| `fixtures/empty-project/` | No tokens; tests bootstrap path |
| `fixtures/scale-10k/` | 10k files for NFR-PERF-4 |

### 5.3 Acceptance gating

CI must run all unit + integration + bench tests on every PR. Smoke test runs nightly. Coverage of `lib/*` must remain ≥ 85% lines.

---

## 6. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Claude Code hook protocol changes between releases | Medium | High | Version-pin against documented protocol; integration tests against the live protocol nightly |
| AST parsing of CSS-in-JS template literals is fragile | High | Medium | Limit to high-confidence patterns; fall back to regex-only if AST parse fails |
| Suggestion engine's near-neighbor lookup produces wrong-but-confident matches | Medium | High | Conservative thresholds (Lab ΔE < 2.0 for high confidence); always show alternates when < 1.0 |
| Catalog injection exceeds context budget on large token sets | Medium | Medium | Project-aware filtering: only inject categories actually used in source |
| Retry budget exhaustion frustrates real refactor sessions | Low | Medium | Soft-allow at attempt 4+; document the escape-valve workflow prominently |
| Plugin slows agent iteration below useful threshold | Low | High | NFR-PERF budgets; bench harness; lazy AST; precomputed `valueIndex` |
| External linter integration breaks on unusual configs | Medium | Low | Detect via `node_modules/<tool>` existence; `--no-config` style invocation; failures don't block PostToolUse |
| Over-block on dynamic class strings (`'p-' + size`) | High | Medium | Classify dynamic constructions as warn-only; don't hard-block |
| Token name fabrication still occurs after L0 injection | Medium | Medium | L3 ledger tracks fabrications; next session's L0 prepends correction list |
| Universal surface coverage misses an exotic CSS-in-JS lib | Medium | Low | Document supported surfaces; provide regex fallback for unknown surfaces |

---

## 7. Estimated complexity

Rough sizing for planning, not commitment:

| Milestone | LOC (TS) | Test fixtures | Estimated effort |
|---|---|---|---|
| M0 | ~3500 | 8 | Largest — foundation |
| M1 | ~600 | 3 | Small — wiring over M0 |
| M2 | ~700 | 4 | Small-medium |
| M3 | ~800 (incl. starters) | 3 | Small-medium |
| M4 | ~600 | 2 | Small |
| Total v1 | ~6200 | 20 | |

---

## 8. Release plan

| Version | Scope | Gate |
|---|---|---|
| 0.1.0 | M0 + M1 + M2 + M3 + M4 | All v1 acceptance criteria green |
| 0.1.x | bug fixes from real-world use | (responsive) |
| 0.2.0 | strictness=advisory | New feature acceptance |
| 0.3.0 | per-project surfaces allowlist | New feature acceptance |
| 0.4.0 | M5 — token-reviewer subagent (semantic review) | New feature acceptance |
| 0.5.0 | React Native + SwiftUI | Surface expansion |

Initial release goes to `xiaolai/claude-plugin-marketplace` with central marketplace manifest update per the workflow in `claude-plugins/CLAUDE.md`.
