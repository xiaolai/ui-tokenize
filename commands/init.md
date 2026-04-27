---
description: Discover existing token sources or scaffold a new ui-tokenize-managed token system
argument-hint: "[--starter shadcn|material]"
---

Run the ui-tokenize init subcommand. It discovers existing token sources or scaffolds a new system depending on what already exists in the project.

## Steps

1. **Run init.**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs" init $ARGUMENTS
   ```
   The CLI walks the project for any existing token sources (DTCG `tokens.json`, CSS `:root` blocks, SCSS / LESS / TS / Tailwind / CSS-in-JS).
2. **If tokens are found**, the CLI writes `.tokenize/catalog.json` and reports the discovery.
3. **If no tokens exist**, the CLI scaffolds a `tokens.json` (DTCG format), generates `tokens.css` (custom properties) and `tokens.ts` (typed export), and writes `.tokenize/config.json` in `consumer` mode.
4. **If `--starter <name>`** is passed (one of: `shadcn`, `material`), the new `tokens.json` is populated from a curated starter.
5. **Report the outcome to the user** using the format below, then suggest `/tokenize:catalog` to inspect the live catalog and `/tokenize:audit` to scan the codebase for hardcoded values.

## Output format

Pass through the CLI's lines verbatim. Expect one of these shapes:

- **Discovery:** `✓ Discovered <N> tokens across <M> sources:` followed by indented `  - <type>: <path> (<count> tokens)` lines, then a conflicts notice if any.
- **Scaffold:** `✓ Created <path>` then `✓ Generated tokens.css and tokens.ts.` then `✓ Created .tokenize/config.json (consumer mode).`
- **Abort:** `tokens.json exists at <path> but contained no tokens. Aborting init...` — do not retry; surface the message and stop.

End with the two suggestion bullets so the user knows the next step.
