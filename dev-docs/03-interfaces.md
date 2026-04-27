# ui-tokenize — Interfaces

Version: 0.1-rev1
Date: 2026-04-27 (post-Codex review)
Related: `02-spec.md`, `07-revisions.md`

This document specifies wire formats, file schemas, hook contracts, and the slash-command surface. All formats are normative; changes here are breaking.

> **Revision notice (2026-04-27).** §3 (block message format) is fully superseded by R-02 in `07-revisions.md`: hook output is now JSON via Claude Code's native protocol (`permissionDecision`, `permissionDecisionReason`, `updatedInput`, `additionalContext`), not stderr fixed-field text. §6 discovery precedence is the canonical source; D-021 makes this per-category and configurable. New §10 (MCP tool surface) is added below — see R-06.

---

## 1. Hook contracts

All hooks read JSON from stdin, write to stdout/stderr, and signal block/allow via exit code. Behavior follows Claude Code hook protocol.

### 1.1 SessionStart

**Input (stdin):** Claude Code hook event JSON (see Claude Code hooks reference). Plugin reads only `session.id` and `cwd`.

**Output (stdout):** structured catalog injection (see §4 for format). Goes into agent context.

**Exit codes:** `0` always. Failures degrade to no injection + warning.

**Side effects:**

- Re-runs token discovery (`lib/discover`)
- Writes `.tokenize/catalog.json` (canonical DTCG)
- Writes `.tokenize/conflicts.json` if conflicts detected
- Writes new `.tokenize/session.json` with `sessionId`, `startedAt`

### 1.2 PreToolUse

**Triggers on tools:** `Write`, `Edit`, `MultiEdit`.

**Input (stdin):**

```json
{
  "session_id": "sess_…",
  "tool_name": "Write" | "Edit" | "MultiEdit",
  "tool_input": { /* tool-specific */ }
}
```

**Behavior:**

1. Resolve target file path from `tool_input`
2. Skip if file matches token-source patterns or user `.tokenize/ignore` globs
3. Run `lib/scanner` on `content` / `new_string` / `edits[*].new_string`
4. For each violation, run `lib/suggester` against `catalog`
5. Look up retry budget in `lib/ledger` for `(file, region, literal)`
6. If `attempts < 3`: hard-block; emit structured block message to **stderr**; exit `2`
7. If `attempts == 3`: hard-block with force-escalate message; exit `2`
8. If `attempts >= 4`: soft-allow; append to `.tokenize/escalations.json`; emit warning to **stdout**; exit `0`

**Block message format (stderr):** see §3 below.

### 1.3 PostToolUse

**Triggers on tools:** `Write`, `Edit`, `MultiEdit`.

**Input (stdin):** same shape as PreToolUse plus `tool_result` field.

**Behavior:**

1. Read the now-written file from disk
2. Run `lib/scanner` (catches what regex missed in pre-pass)
3. Run external linters if present:
   - `.css|.scss|.less` → `npx stylelint --fix` (only if `node_modules/stylelint` exists)
   - `.tsx|.jsx|.ts|.js` → `npx eslint --fix` (only if `node_modules/eslint` exists)
4. If file matches token-source patterns: trigger re-discovery; emit `"Catalog updated"` tool-result with delta
5. If remaining violations exist: emit them as tool-result for next-turn correction

**Output (stdout):** tool-result JSON; appended to agent context.

**Exit code:** `0` always (PostToolUse never blocks; the write already happened).

---

## 2. File schemas

All plugin-managed files live under `.tokenize/` except `tokens.json` and `tokens.proposed.json` which live at project root.

### 2.1 `tokens.json` — DTCG source of truth

W3C Design Tokens Format Module 2025.10 compliant. Three-tier nesting.

```json
{
  "$schema": "https://design-tokens.github.io/community-group/schemas/format/2025-10.json",
  "color": {
    "primitive": {
      "blue": {
        "500": { "$value": "#2563eb", "$type": "color" }
      }
    },
    "text": {
      "primary":  { "$value": "{color.primitive.gray.900}", "$type": "color" },
      "danger":   { "$value": "{color.primitive.red.700}",  "$type": "color" }
    }
  },
  "space": {
    "1": { "$value": "4px",  "$type": "dimension" },
    "2": { "$value": "8px",  "$type": "dimension" },
    "3": { "$value": "12px", "$type": "dimension" },
    "4": { "$value": "16px", "$type": "dimension" }
  }
}
```

**Plugin treats:** any group named `primitive` / `ref` / `base` as primitive (sealed from suggestion engine); all others as semantic (suggestable). Component tokens (e.g. `button.primary.bg`) are also suggestable.

### 2.2 `tokens.proposed.json` — escape-valve queue

```json
{
  "proposals": [
    {
      "id": "prop_2026-04-27_001",
      "value": "#fb923c",
      "intent": "warning-banner-bg",
      "proposedTokenName": "color.bg.warning",
      "callerFile": "src/components/Banner.tsx",
      "callerLine": 24,
      "callerSurface": "tsx-inline-style",
      "timestamp": "2026-04-27T10:14:32Z",
      "status": "pending"
    }
  ]
}
```

**Status transitions:** `pending` → `accepted` (codemod runs, real token added) | `rejected` (codemod replaces with suggested existing token) | `superseded` (a later proposal subsumes).

### 2.3 `.tokenize/catalog.json` — canonical merged catalog

```json
{
  "generatedAt": "2026-04-27T09:30:00Z",
  "sources": [
    { "type": "dtcg-json",      "path": "tokens.json",      "tokenCount": 87 },
    { "type": "css-vars",       "path": "src/styles/_root.css", "tokenCount": 12 },
    { "type": "tailwind-theme", "path": "tailwind.config.ts",   "tokenCount": 0  }
  ],
  "tokens": {
    "color.text.primary":  { "value": "#0b0f17", "type": "color",     "tier": "semantic", "originSource": 0 },
    "color.text.danger":   { "value": "#b91c1c", "type": "color",     "tier": "semantic", "originSource": 0 },
    "space.4":             { "value": "16px",    "type": "dimension", "tier": "semantic", "originSource": 0 }
  },
  "valueIndex": {
    "color": [
      { "value": "#0b0f17", "labLCH": [10.5, 0.4, 280], "tokens": ["color.text.primary"] },
      { "value": "#b91c1c", "labLCH": [40.0, 65.0, 32], "tokens": ["color.text.danger"]  }
    ],
    "dimension": [
      { "valuePx": 16, "tokens": ["space.4"] }
    ]
  }
}
```

`valueIndex` is the precomputed lookup structure used by `lib/suggester` to keep suggestion cost < 5ms.

### 2.4 `.tokenize/session.json` — session ledger

```json
{
  "sessionId": "sess_2026-04-27_001",
  "startedAt": "2026-04-27T09:30:00Z",
  "blocks": [
    {
      "file": "src/components/Button.tsx",
      "region": { "lineStart": 42, "lineEnd": 42, "literal": "16" },
      "type": "dimension",
      "attempts": 2,
      "firstAttemptAt": "2026-04-27T10:14:00Z",
      "lastAttemptAt":  "2026-04-27T10:14:08Z",
      "resolved": true,
      "resolvedTo": "tokens.space[4]"
    }
  ],
  "fabrications": [
    {
      "name": "color.brand.main",
      "occurredAt": "2026-04-27T10:01:00Z",
      "real": "color.brand.primary"
    }
  ],
  "escalations": [],
  "metrics": {
    "violationsDetected": 14,
    "blocksIssued": 11,
    "firstRetrySuccessRate": 0.82,
    "multiRetryRate": 0.18,
    "escalationRate": 0.00,
    "escapesToProposal": 2,
    "catalogHitRate": 0.94,
    "fabricationCount": 1,
    "coverageDeltaPct": 3.4
  }
}
```

### 2.5 `.tokenize/conflicts.json`

```json
{
  "conflicts": [
    {
      "tokenName": "color.text.primary",
      "definitions": [
        { "source": "tokens.json",         "value": "#0b0f17" },
        { "source": "src/styles/_root.css", "value": "#000000" }
      ],
      "resolution": "tokens.json",
      "detectedAt": "2026-04-27T09:30:01Z"
    }
  ]
}
```

Resolution rule: precedence DTCG JSON > scanned CSS variables > theme objects > Tailwind config. Documented in `02-spec.md` §FR-DISC-2.

### 2.6 `.tokenize/escalations.json`

```json
{
  "escalations": [
    {
      "file": "src/legacy/Header.tsx",
      "region": { "lineStart": 18, "literal": "999" },
      "type": "z-index",
      "attemptsExhaustedAt": "2026-04-27T11:02:00Z",
      "lastSuggestion": "z.modal",
      "lastSuggestionRejected": true,
      "reason": "model emitted same literal 4 times despite suggestion"
    }
  ]
}
```

Surfaces in `/tokenize:audit` and `/tokenize:metrics` for human review.

---

## 3. The block message format (wire)

Emitted to **stderr** by PreToolUse on block. The plugin's most load-bearing artifact.

### 3.1 Format

Plain text, fixed field order, line-prefixed:

```
[ui-tokenize] BLOCKED — hardcoded UI value
File:        src/components/Button.tsx
Region:      line 42, column 18
Found:       padding: 16
Type:        dimension (px)
Catalog:     space.4 = 16px
Confidence:  1.0 (exact match)
Replacement: padding: tokens.space[4]
Surface:     tsx-inline-style
Retry:       attempt 1 of 3
Escape:      if no token fits → /tokenize:propose 16 "<intent>"
```

