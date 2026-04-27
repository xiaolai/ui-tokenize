# ui-tokenize — Specification

Version: 0.1-rev1
Date: 2026-04-27 (post-Codex review)
Status: pre-implementation
Related: `01-research.md` (problem analysis), `03-interfaces.md` (wire formats), `04-plan.md` (build phases), `05-decisions.md` (resolved decisions), `06-codex-review.md` (external review), `07-revisions.md` (revision narrative)

> **Revision notice (2026-04-27).** This document is partially superseded by `07-revisions.md` and decisions D-018 through D-029 in `05-decisions.md`. The most affected sections are §FR-LOOP, §FR-PROPOSE, §FR-AUDIT, §NFR-PERF, §8 (behavior). Where this document and the revision documents disagree, the revision documents win. New requirements added by the revisions: FR-CONSUMER-DISC (consumer-API discovery), FR-MAINTAINER-1..5 (maintainer-mode safe-guards), FR-MONOREPO (multi-root scoping).

---

## 1. Goals

| # | Goal |
|---|---|
| G-1 | Make hardcoded UI values structurally impossible for an LLM coding agent to ship into the working tree |
| G-2 | Work in any frontend project with no required dependency on Tailwind, Style Dictionary, Stylelint, ESLint, or any specific component library |
| G-3 | Produce surface-aware, copy-pasteable corrections — not generic "use a token" warnings |
| G-4 | Close the feedback loop in-session, not at PR review time |
| G-5 | Bootstrap projects that have no token system today; augment projects that do |

## 2. Non-goals

| # | Non-goal | Rationale |
|---|---|---|
| NG-1 | Replace Style Dictionary | Existing tool; plugin reads its output if present |
| NG-2 | Ship yet another stylelint plugin | `stylelint-declaration-strict-value` is sufficient for CSS files |
| NG-3 | Lock the user into Tailwind / shadcn / any framework | Universal applicability is requirement G-2 |
| NG-4 | Sync with Figma | Tokens Studio's job; plugin reads disk only |
| NG-5 | Native mobile (SwiftUI / Compose / Flutter) in v1 | Different value model; deferred |
| NG-6 | Visual regression testing | Storybook / Chromatic territory |

## 3. Glossary

| Term | Definition |
|---|---|
| **Token** | A named design constant (color / spacing / radius / shadow / z-index / font-size / duration / breakpoint) defined in a recognized source |
| **DTCG** | W3C Design Tokens Community Group Format Module 2025.10 — the canonical interchange format |
| **Primitive token** | Raw value, internal layer (e.g. `color.blue.500 = #2563eb`) |
| **Semantic token** | Role-based, public-API layer (e.g. `color.text.danger = {color.red.700}`) |
| **Component token** | Component-scoped, depends on semantic (e.g. `button.primary.bg`) |
| **Catalog** | The plugin's in-memory + on-disk merged view of all discovered tokens |
| **Surface** | A code context that styles UI: CSS file, JSX inline `style={{}}`, styled-components template, Vue `<style>`, etc. |
| **Violation** | A literal UI value (hex / rgb / px / inline style number / Tailwind arbitrary bracket) emitted in a non-token source |
| **Block** | A PreToolUse hook return that prevents a `Write`/`Edit`/`MultiEdit` from completing |
| **Suggestion** | A surface-rendered token reference proposed in place of a violation |
| **Escape valve** | The `/tokenize:propose` flow used when no existing token fits |
| **Ledger** | `.tokenize/session.json` — persistent state for retry budgets and metrics |

## 4. System overview

```
                          ┌──────────────────────────┐
                          │  Token sources on disk   │
                          │  (DTCG / CSS / SCSS /    │
                          │   TS / Tailwind / etc.)  │
                          └────────────┬─────────────┘
                                       │
                              ┌────────▼─────────┐
                              │   discover lib   │
                              └────────┬─────────┘
                                       │
                          ┌────────────▼────────────┐
                          │  catalog (in-memory +   │
                          │  .tokenize/catalog.json)│
                          └─┬──────────┬───────────┬┘
                            │          │           │
              ┌─────────────▼┐  ┌──────▼──────┐  ┌─▼──────────────┐
              │ SessionStart │  │ PreToolUse  │  │ PostToolUse    │
              │  inject L0   │  │   block L1  │  │  verify L2     │
              └──────────────┘  └──────┬──────┘  └────────────────┘
                                       │
                                       ▼
                                 LLM agent
                                       │
                                       ▼
                              ┌────────────────┐
                              │ ledger L3      │
                              │ .tokenize/     │
                              │  session.json  │
                              └────────────────┘
```

