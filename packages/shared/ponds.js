// Pond code generation shared by seed and simulator so both agree on names.

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function zoneCode(index) {
  return LETTERS[index % 26] + (index >= 26 ? String(Math.floor(index / 26)) : '');
}

/** @returns {{zone: string, code: string, zoneIndex: number, index: number}[]} */
export function generatePondCodes(zoneCount, pondsPerZone) {
  const out = [];
  for (let z = 0; z < zoneCount; z++) {
    const zc = zoneCode(z);
    for (let i = 1; i <= pondsPerZone; i++) {
      out.push({ zone: zc, code: `${zc}${String(i).padStart(2, '0')}`, zoneIndex: z, index: i });
    }
  }
  return out;
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