### 3.2 Field reference

| Field | Required | Format | Notes |
|---|---|---|---|
| `File:` | yes | absolute or repo-relative path | |
| `Region:` | yes | `line N` or `line N–M, column C` | |
| `Found:` | yes | the literal as-emitted | echoes the agent's actual output |
| `Type:` | yes | `color` / `dimension` / `radius` / `shadow` / `z-index` / `font-size` / `duration` / `breakpoint` | |
| `Catalog:` | conditional | `<token-name> = <value>` (optional `<description>`) | omitted when no candidate |
| `Confidence:` | conditional | float `0.0`–`1.0` + qualifier | only when Catalog present |
| `Alternates:` | optional | comma-separated up to 2 fallback tokens | shown when confidence < 1.0 |
| `Replacement:` | conditional | rendered for the file's surface | omitted when no candidate |
| `Surface:` | yes | one of: `css`, `scss`, `less`, `tsx-inline-style`, `tsx-className`, `styled-components`, `emotion`, `vanilla-extract`, `vue-style`, `vue-inline`, `svelte-style`, `svelte-inline`, `astro-style`, `html-style`, `html-attr`, `tailwind-arbitrary`, `svg-attr` | |
| `Retry:` | yes | `attempt N of 3` or `attempts exhausted` | |
| `Escape:` | yes when no candidate or attempt ≥ 2 | suggested escape-valve invocation | |

### 3.3 Multi-violation case

When a single tool call contains multiple violations, emit one block message per violation, separated by `---`.

---

## 4. SessionStart catalog injection format (wire)

Emitted to **stdout** by SessionStart. Goes into agent context.

```
# ui-tokenize — design-token catalog (live, generated 2026-04-27T09:30:00Z)
# Source: tokens.json (87) + scanned :root blocks (12)
# Use these tokens; never emit hardcoded UI values.
# When no token fits: /tokenize:propose <value> "<intent>"

## color.text
- color.text.primary       #0b0f17  (default body text)
- color.text.secondary     #4a5568  (de-emphasized)
- color.text.danger        #b91c1c  (error states only)
- color.text.inverse       #ffffff  (on dark surfaces)

## color.bg
- color.bg.surface         #ffffff
- color.bg.surface.muted   #f7f8fa
- color.bg.danger          #fef2f2

## space (4px scale)
- space.1  4px    space.5  20px   space.9   36px
- space.2  8px    space.6  24px   space.10  40px
- space.3  12px   space.7  28px
- space.4  16px   space.8  32px

## radius
- radius.sm  4px    radius.md  8px    radius.lg  12px

## (… etc)

# Known fabrications from prior sessions:
# - "color.brand.main" — actual: color.brand.primary
```

**Sizing:** if catalog exceeds 4000 chars, group by category and inject only categories used in this project's source files (determined by greedy match in `lib/discover`). Detail-on-demand via `/tokenize:catalog`.

**Mid-session catalog updates** (PostToolUse on token-source file): emit a tool-result containing only the **delta**:

```
[ui-tokenize] Catalog updated.
Added: color.bg.warning (#fb923c), space.11 (44px)
Removed: color.text.tertiary
Renamed: color.brand.main → color.brand.primary
```

---

## 5. Slash-command surface

| Command | Args | Behavior | Output |
|---|---|---|---|
| `/tokenize:init` | `[--starter <name>]` | Detect or scaffold tokens; generate `tokens.css` + `tokens.ts` | Discovery report + scaffolded files |
| `/tokenize:audit` | `[--json | --markdown]` `[--fix]` | Full-repo scan; coverage metric | Violation report; non-zero exit on violations |
| `/tokenize:fix` | `[<glob>]` | Apply suggested replacements in-place | List of modified files + replacements applied |
| `/tokenize:propose` | `<value>` `"<intent>"` | Append to `tokens.proposed.json`; return temp token name | Temp token name |
| `/tokenize:catalog` | `[<pattern>]` | Print canonical catalog | Categorized list |
| `/tokenize:metrics` | (none) | Print session ledger | Metrics table |

**Starter names** (FR-INIT-3): `shadcn`, `material`, `polaris`, `primer`. Each ships a curated DTCG `tokens.json` for that design system's semantic layer.

---

## 6. Token source discovery rules

Detection signal → handler library mapping. Order is precedence (earlier wins on conflict).

