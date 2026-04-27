// Path resolution helpers for ui-tokenize.
// All paths are absolute. Discovery walks up to find the nearest token root.

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const TOKEN_ROOT_MARKERS = [
  'tokens.json',
  'design-tokens.json',
  '.tokenize/config.json',
  'tailwind.config.js',
  'tailwind.config.ts',
  'tailwind.config.mjs',
  'tailwind.config.cjs',
];

const REPO_MARKERS = ['.git', 'package.json', 'pnpm-workspace.yaml', 'yarn.lock'];

/**
 * Walk up from `start` looking for the nearest directory containing any token-root marker.
 * Stops at filesystem root or homedir, whichever first.
 *
 * @param {string} start - absolute path of file or directory to start from
 * @returns {string|null} absolute path of nearest token root, or null
 */
export function findTokenRoot(start) {
  const home = homedir();
  let dir = isDir(start) ? resolve(start) : dirname(resolve(start));

  while (dir && dir !== sep && dir !== home) {
    for (const marker of TOKEN_ROOT_MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Walk up looking for the nearest repository root (a directory with .git or package.json).
 * Used as a fallback when no token root exists.
 *
 * @param {string} start
 * @returns {string|null}
 */
export function findRepoRoot(start) {
  const home = homedir();
  let dir = isDir(start) ? resolve(start) : dirname(resolve(start));

  while (dir && dir !== sep && dir !== home) {
    for (const marker of REPO_MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the .tokenize state directory for a given working file.
 * Prefers token root; falls back to repo root; falls back to cwd.
 *
 * @param {string} workingFile - absolute path of the file being edited
 * @returns {string} absolute path to .tokenize directory
 */
export function tokenizeDir(workingFile) {
  const root = findTokenRoot(workingFile) || findRepoRoot(workingFile) || process.cwd();
  return join(root, '.tokenize');
}

/**
 * Resolve the canonical catalog path for a working file.
 *
 * @param {string} workingFile
 * @returns {string}
 */
export function catalogPath(workingFile) {
  return join(tokenizeDir(workingFile), 'catalog.json');
}

/**
 * Resolve the per-PID ledger NDJSON path.
 *
 * @param {string} workingFile
 * @param {number} [pid]
 * @returns {string}
 */
export function ledgerPath(workingFile, pid = process.pid) {
  return join(tokenizeDir(workingFile), 'ledger', `${pid}.ndjson`);
}

/**
 * Resolve the compacted session ledger path.
 *
 * @param {string} workingFile
 * @returns {string}
 */
export function sessionLedgerPath(workingFile) {
  return join(tokenizeDir(workingFile), 'session.json');
}

/** @param {string} p */
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
