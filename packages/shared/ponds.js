// Farm layout shared by seed and simulator so both agree on names.
// Unit = one RAS with 1-10 ponds. Codes: unit "U01", pond "U01-P01".

export const MAX_PONDS_PER_UNIT = 10;

const pad2 = (n) => String(n).padStart(2, '0');

export const unitCode = (n) => `U${pad2(n)}`;
export const pondCode = (unit, n) => `${unitCode(unit)}-P${pad2(n)}`;

/** Deterministic pond count for unit number n (1-based) in [min, max]. */
export function pondsInUnit(n, min, max) {
  const lo = Math.max(1, Math.min(min, max));
  const hi = Math.min(MAX_PONDS_PER_UNIT, Math.max(min, max));
  const h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return lo + ((h >>> 7) % (hi - lo + 1));
}

/**
 * @returns {{unit: string, unitIndex: number, ponds: {code: string, index: number}[]}[]}
 */
export function generateLayout({ units, min, max }) {
  const out = [];
  for (let u = 1; u <= units; u++) {
    const count = pondsInUnit(u, min, max);
    out.push({
      unit: unitCode(u),
      unitIndex: u,
      ponds: Array.from({ length: count }, (_, i) => ({ code: pondCode(u, i + 1), index: i + 1 })),
    });
  }
  return out;
}

/**
 * Turn what a worker types into a code.
 *   "1-1", "u1p1", "U01-P01", "1 1" -> {pond: "U01-P01", unit: "U01"}
 *   "u3", "3"                       -> {unit: "U03"}
 * Anything else -> {text} for free-text matching.
 */
export function normalizePondQuery(q) {
  const s = String(q ?? '').trim().toUpperCase();
  if (!s) return {};
  let m = s.match(/^U?\s*(\d{1,2})\s*[-\s/.]?\s*P\s*(\d{1,2})$/) || s.match(/^U?\s*(\d{1,2})\s*[-\s/.]\s*(\d{1,2})$/);
  if (m) return { unit: unitCode(Number(m[1])), pond: pondCode(Number(m[1]), Number(m[2])) };
  m = s.match(/^U?\s*(\d{1,2})$/);
  if (m) return { unit: unitCode(Number(m[1])) };
  return { text: s };
}

/** Day of culture: stocking day counts as day 1. `stockedAt` is a 'YYYY-MM-DD' date. */
export function dayOfCulture(stockedAt, now = Date.now()) {
  if (!stockedAt) return null;
  const [y, m, d] = String(stockedAt).slice(0, 10).split('-').map(Number);
  const start = Date.UTC(y, m - 1, d);
  const n = new Date(now);
  const today = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.floor((today - start) / 86400000) + 1;
}
