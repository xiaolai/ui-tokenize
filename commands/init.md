---
description: Discover existing token sources or scaffold a new ui-tokenize-managed token system
argument-hint: "[--starter shadcn|material]"
---

Run the ui-tokenize init subcommand. It will:

1. Walk the project for any existing token sources (DTCG `tokens.json`, CSS `:root` blocks, SCSS / LESS / TS / Tailwind / CSS-in-JS).
2. If tokens are found, write `.tokenize/catalog.json` and report the discovery.
3. If no tokens exist, scaffold a `tokens.json` (DTCG format), generate `tokens.css` (custom properties) and `tokens.ts` (typed export), and write `.tokenize/config.json` in `consumer` mode.
4. If `--starter <name>` is passed (one of: `shadcn`, `material`), populate the new `tokens.json` from a curated starter.

Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs" init $ARGUMENTS
```

After it finishes, summarize the result for the user. Then suggest:

- `/tokenize:catalog` to inspect the live catalog
- `/tokenize:audit` to scan the codebase for hardcoded values
