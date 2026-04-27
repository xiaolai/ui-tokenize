# Research: Why LLMs hardcode UI values, and what professionals do about it

Date: 2026-04-27
Status: research synthesis, pre-implementation

## 1. Problem statement

LLM coding agents (Claude, Cursor, Copilot) routinely emit hardcoded UI values — hex colors, raw pixel numbers, magic z-indices, inline style objects with literal numbers — even when explicitly told not to. This produces design-token drift, theming breakage, and review fatigue. The frustration is well-documented in practitioner reports (Hardik Pandya, "Expose your design system to LLMs"; Bar Shaya, "Enforcing design tokens"). The core failure is not user error; it is structural.

## 2. Why prose rules fail

Three empirical failure modes:

| Failure | Mechanism | Evidence |
|---|---|---|
| Prose rules collapse under task pressure | Mid-task, the model takes the locally easiest path; "no hardcoded values" in CLAUDE.md is overridden by "make this work now" | Reproducible across all major coding agents |
| Token name fabrication | Pasted catalogs go stale; model pattern-matches plausible names instead of retrieving real ones (e.g. invents `--color-brand-main` when the real token is `--brand-primary`) | Multiple practitioner reports of catalog drift mid-session |
| No feedback loop | Hardcoded value emitted in turn N is not detected until human review or CI; by then the agent has moved on; next emission repeats the mistake | Standard lint pipelines run too late for LLM cycles |

Implication: **the deterministic enforcement must live in hooks and code, not in markdown.** Prose rules remain useful as background context, but cannot be load-bearing.

## 3. The professional stack (what mature teams converged on)

The architecture is consistent across Material 3, Adobe Spectrum, GitHub Primer, Atlassian, Shopify Polaris, IBM Carbon, and Salesforce SLDS:

| Layer | Tool / standard | Job |
|---|---|---|
| Specification | W3C DTCG Format Module 2025.10 (first stable Oct 2025) | Vendor-neutral JSON: `$value`, `$type`, `$description`, alias refs `{group.token}` |
| Token tiers | Primitive → Semantic → Component | Public API is *semantic only*; primitives sealed; component tokens optional |
| Build | Style Dictionary v4 (DTCG-native) | Compile DTCG → CSS custom properties + typed TS + Tailwind theme + native |
| Authoring | Tokens Studio for Figma → git sync | Designer-editable, git-backed |
| Distribution | CSS custom properties + typed TS + (optional) Tailwind `@theme` | Runtime themeable + compile-time safety |
| CSS lint | `stylelint-declaration-strict-value` | Force `var(--*)` for color/background/spacing/radius/etc — the single most important off-the-shelf rule |
| JSX/TSX lint | `@atlaskit/eslint-plugin-design-system`, `eslint-plugin-tailwindcss`, `no-restricted-syntax` patterns | Block hex/rgb/px in JSX, arbitrary Tailwind brackets |
| Codemods | `jscodeshift`, `ts-morph`, Atlassian Hypermod recipes | Bulk migration & token renames |
| Gate | `husky` + `lint-staged --max-warnings=0` + CI token-coverage metric | Block commits AND PRs that drop coverage |
| Component API | shadcn-style semantic-only (`bg-primary`, no `bg-blue-500` exists) or Box props (`<Box p="4">`) | Make the right thing the *only available path* |

## 4. Token tier conventions across major systems

Every system independently converged on three tiers with different vocabularies:

| System | Layer 1 (raw) | Layer 2 (semantic) | Layer 3 (component) |
|---|---|---|---|
| Material 3 | `md.ref.*` (reference) | `md.sys.*` (system) | `md.comp.*` |
| Adobe Spectrum | global | alias | component (e.g. `--spectrum-actionbutton-border-color-default`) |
| GitHub Primer | base | functional (text/border/bg/shadow) | pattern/component |
| Atlassian | palette (internal) | `color.text.danger` (foundation.property.modifier) | (consumer-side) |
| Shopify Polaris | `space-100`..`space-400` (4px scale) | `color.bg.surface` with `-hover/-active/-disabled` suffixes | per-component |
| IBM Carbon | IBM color palette (`$ibm-color__blue--60`) | role-based (`$interactive-01`, `$ui-01`) | theme-resolved |
| Salesforce SLDS 2 | (sealed) | "global styling hooks" (CSS custom properties) | hook overrides |
| shadcn/ui | (none — semantic only) | `--background`, `--primary`, `--destructive`, `--muted` with `-foreground` pairs | per-component |