Library boundaries: `discover`, `scanner`, `suggester`, `render`, `ledger`, `catalog`. Each independently testable. Hooks and slash commands are thin orchestration over these libraries.

## 5. Functional requirements

### FR-DISC: Token discovery

| ID | Requirement |
|---|---|
| FR-DISC-1 | Discover tokens at session start from any of: DTCG JSON, CSS `:root` blocks, SCSS variables, LESS variables, JS/TS theme exports, Tailwind config / `@theme`, CSS-in-JS theme objects |
| FR-DISC-2 | Merge multi-source catalogs into one canonical DTCG-formatted in-memory representation |
| FR-DISC-3 | Persist canonical catalog to `.tokenize/catalog.json` |
| FR-DISC-4 | Log conflicts (same token name, different value across sources) to `.tokenize/conflicts.json` without failing |
| FR-DISC-5 | Re-discover when any token-source file is modified mid-session |

### FR-DETECT: Violation detection

| ID | Requirement |
|---|---|
| FR-DETECT-1 | Detect hex color literals (3/4/6/8 digit) in style contexts |
| FR-DETECT-2 | Detect functional color notation: `rgb`, `rgba`, `hsl`, `hsla`, `oklch`, `oklab`, `lab`, `lch`, `color()` |
| FR-DETECT-3 | Detect bare CSS dimensions in style contexts: `\d+(px|rem|em|ch|vw|vh|svh|dvh|lvh|%)` |
| FR-DETECT-4 | Detect inline `style={{}}` objects with literal numbers / strings in JSX/TSX |
| FR-DETECT-5 | Detect tagged template literals (`styled.x\`\``, `css\`\``, `keyframes\`\``) containing literal values |
| FR-DETECT-6 | Detect Vue SFC `<style>` blocks and `:style` bindings |
| FR-DETECT-7 | Detect Svelte `<style>` blocks and `style:` directives |
| FR-DETECT-8 | Detect Astro `<style>` blocks |
| FR-DETECT-9 | Detect plain HTML `<style>` blocks and `style="…"` attributes |
| FR-DETECT-10 | Detect SVG color attribute literals: `fill`, `stroke`, `stop-color` (excluding `currentColor`, `url(...)`) |
| FR-DETECT-11 | Detect Tailwind arbitrary brackets `[…]` only when Tailwind config is present |
| FR-DETECT-12 | Exempt: token-source files, `:root`/`:host` declarations, files in user-defined `.tokenize/ignore` globs |
| FR-DETECT-13 | Recognize and flag obfuscation: `8 + 8`, `'#' + 'fff'`, hex-as-string `'0xff5500'` |

### FR-SUGGEST: Suggestion engine

| ID | Requirement |
|---|---|
| FR-SUGGEST-1 | For each violation, find exact value match in catalog (confidence 1.0) |
| FR-SUGGEST-2 | If no exact match, find nearest neighbor by type-appropriate distance metric |
| FR-SUGGEST-3 | Return up to 3 candidates ranked by confidence |
| FR-SUGGEST-4 | If no candidate above minimum confidence threshold, return null → block message includes propose-token escape |
| FR-SUGGEST-5 | Suggestion lookup must complete in < 5ms p95 |

### FR-RENDER: Surface-aware rendering

| ID | Requirement |
|---|---|
| FR-RENDER-1 | Given a token name + file context, produce a syntactically valid replacement string |
| FR-RENDER-2 | Support all surfaces in FR-DETECT-1 through FR-DETECT-11 |
| FR-RENDER-3 | Never produce a replacement that itself contains a literal value |

### FR-LOOP: Feedback loop

| ID | Requirement |
|---|---|
| FR-LOOP-L0 | At session start, inject categorized live catalog into agent context |
| FR-LOOP-L1 | On `PreToolUse` for `Write`/`Edit`/`MultiEdit`, scan tool input. If violation found, **hard-block** and emit structured suggestion |
| FR-LOOP-L2 | On `PostToolUse` for same tools, re-scan the written file and run any installed external linter; re-inject remaining issues as tool result |
| FR-LOOP-L3 | Maintain session ledger of blocks per `(file, region, literal)`; enforce retry budget (3 hard-blocks → soft-allow + escalation log) |
| FR-LOOP-L4 | When token-source file is modified, emit `"Catalog updated"` tool-result so agent's mental model refreshes |
| FR-LOOP-L5 | Across sessions, prepend known fabrication corrections to next L0 injection |

### FR-PROPOSE: Token proposal escape valve

