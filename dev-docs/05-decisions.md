# ui-tokenize — Decisions Log

Version: 0.1-rev1
Date: 2026-04-27 (last update post-Codex review)

Decisions accumulate here. Each row records the question, options considered, the choice made, and the rationale. Update by appending; never silently change a past decision. When a decision is reversed, mark `status = superseded` and reference the new decision.

For the full revision narrative, see `07-revisions.md`.

---

## Active decisions

| # | Decision | Date | Status | Rationale |
|---|---|---|---|---|
| D-001 | v1 scope is web-only (CSS / SCSS / LESS / JSX / TSX / Vue / Svelte / Astro / plain HTML) | 2026-04-27 | accepted | React Native uses similar patterns and can be added in v0.3 cheaply; native mobile (SwiftUI / Compose / Flutter) has a different value model and warrants its own plugin or major version |
| D-002 | `/tokenize:init` is empty by default; `--starter <name>` opt-in flag pulls a curated set | 2026-04-27 | accepted | Hybrid avoids imposing taste while still offering a fast path for users who want one. Starters: `shadcn`, `material` (others added in v0.2+) |
| D-003 | Catalog refreshes at SessionStart, plus invalidation on PostToolUse when a token-source file is written | 2026-04-27 | accepted | Re-reading on every PreToolUse blows the latency budget. SessionStart + invalidate-on-write keeps the catalog fresh with bounded cost |
| D-006 | `tokens.json` rebuild to `tokens.css` / `tokens.ts` is invoked by user via CLI command, not via file watcher | 2026-04-27 | accepted | Lowest magic, language-agnostic, works without npm hooks. Users wire `npx ui-tokenize build` into whichever build system they already use |
| D-008 | `token-reviewer` semantic-mis-pick subagent deferred to v0.2 | 2026-04-27 | accepted | v1 ships the deterministic enforcement loop. Semantic review (catching e.g. `color.text.danger` used for an info banner) requires LLM judgment and is additive — not load-bearing for the core problem. Audit ships `semantics-unchecked` labels in v0.1 (R-10) so deferral does not create false confidence |
| D-012 | Multi-mode catalogs (light/dark/density/etc.) deferred to v0.2 | 2026-04-27 | accepted | Adds significant complexity to renderer (which mode does the suggestion target?) and discovery. v1 supports a single resolved catalog; modes are an additive layer |
| D-013 | `__proposed.*` token namespace bypasses PreToolUse blocks | 2026-04-27 | accepted | Required for the escape-valve workflow to function. The convention is sufficiently distinctive that it cannot collide with user tokens |
| D-014 | External linter integration is opt-out (auto-detect via `node_modules/<tool>`) not opt-in | 2026-04-27 | accepted | If the user has Stylelint installed, they want it run; the plugin should augment without configuration. `.tokenize/config.json` flag can disable per-tool if needed |
| D-016 | Plugin must never automatically install Stylelint, ESLint, or other tools | 2026-04-27 | accepted | Dependency hygiene per project CLAUDE.md. Plugin detects what's there; recommends in `/tokenize:init` output but doesn't install |
| D-017 | Discovery and scanner files are skipped if matched by the user's `.gitignore` | 2026-04-27 | accepted | Prevents scanning `node_modules`, `dist`, build artifacts. User can add `.tokenize/ignore` for additional patterns |
| D-018 | PreToolUse hook is **rewrite-first** for confidence-1.0 exact matches; deny only on multi-candidate / no-candidate / dynamic | 2026-04-27 | accepted | Codex critique #1. When we know the right answer, applying it is cheaper than negotiating with the model. Repeated denials cause apologies and evasive edits. Uses Claude Code's native `permissionDecision: "allow"` + `updatedInput` |
| D-019 | Retry budget keyed by tool-call count for unresolved violations; after 2 denies, third response instructs `tokenize__propose`; no silent soft-allow | 2026-04-27 | accepted | Codex critique #3. Per-region keying resets when line numbers shift and explodes on MultiEdit. Soft-allow teaches the gate can be worn down |
| D-020 | Implementation language: pure Node.js ESM (`.mjs`), Node 20+, zero runtime dependencies in v0.1 | 2026-04-27 | accepted | Codex critique #7. Bun-as-primary requires Bun on every user machine; compiled artifacts add build pipeline burden. Pure Node ESM Just Runs after `claude plugin install`. AST parsing deferred to v0.2 when `oxc-parser` (with prebuilt binaries) becomes a justified dep |
| D-021 | Discovery precedence is **per-category**, configurable in `.tokenize/config.json`; default ordering matches `03-interfaces.md` §6 | 2026-04-27 | accepted | Codex critique #4. Real repos have category-split authority (spacing in Tailwind, colors in CSS vars). Single global order produces surprising merges |
| D-022 | Hook output is JSON via Claude Code's native protocol (`permissionDecision`, `permissionDecisionReason`, `updatedInput`, `additionalContext`) | 2026-04-27 | accepted | Codex critique #2. Native protocol; matches what the model sees in tool-result-error frames; no plain-text parsing fragility |
| D-023 | MCP server with first-class agent tools ships in v0.1 (`list_tokens`, `find_closest`, `propose` always; `add_token`, `deprecate` in maintainer mode) | 2026-04-27 | accepted | Codex critique #6. Slash commands are user entry points; MCP tools are the model's native recovery channel. Hooks cannot trigger slash commands |
| D-024 | Two operation modes in `.tokenize/config.json`: `consumer` (default, token files read-only) and `maintainer` (token-mutation MCP tools enabled with strict validation) | 2026-04-27 | accepted | Codex critique #10. Some projects want the agent to manage tokens; absolute prohibition breaks legitimate workflows. Mode gating + validated MCP tools preserve safety |
| D-025 | Honest latency budget: PreToolUse < 250ms p95 with per-call process model in v0.1; daemon mode for < 50ms p95 deferred to v0.2 | 2026-04-27 | accepted | Codex critique #8. Cold-start a Node process + parse stdin + read catalog + scan + write ledger does not fit in 50ms. Pretend-budgets ship perf-failures |
| D-026 | CI default gate is `--changed-only` against baseline ref; absolute coverage is trend metric only | 2026-04-27 | accepted | Codex critique #12. Repo-wide coverage as PR gate is noisy on legitimate new components and unsupported surfaces. Changed-lines-only is the right shape |
| D-027 | v0.1 surface coverage is regex-only; explicit "supported v0.1" list published; AST scanners deferred to v0.2 | 2026-04-27 | accepted | Codex critique #5. Claiming universal coverage when regex misses half the CSS-in-JS ecosystem creates false confidence. Honest scope statement + roadmap |
| D-028 | Concurrent ledger writes use per-PID append-only NDJSON files; compaction at SessionStart | 2026-04-27 | accepted | Codex critique #11. Single-JSON-file ledger races under parallel hook invocations. Per-PID append is conflict-free by construction |
| D-029 | Monorepo / multi-root: catalog scoped to nearest ancestor directory containing a token source; each scope has its own `.tokenize/` dir | 2026-04-27 | accepted | Codex critique #11. Single global catalog is wrong in a monorepo with package-local tokens. Discovery walks up from the file being edited |