| Order | Signal | Handler |
|---|---|---|
| 1 | File matching `tokens.json` / `tokens/**/*.json` / `design-tokens.json` with DTCG-shaped contents | `discover.dtcg` |
| 2 | `.css` / `.scss` / `.less` containing `:root {` or `:host {` blocks with `--*` declarations | `discover.css-vars` |
| 3 | `.scss` files with top-level `$name: value;` declarations | `discover.scss-vars` |
| 4 | `.less` files with top-level `@name: value;` declarations | `discover.less-vars` |
| 5 | `.ts` / `.tsx` / `.js` / `.jsx` exporting a named const matching `/^(tokens|theme|colors|spacing|radii|shadows)$/` | `discover.ts-export` |
| 6 | `tailwind.config.{js,ts}` with `theme.extend` OR any CSS file containing `@theme` directive | `discover.tailwind` |
| 7 | `vanilla-extract` `createTheme(…)` call | `discover.css-in-js.vanilla-extract` |
| 8 | `stitches` `createStitches({ theme: … })` call | `discover.css-in-js.stitches` |
| 9 | `styled-components` `ThemeProvider theme={…}` JSX literal | `discover.css-in-js.styled` |

Each handler emits zero or more `Token { name, value, type, tier, sourceFile }` records into the catalog merger.

---

## 7. Surface-aware rendering map

Token reference renderer dispatch table. Input: `tokenName`, `surface`. Output: replacement string.

| Surface | `space.4 = 16px` renders as | `color.text.danger = #b91c1c` renders as |
|---|---|---|
| `css` | `var(--space-4)` | `var(--color-text-danger)` |
| `scss` | `$space-4` | `$color-text-danger` |
| `less` | `@space-4` | `@color-text-danger` |
| `tsx-inline-style` | `tokens.space[4]` | `tokens.color.text.danger` |
| `tsx-className` (Tailwind) | `p-4` | `text-danger` |
| `styled-components` | `${({ theme }) => theme.space[4]}` | `${({ theme }) => theme.color.text.danger}` |
| `emotion` (object) | `tokens.space[4]` | `tokens.color.text.danger` |
| `vanilla-extract` | `vars.space[4]` | `vars.color.text.danger` |
| `vue-style` | `var(--space-4)` | `var(--color-text-danger)` |
| `vue-inline` | `tokens.space[4]` (TS) or `var(--space-4)` (template) | analogous |
| `svelte-style` | `var(--space-4)` | `var(--color-text-danger)` |
| `astro-style` | `var(--space-4)` | `var(--color-text-danger)` |
| `html-style` / `html-attr` | `var(--space-4)` | `var(--color-text-danger)` |
| `svg-attr` | `var(--space-4)` (color attrs only) | `currentColor` if maps to currentColor; otherwise `var(--color-text-danger)` |
| `tailwind-arbitrary` | `p-4` (or arbitrary `[var(--space-4)]` if no utility maps) | `text-danger` |

Token name → CSS custom property name transform: dot-replace `.` with `-`, prefix `--`. (`color.text.danger` → `--color-text-danger`).

Token name → JS path transform: dot-path with bracket-access on numeric segments. (`space.4` → `tokens.space[4]`; `color.text.danger` → `tokens.color.text.danger`).

---

## 8. Distance metrics

Per-type distance functions used by `lib/suggester` for nearest-neighbor lookup.

| Type | Metric | High confidence | Low confidence | Reject above |
|---|---|---|---|---|
| `color` | CIE Lab ΔE2000 | < 2.0 | < 5.0 | ≥ 5.0 |
| `dimension` (spacing/radius) | Nearest scale step OR `≤ 25%` relative error | exact step | within 1 step | > 1 step |
| `font-size` | Nearest scale step | exact step | within 1 step | > 1 step |
| `z-index` | Bucket match (semantic groups: base / dropdown / overlay / modal / toast / tooltip / max) | bucket match | adjacent bucket | non-adjacent |
| `shadow` | All components within ≤ 10% (offsetX, offsetY, blur, spread, color ΔE) | all match exact | all within 10% | any exceeds |
| `duration` / `cubic-bezier` | Exact list lookup only | exact | n/a | always reject if not exact |
| `breakpoint` | Exact match only | exact | n/a | always reject if not exact |

When no candidate clears the rejection threshold, suggestion engine returns null → block message includes only the propose-token escape.

---

## 9. Plugin manifest

`.claude-plugin/plugin.json` minimum:

```json
{
  "name": "ui-tokenize",
  "version": "0.1.0",
  "description": "Block hardcoded UI values; enforce design tokens with a closed-loop control system",
  "author": { "name": "xiaolai" },
  "hooks": {
    "SessionStart": "hooks/session-start",
    "PreToolUse":   { "matcher": "Write|Edit|MultiEdit", "command": "hooks/pre-tool-use" },
    "PostToolUse":  { "matcher": "Write|Edit|MultiEdit", "command": "hooks/post-tool-use" }
  },
  "commands": [
    "commands/init",
    "commands/audit",
    "commands/fix",
    "commands/propose",
    "commands/catalog",
    "commands/metrics"
  ]
}
```

Final hook configuration syntax conforms to current Claude Code hook schema; verify against `code.claude.com/docs/en/hooks` at implementation time.
