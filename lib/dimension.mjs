// Dimension parsing and pixel normalization.
// Approximates non-pixel units; used for nearest-neighbor matching, not for layout.

const PX_PER_REM = 16;
const PX_PER_EM = 16;
const PX_PER_CH = 8;
const PX_PER_VW = 14.4; // assume 1440px viewport for matching purposes
const PX_PER_VH = 8.1;  // assume 810px viewport

const UNIT_RE = /^(-?\d+(?:\.\d+)?)\s*(px|rem|em|ch|vw|vh|svh|dvh|lvh|%)$/;

/**
 * Parse a CSS dimension into a normalized pixel value (approximate for non-px units).
 *
 * @param {string} input
 * @returns {{value: number, unit: string, px: number}|null}
 */
export function parseDimension(input) {
  const s = String(input).trim().toLowerCase();
  const m = s.match(UNIT_RE);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = m[2];
  return { value, unit, px: toPx(value, unit) };
}

/**
 * Canonicalize a dimension string for catalog lookup.
 *
 * @param {string} input
 * @returns {string}
 */
export function canonicalDimension(input) {
  const d = parseDimension(input);
  if (!d) return String(input).trim().toLowerCase();
  return `${trimTrailingZeros(d.value)}${d.unit}`;
}

/**
 * Distance between two dimensions, normalized to pixels.
 * Returns absolute pixel difference. The suggester applies the relative-error gate.
 *
 * @param {ReturnType<typeof parseDimension>} a
 * @param {ReturnType<typeof parseDimension>} b
 * @returns {number}
 */
export function dimensionDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs(a.px - b.px);
}

function toPx(value, unit) {
  switch (unit) {
    case 'px': return value;
    case 'rem': return value * PX_PER_REM;
    case 'em': return value * PX_PER_EM;
    case 'ch': return value * PX_PER_CH;
    case 'vw': return value * PX_PER_VW;
    case 'vh':
    case 'svh':
    case 'dvh':
    case 'lvh':
      return value * PX_PER_VH;
    case '%': return value;          // percent not directly comparable; keep magnitude
    default: return value;
  }
}

function trimTrailingZeros(n) {
  return Number.isInteger(n) ? String(n) : String(n).replace(/0+$/, '').replace(/\.$/, '');
}