---

## Superseded decisions

| # | Original decision | Date | Status | Superseded by |
|---|---|---|---|---|
| D-004 | PreToolUse default is hard block | 2026-04-27 | superseded | D-018 (rewrite-first) |
| D-005 | Retry budget per `(file, region, literal)`; soft-allow at attempt 4+ | 2026-04-27 | superseded | D-019 (per-tool-call; no silent soft-allow) |
| D-007 | Implementation language is TypeScript via Bun with Node fallback | 2026-04-27 | superseded | D-020 (pure Node ESM, no compile, no deps) |
| D-009 | Discovery precedence: single global order DTCG > CSS-vars > SCSS > LESS > TS > Tailwind > CSS-in-JS | 2026-04-27 | superseded | D-021 (per-category, configurable) |
| D-010 | Block message format is plain-text fixed-field, not JSON | 2026-04-27 | superseded | D-022 (native JSON hook protocol) |
| D-011 | MCP server exposing the catalog deferred to v0.2 | 2026-04-27 | superseded | D-023 (MCP server in v0.1) |
| D-015 | Plugin must never modify `tokens.json` without slash-command invocation | 2026-04-27 | superseded | D-024 (consumer/maintainer modes; validated MCP token-mutation tools) |

---

## Open / pending decisions

None outstanding for v0.1. Re-open by appending a new row with `status = pending` if a question surfaces during implementation.
