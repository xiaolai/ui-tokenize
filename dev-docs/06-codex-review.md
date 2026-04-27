# Codex critical review of ui-tokenize design

Date: 2026-04-27
Reviewer: OpenAI Codex (gpt-5.4 via `codex exec`)
Scope: dev-docs/01–05 as of this date
Prompt: critical review across 12 dimensions; top blockers; nice-to-haves

---

## Numbered critiques

1. **The control loop is overfit to denial.** [FR-LOOP-L1/L3 in 02-spec.md](02-spec.md), [the retry sequence](02-spec.md), and [D-004/D-005](05-decisions.md) hardwire three hard rejects before fallthrough, but Claude Code already gives you `permissionDecision`, `permissionDecisionReason`, and `updatedInput` in `PreToolUse` via the [hooks reference](https://code.claude.com/docs/en/hooks). Exact-match cases should be rewritten and allowed, not pushed through an error path. Empirical evidence is thin, but what exists does not justify repeated denial loops: Anthropic pushes strict tool schemas and input examples / better tool descriptions to prevent bad retries; OpenAI says preserve non-zero outputs so the model can reason about recovery; Google's function-calling docs describe the loop but not reliable repeated self-correction. Inference: one corrective bounce helps; repeated identical bounces create loops, apologies, or evasive edits.

2. **The block-message format is the wrong abstraction.** [03-interfaces.md §3](03-interfaces.md) invents a fixed stderr protocol and one message per violation, while Claude Code already has native JSON control fields for `PreToolUse` and `PostToolUse` in the hooks reference. Use JSON `deny` plus compact `additionalContext`, not an error-looking wall of text. `Confidence`, `Surface`, and `Retry` are mostly noise; what is missing is the only thing the model actually needs: a project-valid patch. Your `Replacement:` field is often fiction anyway because the render map assumes `tokens`, `vars`, `theme`, `text-danger`, and `p-4` exist universally, while AC-2 and the M1 smoke test pretend `tokens.space[4]` is universal. It isn't.

3. **The retry budget shape is wrong.** [D-005](05-decisions.md) and the `(file, region, literal)` key reward brute force, reset when line numbers move, and explode on a single `MultiEdit` that touches ten files with the same literal. Soft-allow on attempt 4 teaches the model that the gate can be worn down. Budget per tool call or normalized diff chunk, auto-rewrite exact matches, and escalate to user/tooling instead of silent fallthrough.

4. **The discovery model is too naive and not even internally consistent.** [D-009](05-decisions.md) says `DTCG > CSS vars > SCSS/LESS > TS > Tailwind > CSS-in-JS`, while [03-interfaces.md](03-interfaces.md) collapses that to `DTCG > CSS vars > theme objects > Tailwind`. That alone is a spec bug. More importantly, real repos have category-split authority: spacing may be canonical in Tailwind, colors in CSS vars, motion in JSON. You need per-source and per-category authority plus alias detection, not one global total order.

5. **Surface coverage is overstated.** [FR-DETECT](02-spec.md) covers colors, dimensions, style objects, some templates, a few frameworks, Tailwind brackets, and a few SVG attrs. It does not cover `el.style.x = ...`, `style.cssText`, MUI/Chakra `sx`, JSS, Linaria, Compiled, Panda, UnoCSS, kuma-ui, Lit/Stencil static styles, MDX, Tailwind `@apply`, CSS Modules `:export/composes`, gradients, filters, or shadow-DOM styles in JS strings. Solid/Qwik/Mitosis may work only accidentally where a generic TSX parser catches `style={{}}`; Lit/Stencil/web components do not. Worse, the docs claim block types and distance metrics for `z-index`, `shadow`, `duration`, and `breakpoint` without matching detection requirements. That is silent miss territory.

6. **The escape valve is not first-class enough.** [FR-PROPOSE](02-spec.md) and the slash-command surface assume the model will self-invoke `/tokenize:propose`; that is wishful thinking. In Claude Code, slash commands are user entry points, not a reliable autonomous recovery channel, and hooks cannot trigger slash commands or tool calls per the hooks guide. `propose` needs to be an MCP tool from day one, or you need an `ask`/`defer` flow.

7. **TypeScript is fine. Bun-as-primary is not.** [D-007](05-decisions.md) is defensible only if the shipped artifact actually runs under Node everywhere and Bun is just a dev/build convenience. Rust is only worth the pain if you keep the per-call process model and need startup speed; Python is the worst compromise here because parser coverage across TSX/Vue/Svelte/Astro is weaker.

8. **The latency budget is fantasy under the chosen process model.** [NFR-PERF-1](02-spec.md) asks for `<50ms p95` on `PreToolUse`, but a fresh JS runtime, stdin parse, catalog load, scan, suggestion lookup, and ledger write already eat most of that before AST work. `MultiEdit` size makes it worse, and Windows/WSL will be uglier than a happy macOS laptop. If you care about that budget, use a resident daemon/HTTP hook; otherwise set the honest target closer to 150–250ms p95.

9. **Deferring semantic review to v0.2 is only safe if v1 never implies tokenized means correct.** [D-008](05-decisions.md) plus the coverage framing create false confidence: mature systems are often hurt more by semantically wrong or deprecated tokens than by naked literals. v1 output needs explicit labels like `semantics-unchecked` and `deprecation-unchecked`, or teams will over-trust the audit.

10. **D-015 is right as a default and wrong as an invariant.** [NFR-SAFETY-3](02-spec.md) and the special-case `tokens.json` behavior block legitimate workflows where the user explicitly wants the agent to add a token and use it. You need two modes: **consumer mode** forbids token-source edits; **maintainer mode** exposes a dedicated, user-authorized token-edit tool with schema, naming, and lifecycle validation.

11. **You missed several failure classes entirely.**
    - Same-turn `MultiEdit` that edits `tokens.json` and a consumer file is broken because refresh only happens after the write ([D-003](05-decisions.md), refresh policy)
    - Monorepos with multiple token roots are broken by a single global catalog
    - Parallel tool calls imply concurrent ledger writes but the ledger is a single JSON file with only vague "atomic writes" in the plan
    - Mode-aware suggestions despite [D-012](05-decisions.md)
    - Token deprecation/migration metadata
    - CSS specificity / `!important`
    - `@property` registered custom properties
    - Animation shorthands / timings
    - Gradient stops
    - **Consumer-API discovery** — discovering tokens is not discovering how the codebase actually consumes them

12. **The CI story is immature.** [FR-AUDIT-1/2/3](02-spec.md) define a repo-wide coverage gate, but coverage is a migration metric, not a PR gate: a valid new component can still move the denominator or hit unsupported surfaces and make the check noisy. Gate `no new violations on changed lines/files`, keep repo-wide coverage as trend data, and add `--baseline` / `--changed-only` / suppressions or teams will disable the check.

---

## Top 3 blockers (Codex)

- **Replace deny-first hook behavior with rewrite-first behavior** using Claude Code's native `PreToolUse` JSON controls. Exact matches should mutate `updatedInput`, not generate three rounds of error-like rejection.
- **Split token discovery from consumer-API discovery.** Until you know how a given project references tokens in JS / CSS / Tailwind / theme objects, your `Replacement:` output is guessing.
- **Make the escape/mutation path first-class.** Slash-command-only `propose`, queue-only token edits, and stale same-turn catalog handling break real maintainer workflows before M0 even starts.

## Nice to haves (Codex)

- Use `PostToolBatch` (or equivalent batched feedback) instead of per-violation spam for multi-file feedback
- Ship deterministic deprecation/lifecycle checks in v1 even if semantic review stays deferred
- Add per-category source authority config and baseline-aware CI modes before claiming "universal" discovery

## What you got right (Codex)

- Deterministic enforcement in hooks is the right layer; prose-only rules are not load-bearing ([01-research.md](01-research.md))

---

## Verbatim notes

Source: `codex exec` invocation 2026-04-27, model gpt-5.4. The reviewer used web fetches against `code.claude.com/docs/en/hooks`, `platform.claude.com/docs`, OpenAI shell-tools guide, and Google function-calling docs to ground its claims about hook capabilities and cross-vendor agent retry behavior. Original raw transcript at `/tmp/codex-review-raw.txt` (52k tokens, includes file-exploration noise).