| ID | Requirement |
|---|---|
| FR-PROPOSE-1 | `/tokenize:propose <value> "<intent>"` appends to `tokens.proposed.json` and returns a temp token name |
| FR-PROPOSE-2 | Temp tokens (matching `__proposed.*`) bypass PreToolUse blocks |
| FR-PROPOSE-3 | `/tokenize:audit` surfaces pending proposals for human review |

### FR-INIT: Project bootstrap

| ID | Requirement |
|---|---|
| FR-INIT-1 | `/tokenize:init` detects existing token sources and produces a discovery report |
| FR-INIT-2 | If no token source exists, scaffold an empty DTCG `tokens.json` with JSON schema reference |
| FR-INIT-3 | `--starter <name>` flag opt-in pulls a curated starter set (e.g. `shadcn`, `material`) |
| FR-INIT-4 | Generate `tokens.css` (CSS custom properties) and `tokens.ts` (typed export) from `tokens.json` |
| FR-INIT-5 | Optionally write `.gitignore` entries for `.tokenize/` |
| FR-INIT-6 | Idempotent — safe to re-run; never overwrites user edits |

### FR-AUDIT: Full-repo audit

| ID | Requirement |
|---|---|
| FR-AUDIT-1 | `/tokenize:audit` scans all matching files; produces violation report and token-coverage metric |
| FR-AUDIT-2 | Coverage = (styled declarations using tokens) / (total styled declarations); computed per category and overall |
| FR-AUDIT-3 | Exit with non-zero code on violations; CI-friendly |
| FR-AUDIT-4 | Output formats: human (default), `--json`, `--markdown` |

### FR-OBS: Observability

| ID | Requirement |
|---|---|
| FR-OBS-1 | `/tokenize:metrics` prints session ledger: violations, blocks, retries, escalations, fabrications, coverage delta |
| FR-OBS-2 | Metrics persisted to `.tokenize/session.json`; aggregable across sessions |
| FR-OBS-3 | `/tokenize:catalog [pattern]` prints the canonical catalog grouped by category |

## 6. Non-functional requirements

| ID | Requirement | Verification |
|---|---|---|
| NFR-PERF-1 | PreToolUse hook total latency < 50ms p95 on a 1000-token catalog | Bench harness with fixture |
| NFR-PERF-2 | PostToolUse hook total latency < 500ms p95 (excludes external linters) | Bench harness |
| NFR-PERF-3 | SessionStart < 200ms p95 with 1000 tokens | Bench harness |
| NFR-PERF-4 | Discovery scales linearly with project file count; < 2s for 10k files | Bench harness |
| NFR-COMPAT-1 | Works on macOS, Linux, Windows (WSL acceptable) | CI matrix |
| NFR-COMPAT-2 | Supports CSS, SCSS, LESS, JSX, TSX, Vue, Svelte, Astro, plain HTML in v1 | Fixture suite |
| NFR-DEPS-1 | Zero required runtime dependencies beyond chosen language stdlib + Claude Code | Manual install test |
| NFR-DEPS-2 | Stylelint, ESLint, Style Dictionary, Tailwind: detected and used if present, never required | Fixture matrix (with/without each) |
| NFR-PORT-1 | All paths use forward slashes internally; OS-specific separators only at I/O boundaries | Lint rule |
| NFR-SAFETY-1 | Malformed token sources never crash the plugin; degrade to last-known-good catalog and log to conflicts file | Fault-injection tests |
| NFR-SAFETY-2 | Empty catalog state surfaces clear error message; does not silently allow violations | Test case |
| NFR-SAFETY-3 | Plugin must never modify user-authored token files without explicit slash-command invocation | Audit |
| NFR-SAFETY-4 | Retry budget prevents infinite block loops; escalation always reachable | Test case |

## 7. Component architecture

| Component | Responsibility | Depends on |
|---|---|---|
| `lib/discover` | Scan project for token sources; produce canonical catalog | (none) |
| `lib/catalog` | In-memory + on-disk catalog; mutation API; conflict logging | `discover` |
| `lib/scanner` | Regex + AST violation detection per surface | (none) |
| `lib/suggester` | Lookup pipeline: exact → nearest → propose; distance metrics | `catalog` |
| `lib/render` | Token name + surface → replacement string | (none) |
| `lib/ledger` | `.tokenize/session.json` read/write; retry-budget API | (none) |
| `lib/format` | Block message format; tool-result formatting | (none) |
| `hooks/session-start` | L0 catalog injection | `catalog`, `format` |
| `hooks/pre-tool-use` | L1 scan + block | `scanner`, `suggester`, `render`, `ledger`, `format` |
| `hooks/post-tool-use` | L2 re-scan + external linters | `scanner`, `suggester`, `render`, `ledger`, `format` |
| `commands/init` | Bootstrap | `discover`, `catalog` |
| `commands/audit` | Full-repo scan + coverage | `scanner`, `catalog`, `suggester` |
| `commands/fix` | Apply replacements in batch | `scanner`, `suggester`, `render` |
| `commands/propose` | Escape-valve handler | `catalog` |
| `commands/catalog` | Print catalog | `catalog` |
| `commands/metrics` | Print session ledger | `ledger` |

