/** client 11 Nov 2026 — a Training Mode master name (blank clears it). */
export function trainingMode(v: unknown): string | null {
  const t = v == null ? '' : String(v).trim();
  return t ? t.slice(0, 80) : null;
}
