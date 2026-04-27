// Color parsing, normalization, and CIE Lab ΔE2000 distance.
// No external deps; pure math on standard formulas.

/**
 * @typedef {object} ColorRGB
 * @property {number} r 0-255
 * @property {number} g 0-255
 * @property {number} b 0-255
 * @property {number} a 0-1
 */

/**
 * Parse a CSS color literal into RGBA. Returns null if not a recognized color.
 * Supports: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl(), hsla().
 * (oklch/oklab/lab/lch parsed as opaque strings; treated as un-comparable for v0.1.)
 *
 * @param {string} input
 * @returns {ColorRGB|null}
 */
export function parseColor(input) {
  const s = input.trim().toLowerCase();
  if (s.startsWith('#')) return parseHex(s);
  if (s.startsWith('rgb')) return parseRgbFn(s);
  if (s.startsWith('hsl')) return parseHslFn(s);
  return null;
}

/**
 * Canonicalize a color string for catalog lookup keys.
 * Returns a stable lowercase form: #rrggbb or #rrggbbaa.
 * Returns the original string if not parseable (so non-RGB color spaces still match exactly).
 *
 * @param {string} input
 * @returns {string}
 */
export function canonicalColor(input) {
  const rgb = parseColor(input);
  if (!rgb) return input.trim().toLowerCase();
  const hex2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
  const base = `#${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`;
  return rgb.a < 1 ? base + hex2(rgb.a * 255) : base;
}

/**
 * CIE Lab ΔE2000 between two RGB colors (alpha ignored).
 *
 * @param {ColorRGB} a
 * @param {ColorRGB} b
 * @returns {number}
 */
export function deltaE(a, b) {
  return deltaE2000(rgbToLab(a), rgbToLab(b));
}

// --------------------------------------------------------------------------------
// Parsers
// --------------------------------------------------------------------------------

function parseHex(s) {
  const hex = s.slice(1);
  if (![3, 4, 6, 8].includes(hex.length)) return null;
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  let r, g, b, a = 1;
  if (hex.length === 3 || hex.length === 4) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
    if (hex.length === 4) a = parseInt(hex[3] + hex[3], 16) / 255;
  } else {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
    if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16) / 255;
  }
  return { r, g, b, a };
}

function parseRgbFn(s) {
  const m = s.match(/rgba?\s*\(\s*([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const r = parseChannel(parts[0]);
  const g = parseChannel(parts[1]);
  const b = parseChannel(parts[2]);
  const a = parts[3] != null ? parseAlpha(parts[3]) : 1;
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b, a };
}

function parseHslFn(s) {
  const m = s.match(/hsla?\s*\(\s*([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const h = parseHue(parts[0]);
  const sat = parsePercent(parts[1]);
  const l = parsePercent(parts[2]);
  const a = parts[3] != null ? parseAlpha(parts[3]) : 1;
  if ([h, sat, l].some(Number.isNaN)) return null;
  const rgb = hslToRgb(h, sat, l);
  return { ...rgb, a };
}

function parseChannel(p) {
  if (p.endsWith('%')) return Math.round(parseFloat(p) * 2.55);
  const n = parseFloat(p);
  return Number.isFinite(n) ? n : NaN;
}

function parseAlpha(p) {
  if (p.endsWith('%')) return clamp(parseFloat(p) / 100, 0, 1);
  const n = parseFloat(p);
  return Number.isFinite(n) ? clamp(n, 0, 1) : 1;
}

function parsePercent(p) {
  return parseFloat(p) / 100;
}

function parseHue(p) {
  if (p.endsWith('deg')) return parseFloat(p);
  if (p.endsWith('turn')) return parseFloat(p) * 360;
  if (p.endsWith('rad')) return (parseFloat(p) * 180) / Math.PI;
  return parseFloat(p);
}

// --------------------------------------------------------------------------------
// Conversions
// --------------------------------------------------------------------------------

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else              [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

function rgbToLab({ r, g, b }) {
  // sRGB -> linear
  const lin = (v) => {
    v /= 255;
    return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  // linear -> XYZ (D65)
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
  // XYZ -> Lab (D65 reference white)
  const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

// CIEDE2000 — implementation per Sharma, Wu, Dalal (2005).
// Reasonably accurate; not bit-perfect. Good enough for nearest-neighbor.
function deltaE2000(lab1, lab2) {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueAngle(b1, a1p);
  const h2p = hueAngle(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(toRad(dhp) / 2);
  const Lpbar = (L1 + L2) / 2;
  const Cpbar = (C1p + C2p) / 2;
  let hpbar;
  if (C1p * C2p === 0) hpbar = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hpbar = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hpbar = (h1p + h2p + 360) / 2;
  else hpbar = (h1p + h2p - 360) / 2;
  const T = 1
    - 0.17 * Math.cos(toRad(hpbar - 30))
    + 0.24 * Math.cos(toRad(2 * hpbar))
    + 0.32 * Math.cos(toRad(3 * hpbar + 6))
    - 0.20 * Math.cos(toRad(4 * hpbar - 63));
  const dTheta = 30 * Math.exp(-(((hpbar - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpbar ** 7 / (Cpbar ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lpbar - 50) ** 2) / Math.sqrt(20 + (Lpbar - 50) ** 2);
  const Sc = 1 + 0.045 * Cpbar;
  const Sh = 1 + 0.015 * Cpbar * T;
  const Rt = -Math.sin(toRad(2 * dTheta)) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 +
    (dCp / Sc) ** 2 +
    (dHp / Sh) ** 2 +
    Rt * (dCp / Sc) * (dHp / Sh),
  );
}

function hueAngle(b, a) {
  if (a === 0 && b === 0) return 0;
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return h >= 0 ? h : h + 360;
}

function toRad(d) { return (d * Math.PI) / 180; }
function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }
