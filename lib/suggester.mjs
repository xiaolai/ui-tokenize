// Suggestion engine: exact + nearest-neighbor lookup with confidence.

import { canonicalColor, deltaE, parseColor } from './color.mjs';
import { dimensionDistance, parseDimension } from './dimension.mjs';

const COLOR_DELTA_E_HIGH = 2.0;
const COLOR_DELTA_E_LOW = 5.0;
const DIM_REL_TOLERANCE = 0.25;

/**
 * @typedef {import('./catalog.mjs').Catalog} Catalog
 * @typedef {import('./scanner.mjs').Violation} Violation
 *
 * @typedef {object} Suggestion
 * @property {string} tokenName
 * @property {string} tokenValue
 * @property {number} confidence       - 0..1; 1.0 = exact match
 *
 * @typedef {object} SuggestionResult
 * @property {Suggestion|null} primary
 * @property {Suggestion[]} alternates
 */

/**
 * Look up a violation in the catalog; return primary + alternate suggestions.
 *
 * Tailwind-arbitrary surface: the violation.literal is the full match (e.g. `bg-[#fff]`),
 * so we extract the bracket payload before looking it up. The full literal is preserved
 * so the renderer can rebuild `bg-[var(--color-…)]` syntax.
 *
 * @param {Violation} violation
 * @param {Catalog} catalog
 * @returns {SuggestionResult}
 */
export function suggest(violation, catalog) {
  const lookupValue = violation.surface === 'tailwind-arbitrary'
    ? extractBracketPayload(violation.literal)
    : violation.literal;
  if (lookupValue == null) return { primary: null, alternates: [] };
  const inner = { ...violation, literal: lookupValue };
  if (violation.type === 'color') return suggestColor(inner, catalog);
  if (violation.type === 'dimension') return suggestDimension(inner, catalog);
  return { primary: null, alternates: [] };
}

function extractBracketPayload(literal) {
  const m = /\[([^\]]+)\]/.exec(String(literal));
  return m ? m[1] : null;
}

function suggestColor(violation, catalog) {
  const target = parseColor(violation.literal);
  if (!target) return { primary: null, alternates: [] };
  const canonical = canonicalColor(violation.literal);
  const entries = catalog.valueIndex.color || [];
  const exact = entries.find((e) => e.value === canonical);
  if (exact) {
    return {
      primary: makeSuggestion(exact.tokenNames[0], exact.value, 1.0),
      alternates: exact.tokenNames.slice(1).map((n) => makeSuggestion(n, exact.value, 1.0)),
    };
  }
  /** @type {Array<{tokenName: string, tokenValue: string, distance: number}>} */
  const ranked = [];
  for (const e of entries) {
    const d = deltaE(target, e.normalized);
    for (const tn of e.tokenNames) ranked.push({ tokenName: tn, tokenValue: e.value, distance: d });
  }
  ranked.sort((a, b) => a.distance - b.distance);
  const top = ranked[0];
  if (!top || top.distance >= COLOR_DELTA_E_LOW) return { primary: null, alternates: [] };
  const confidence = top.distance < COLOR_DELTA_E_HIGH ? 0.85 : 0.5;
  const alternates = ranked.slice(1, 3)
    .filter((c) => c.distance < COLOR_DELTA_E_LOW)
    .map((c) => makeSuggestion(c.tokenName, c.tokenValue, c.distance < COLOR_DELTA_E_HIGH ? 0.85 : 0.5));
  return {
    primary: makeSuggestion(top.tokenName, top.tokenValue, confidence),
    alternates,
  };
}

function suggestDimension(violation, catalog) {
  const target = parseDimension(violation.literal);
  if (!target) return { primary: null, alternates: [] };
  const entries = catalog.valueIndex.dimension || [];
  // Cross-unit exact: compare normalized px so 1rem matches 16px.
  const exact = entries.find((e) => e.normalized && e.normalized.px === target.px);
  if (exact) {
    return {
      primary: makeSuggestion(exact.tokenNames[0], exact.value, 1.0),
      alternates: exact.tokenNames.slice(1).map((n) => makeSuggestion(n, exact.value, 1.0)),
    };
  }
  /** @type {Array<{tokenName: string, tokenValue: string, distance: number, relErr: number}>} */
  const ranked = [];
  for (const e of entries) {
    const d = dimensionDistance(target, e.normalized);
    const relErr = target.px > 0 ? d / target.px : Infinity;
    for (const tn of e.tokenNames) ranked.push({ tokenName: tn, tokenValue: e.value, distance: d, relErr });
  }
  ranked.sort((a, b) => a.distance - b.distance);
  const top = ranked[0];
  if (!top || top.relErr > DIM_REL_TOLERANCE) return { primary: null, alternates: [] };
  // Use scale-step heuristic: confidence high if within 1px or 10%.
  const confidence = top.distance <= 1 || top.relErr <= 0.05 ? 0.8 : 0.5;
  const alternates = ranked.slice(1, 3)
    .filter((c) => c.relErr <= DIM_REL_TOLERANCE)
    .map((c) => makeSuggestion(c.tokenName, c.tokenValue, c.distance <= 1 || c.relErr <= 0.05 ? 0.8 : 0.5));
  return {
    primary: makeSuggestion(top.tokenName, top.tokenValue, confidence),
    alternates,
  };
}

function makeSuggestion(tokenName, tokenValue, confidence) {
  return { tokenName, tokenValue, confidence };
}