### Naming conventions that work

- Strict three-tier separation; primitives never appear in component code
- Role-based names (`color.text.danger`) outlive value churn
- State as suffix (`-hover`, `-disabled`) keeps namespaces flat
- Foreground/background pairing (shadcn, Primer) makes contrast accidents harder
- Numeric scales tied to a base unit (Polaris `space-100 = 4px`) eliminate "is it 14 or 16?" debates

### Naming conventions that fail

- Names that encode value (`color-blue-500`) — break the moment brand changes
- Deeply nested namespaces (`md.sys.color.surface.container.high`) — verbose, easy for LLMs to typo into fabrications
- Mixing camelCase and kebab-case across JSON/JS/CSS surfaces (Polaris) — increases hallucination
- Component tokens that proliferate without semantic backing — explodes surface area

## 5. Linting tools — verified status as of 2026-04

### Actively maintained, proven

| Tool | Job | Notes |
|---|---|---|
| `stylelint-declaration-strict-value` (AndyOGo) | Force a property to be a CSS variable, function, or allowed keyword | The single most important off-the-shelf rule. Configurable per-property with regex. |
| `@atlaskit/eslint-plugin-design-system` | `ensure-design-token-usage`, `no-unsafe-design-token-usage`, `no-deprecated-design-token-usage` | Auto-fixers built in. Atlassian-specific but the rule patterns are reusable. |
| `eslint-plugin-react-native` (`no-color-literals`) | Flag string color literals in StyleSheet/style props | Stable |
| `eslint-plugin-tailwindcss` (francoismassart) | `no-arbitrary-value` (blocks `p-[17px]`), `no-unnecessary-arbitrary-value` (auto-rewrites `m-[1.25rem]` → `m-5`) | Known false-positive on `data-[state=open]:` modifiers (issue #318) |
| Stylelint built-in `declaration-property-value-allowed-list` | Declarative allow-list per property | Useful as backstop |

### Stagnant or deprecated — do NOT depend on

| Tool | Reason |
|---|---|
| `stylelint-design-tokens-plugin` (LasaleFamine) | Last release 0.0.14, four years stale; uses unusual `env()` syntax |
| Generic "stylelint-design-tokens" name | Does not correspond to a real maintained package |

## 6. CI / pre-commit pyramid

The standard enforcement layout:

1. **Editor (real-time):** ESLint/Stylelint LSP feedback while typing. Catches ~70% before commit.
2. **Pre-commit (`husky` + `lint-staged`):** Lint only staged files. `--max-warnings=0` blocks commit on a single violation.
3. **CI gate:** Re-run full lint, plus a custom token-coverage report (% of color/spacing/radius declarations referencing a token). Fail PRs that decrease coverage.
4. **Codemod on demand:** Bulk migration via `jscodeshift`/Hypermod when introducing or renaming tokens. Atlassian's lifecycle (active → deprecated → soft-deleted → removed) is the gold standard.
5. **Visual regression:** Storybook + Chromatic snapshot tests confirm token changes don't break rendering.

The pattern that prevents drift in practice is **`lint-staged` with `--max-warnings=0` plus a CI coverage gate**. CI-only fails too late; pre-commit + editor feedback is where the loop closes.

## 7. AI/LLM-specific context

### Existing rule-file mechanisms

| Tool | File | Notes |
|---|---|---|
| Cursor | `.cursor/rules/*.mdc` | YAML frontmatter (`description`, `globs`, `alwaysApply`) + markdown body. Per-glob scoping |
| GitHub Copilot | `.github/copilot-instructions.md` + `.github/instructions/*.instructions.md` | `applyTo` glob frontmatter; per-file-type rules |
| Claude Code | `CLAUDE.md`, `AGENTS.md` | `AGENTS.md` is the cross-tool standard adopted by Copilot in Aug 2025 |

### Component API patterns that constrain LLMs

- **shadcn/ui** ships only semantic tokens (`--primary`, `--destructive`, foreground pairs). The model's only viable utility is `bg-primary text-primary-foreground` — there is no `bg-blue-600` *path* to take.
- **Box-style prop APIs** (`<Box p="4" bg="surface">`) where props are typed unions of token names. Hardcoded values become type errors.
- **Radix Primitives** are unstyled; without a token-bound styling layer on top they offer no LLM constraint at all.

### Knapsack added an MCP server in 2025

Knapsack ($10M raise Oct 2025) exposes its token catalog over MCP, so any agent can query the live catalog. Validates the model-context approach for tokens.

## 8. Gaps existing tooling does not fill

| Gap | Why no existing tool covers it |
|---|---|
| Inline `style={{ padding: 16 }}` in TSX | Stylelint sees only CSS files; `eslint-plugin-tailwindcss` sees only className strings. Most projects have nothing covering this surface. |
| Mid-session token-name drift | Model uses correct token in turn 3, fabricates new one in turn 17. No lint rule catches this until commit. |
| Stale catalog injection | Every `CLAUDE.md` example pastes the token list once; it diverges from the build immediately. |
| No feedback loop back to the agent | Violations get fixed by humans, not fed back to the model so the next emission corrects. |
| No "propose new token" escape valve | When the model genuinely needs a new value, hardcoding is the only ergonomic path — so it hardcodes. |
| Cross-tool semantic mis-pick | Using `color.text.danger` for an info banner: technically a token, semantically wrong. Lint can't catch this. |
| Figma ↔ code parity | No production-quality tool diffs Figma variables against production tokens. |

These are exactly the gaps a Claude Code plugin can close, because it has access to the conversation, the prompt, the in-flight diff, and tool calls *before* they land on disk.

## 9. Sources

- W3C DTCG — [first stable version (Oct 2025)](https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/)
- [DTCG Format Module 2025.10](https://www.designtokens.org/tr/drafts/format/)
- Style Dictionary — [v4 statement](https://styledictionary.com/versions/v4/statement/), [DTCG support](https://styledictionary.com/info/dtcg/)
- [GitHub Primer token names](https://primer.style/product/primitives/token-names/)
- [Material 3 design tokens](https://m3.material.io/foundations/design-tokens)
- [Adobe Spectrum design tokens](https://spectrum.adobe.com/page/design-tokens/)
- [Atlassian design tokens](https://atlassian.design/foundations/design-tokens/) · [eslint-plugin-design-system](https://atlassian.design/components/eslint-plugin-design-system/) · [migrate to tokens](https://atlassian.design/tokens/migrate-to-tokens/)
- [Shopify Polaris tokens](https://polaris-react.shopify.com/design/colors/color-tokens)
- [IBM Carbon design system](https://github.com/carbon-design-system/carbon)
- [shadcn/ui theming](https://ui.shadcn.com/docs/theming)
- [Radix Primitives styling](https://www.radix-ui.com/primitives/docs/guides/styling)
- [Tokens Studio docs](https://docs.tokens.studio) · [SD Transforms](https://docs.tokens.studio/transform-tokens/style-dictionary)
- [Knapsack design tokens & theming](https://www.knapsack.cloud/feature-listing/design-tokens-theming) · [Knapsack $10M (TechCrunch)](https://techcrunch.com/2025/10/09/knapsack-picks-up-10m-to-help-bridge-the-gap-between-design-and-engineering-teams/)
- [stylelint-declaration-strict-value](https://github.com/AndyOGo/stylelint-declaration-strict-value)
- [stylelint declaration-property-value-allowed-list](https://github.com/stylelint/stylelint/blob/main/lib/rules/declaration-property-value-allowed-list/README.md)
- [eslint-plugin-tailwindcss](https://github.com/francoismassart/eslint-plugin-tailwindcss) · [no-arbitrary-value](https://github.com/francoismassart/eslint-plugin-tailwindcss/blob/master/docs/rules/no-arbitrary-value.md)
- [eslint-plugin-react-native no-color-literals](https://github.com/Intellicode/eslint-plugin-react-native/blob/master/docs/rules/no-color-literals.md)
- [Hypermod — automating design system evolution](https://www.hypermod.io/blog/7-automating-design-system-evolution)
- [lint-staged](https://github.com/lint-staged/lint-staged)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [VS Code Copilot custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)
- [Copilot AGENTS.md changelog (Aug 2025)](https://github.blog/changelog/2025-08-28-copilot-coding-agent-now-supports-agents-md-custom-instructions/)
- [Hardik Pandya — Expose your design system to LLMs](https://hvpandya.com/llm-design-systems)
- [Bar Shaya — Enforcing design tokens, a practical guide](https://medium.com/@barshaya97_76274/design-tokens-enforcement-977310b2788e)
- [Naming tokens — Nathan Curtis (EightShapes)](https://medium.com/eightshapes-llc/naming-tokens-in-design-systems-9e86c7444676)
- [Tailwind v4 launch](https://tailwindcss.com/blog/tailwindcss-v4) · [theme variables](https://tailwindcss.com/docs/theme)
