// Per-PID NDJSON ledger (D-028). Conflict-free under concurrent hook invocations.
// Each hook PID writes append-only events to its own file; SessionStart compacts.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ledgerPath, sessionLedgerPath, tokenizeDir } from './paths.mjs';

/**
 * @typedef {object} LedgerEvent
 * @property {string} ts
 * @property {string} kind            - "violation" | "block" | "rewrite" | "fabrication" | "escape"
 * @property {string} sessionId
 * @property {string} file
 * @property {number} [line]
 * @property {string} [literal]
 * @property {string} [token]
 * @property {string} [reason]
 *
 * @typedef {object} SessionState
 * @property {string} sessionId
 * @property {string} startedAt
 * @property {string} updatedAt
 * @property {LedgerEvent[]} events
 * @property {Object<string, number>} unresolvedByFile
 * @property {Array<{name: string, real?: string}>} fabrications
 * @property {object} metrics
 */

/**
 * Append an event to the per-PID ledger file.
 *
 * @param {string} workingFile
 * @param {Omit<LedgerEvent, 'ts'>} event
 */
export function appendEvent(workingFile, event) {
  const path = ledgerPath(workingFile);
  mkdirSync(dirname(path), { recursive: true });
  const enriched = { ts: new Date().toISOString(), ...event };
  appendFileSync(path, JSON.stringify(enriched) + '\n');
}

/**
 * Compact all per-PID ledger files into the canonical session.json.
 *
 * @param {string} workingFile
 * @param {string} sessionId
 * @returns {SessionState}
 */
export function compactLedger(workingFile, sessionId) {
  const dir = join(tokenizeDir(workingFile), 'ledger');
  /** @type {LedgerEvent[]} */
  const events = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ndjson')) continue;
      try {
        const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean);
        for (const l of lines) {
          try { events.push(JSON.parse(l)); } catch { /* drop malformed line */ }
        }
      } catch { /* skip unreadable */ }
    }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  const state = aggregate(sessionId, events);
  const sessionPath = sessionLedgerPath(workingFile);
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, JSON.stringify(state, null, 2));
  return state;
}

/**
 * Read the compacted session ledger.
 *
 * @param {string} workingFile
 * @returns {SessionState|null}
 */
export function readSession(workingFile) {
  const path = sessionLedgerPath(workingFile);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

/**
 * Resolve the unresolved-block count for a file in the current session.
 * Used by the retry-budget logic in PreToolUse. Reads live NDJSON files directly
 * (without requiring compaction) so consecutive PreToolUse calls in the same session
 * see each other's blocks.
 *
 * @param {string} workingFile
 * @param {string} targetFile
 * @returns {number}
 */
export function unresolvedBlocksFor(workingFile, targetFile) {
  const dir = join(tokenizeDir(workingFile), 'ledger');
  if (!existsSync(dir)) return 0;
  let blocks = 0, rewrites = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ndjson')) continue;
    let raw;
    try { raw = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.file !== targetFile) continue;
      if (ev.kind === 'block') blocks++;
      else if (ev.kind === 'rewrite') rewrites++;
    }
  }
  return Math.max(0, blocks - rewrites);
}

/**
 * @param {string} sessionId
 * @param {LedgerEvent[]} events
 * @returns {SessionState}
 */
function aggregate(sessionId, events) {
  /** @type {Object<string, number>} */
  const unresolvedByFile = {};
  /** @type {Array<{name: string, real?: string}>} */
  const fabrications = [];
  let violations = 0, blocks = 0, rewrites = 0, escapes = 0;
  for (const ev of events) {
    if (ev.kind === 'violation') violations++;
    if (ev.kind === 'block') {
      blocks++;
      unresolvedByFile[ev.file] = (unresolvedByFile[ev.file] ?? 0) + 1;
    }
    if (ev.kind === 'rewrite') {
      rewrites++;
      // a rewrite resolves the previously-counted unresolved block on this file/literal
      if (unresolvedByFile[ev.file]) unresolvedByFile[ev.file] = Math.max(0, unresolvedByFile[ev.file] - 1);
    }
    if (ev.kind === 'fabrication') fabrications.push({ name: ev.token ?? '', real: ev.reason });
    if (ev.kind === 'escape') escapes++;
  }
  return {
    sessionId,
    startedAt: events[0]?.ts ?? new Date().toISOString(),
    updatedAt: events[events.length - 1]?.ts ?? new Date().toISOString(),
    events,
    unresolvedByFile,
    fabrications,
    metrics: { violations, blocks, rewrites, escapes },
  };
}
