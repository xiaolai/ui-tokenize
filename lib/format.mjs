// JSON hook output formatter (D-022).
// All hook responses use Claude Code's native PreToolUse/PostToolUse JSON shape.

/**
 * @typedef {import('./scanner.mjs').Violation} Violation
 * @typedef {import('./suggester.mjs').Suggestion} Suggestion
 *
 * @typedef {object} ViolationReport
 * @property {Violation} violation
 * @property {Suggestion|null} primary
 * @property {Suggestion[]} alternates
 * @property {string|null} renderedReplacement
 */

/**
 * Build a PreToolUse "allow + rewrite" response.
 *
 * @param {object} updatedInput - the mutated tool input
 * @param {ViolationReport[]} rewrites
 * @returns {object}
 */
export function allowRewrite(updatedInput, rewrites) {
  const summary = rewrites
    .map((r) => `${r.violation.literal} → ${r.renderedReplacement}`)
    .join('; ');
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `[ui-tokenize] auto-rewrote ${rewrites.length} literal(s): ${summary}`,
      updatedInput,
    },
  };
}

/**
 * Build a PreToolUse deny response with structured suggestions.
 *
 * @param {ViolationReport[]} reports
 * @param {{retryAttempt: number, mode: string, modeHint?: string}} ctx
 * @returns {object}
 */
export function denyWithSuggestions(reports, ctx) {
  const lines = reports.map(formatReport).join('\n\n');
  const escape = ctx.retryAttempt >= 1
    ? '\nIf no token fits, call the MCP tool tokenize__propose(value, intent). It returns a temporary __proposed.* name you can use immediately.'
    : '';
  const stop = ctx.retryAttempt >= 2
    ? '\nThis is your final attempt. Repeated denials will hard-stop further edits to this file. Either apply the suggestion, call tokenize__propose, or stop.'
    : '';
  const reason = `[ui-tokenize] ${reports.length} hardcoded UI value(s) detected.\n\n${lines}${escape}${stop}`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Build a hard-stop deny when the retry budget is exhausted.
 *
 * @param {string} reason
 * @returns {object}
 */
export function hardStop(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[ui-tokenize] HARD-STOP — ${reason}\n\nNo further edits to this file will be accepted in this session until the unresolved violation is addressed via tokenize__propose or by manual user intervention.`,
    },
  };
}

/**
 * PostToolUse output: catalog updated message with delta.
 *
 * @param {{added: string[], removed: string[], renamed: Array<{from: string, to: string}>}} delta
 * @returns {object}
 */
export function catalogUpdatedMessage(delta) {
  const parts = [];
  if (delta.added?.length) parts.push(`Added: ${delta.added.join(', ')}`);
  if (delta.removed?.length) parts.push(`Removed: ${delta.removed.join(', ')}`);
  if (delta.renamed?.length) parts.push(`Renamed: ${delta.renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}`);
  if (parts.length === 0) parts.push('No semantic change.');
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `[ui-tokenize] Catalog updated. ${parts.join('. ')}`,
    },
  };
}

/**
 * PostToolUse output: residual violations after the edit.
 *
 * @param {ViolationReport[]} reports
 * @returns {object}
 */
export function postToolReport(reports) {
  if (reports.length === 0) return {};
  const lines = reports.map(formatReport).join('\n\n');
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `[ui-tokenize] Residual hardcoded values detected after this edit:\n\n${lines}`,
    },
  };
}

function formatReport(r) {
  const v = r.violation;
  const head = `• ${v.literal} (${v.type}) at line ${v.line} in ${v.surface}`;
  if (!r.primary) {
    return `${head}\n  No catalog match. Consider tokenize__propose with this value.`;
  }
  const altText = r.alternates.length
    ? `\n  Alternates: ${r.alternates.map((a) => `${a.tokenName} (${a.tokenValue}, ${(a.confidence * 100).toFixed(0)}%)`).join(', ')}`
    : '';
  const replacement = r.renderedReplacement
    ? `\n  Use: ${r.renderedReplacement}`
    : '';
  return `${head}\n  Nearest: ${r.primary.tokenName} = ${r.primary.tokenValue} (confidence ${(r.primary.confidence * 100).toFixed(0)}%)${replacement}${altText}`;
}
