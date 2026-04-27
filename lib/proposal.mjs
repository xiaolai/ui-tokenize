// Shared helpers for tokenize__propose / /tokenize:propose.
// Single source of truth for naming so MCP and CLI emit identical proposal records.

import { parseColor } from './color.mjs';
import { parseDimension } from './dimension.mjs';

/**
 * Convert an arbitrary intent string into a camelCase identifier suitable for
 * a temporary `__proposed.<X>` token name.
 *
 * @param {string} s
 * @returns {string}
 */
export function camelizeFromIntent(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^[^a-z]/, '');
}

/**
 * Convert an intent string to a kebab-cased segment usable in a dotted token name.
 *
 * @param {string} s
 * @returns {string}
 */
export function kebabFromIntent(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Derive a proposed dotted token name from a literal value and a free-text intent.
 * The category is detected from the value (color / dimension / generic), so MCP
 * and CLI agree on the category for any given (value, intent) pair.
 *
 * @param {string} intent
 * @param {string} value
 * @returns {string}
 */
export function nameFromIntent(intent, value) {
  const v = String(value);
  const category = parseColor(v) ? 'color' : parseDimension(v) ? 'space' : 'token';
  return `${category}.${kebabFromIntent(intent)}`;
}
