---
description: Print the session ledger — blocks, rewrites, fabrications, escalations
---

Compact the per-PID NDJSON ledger and print the resulting session metrics.

Execute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/commands/cli.mjs" metrics
```

Show:

- Block / rewrite / escape counts
- Fabrications observed (token names the agent invented)
- Files with unresolved violations

These metrics inform whether the catalog is sufficient or whether more tokens are needed (high `escapesToProposal` or repeated fabrications signal catalog gaps).
