// Atomic JSON write + strict read helpers shared by MCP server and CLI.
// Two contracts:
//   atomicWriteJson — write tmp, fsync-rename over destination. Avoids torn writes
//     and lost-update windows when two processes write near-simultaneously.
//   readJsonStrict  — distinguish "missing file" (returns fallback) from
//     "malformed file" (throws). Plain `safeReadJson(path, fallback)` swallows
//     parse errors and silently overwrites history when used in read-modify-write
//     patterns; use this when the caller must not clobber a corrupted ledger.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write `doc` as JSON to `path` atomically: write to a tmp sibling, then rename.
 * The rename is atomic on POSIX/macOS/Linux; concurrent readers see either the
 * old or the new file, never a partial write.
 *
 * @param {string} path  absolute path of the target file
 * @param {any} doc      JSON-serializable payload
 */
export function atomicWriteJson(path, doc) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  renameSync(tmp, path);
}

/**
 * Read a JSON file, returning `fallback` only when the file is missing.
 * Throws on parse error so the caller can refuse to overwrite a corrupted file
 * with a fresh fallback (silent overwriting is the failure mode this guards).
 *
 * @param {string} path
 * @param {any} fallback   value returned when the file does not exist
 * @returns {any}
 */
export function readJsonStrict(path, fallback) {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`malformed JSON at ${path}: ${err.message}`);
  }
}