## 8. Behavior: the feedback loop

Four nested control loops at increasing time scales. Detailed wire formats and budgets in `03-interfaces.md`.

| Layer | Trigger | Latency budget | Purpose |
|---|---|---|---|
| L0 | `SessionStart` | < 200ms | Inject categorized live catalog → reference setting |
| L1 | `PreToolUse` on `Write` / `Edit` / `MultiEdit` | < 50ms | **Hard-block** with structured suggestion before bad code lands on disk |
| L2 | `PostToolUse` on same tools | < 500ms | Re-scan written file; run external linters; re-inject remaining issues as tool result |
| L3 | Persistent ledger across turns | n/a | Track retries, fabrications, escalations |

### Block resolution sequence

```
attempt 1   →  hard block + suggestion
attempt 2   →  hard block + suggestion + "you retried similarly; try the exact replacement or /tokenize:propose"
attempt 3   →  hard block + force-escalate message
attempt 4+  →  soft-allow + escalation log entry + high-priority PostToolUse warning
```

Budget keyed by `(file_path, line_range, literal_value)`.

### Catalog refresh policy

| Trigger | Action |
|---|---|
| Session start | Full re-discovery; full L0 injection |
| Token-source file written | Re-discover; emit `"Catalog updated"` tool-result with delta |
| `/tokenize:catalog` invoked | Read `.tokenize/catalog.json`; print |
| Per-PreToolUse | No re-discovery; in-memory cache only |

### Failure-mode handling

| Failure | Behavior |
|---|---|
| Catalog empty | Block with explicit "no tokens defined yet — run `/tokenize:init` or `/tokenize:propose` for each value" |
| Catalog malformed | Degrade to last-known-good `.tokenize/catalog.json`; log to `.tokenize/conflicts.json` |
| Token name fabrication | PreToolUse validates token references against catalog; blocks unknown names with "did you mean: …?" |
| Adversarial obfuscation (`8 + 8`, `'#' + 'fff'`) | AST pass evaluates constant expressions; flags string concatenation in style contexts |
| `tokens.json` write by agent | Different ruleset: validate DTCG schema, validate name conventions, log to proposals queue rather than block-or-allow |
| External linter unavailable | Built-in scanner runs alone; no degradation |
| Tool latency exceeded | Lazy AST (only if regex hit); precompute value→token index at L0; cache per session |

## 9. Acceptance criteria

The plugin is acceptance-complete for v1 when:

| ID | Criterion |
|---|---|
| AC-1 | In a fixture project with a defined token set, an agent attempting to `Write` `padding: 16` is hard-blocked with a structured suggestion containing the correct token name and surface-rendered replacement |
| AC-2 | The same agent's retry using `tokens.space[4]` succeeds without further block |
| AC-3 | Three consecutive hard-blocks on the same `(file, region, literal)` produce a soft-allow + escalation log entry on attempt 4 |
| AC-4 | Modifying `tokens.json` mid-session triggers a `"Catalog updated"` tool-result containing the delta |
| AC-5 | An agent invoking `/tokenize:propose "#fb923c" "warning-bg"` receives a `__proposed.*` token name; subsequent `Write` using that name is not blocked |
| AC-6 | `/tokenize:init` in an empty directory produces `tokens.json` (empty DTCG), `tokens.css`, and `tokens.ts` |
| AC-7 | `/tokenize:init --starter shadcn` produces a populated DTCG token set |
| AC-8 | `/tokenize:audit` on the fixture project produces a violation report with non-zero exit on violations |
| AC-9 | Plugin works in a project with no Stylelint, no ESLint, no Style Dictionary, no Tailwind |
| AC-10 | Plugin augments (does not duplicate) Stylelint when Stylelint is present |
| AC-11 | All performance budgets in NFR-PERF-* met on the bench harness |
| AC-12 | Detection works for all surfaces listed in FR-DETECT-1 through FR-DETECT-10 (FR-DETECT-11 conditional on Tailwind presence) |
| AC-13 | Empty catalog produces explicit block message; never silently allows violations |
| AC-14 | Plugin runs to completion against a 10k-file fixture project within NFR-PERF-4 budget |
