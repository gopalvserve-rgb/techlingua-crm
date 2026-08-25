/**
 * PURE helpers for Phase 4 Batch 2 franchise ops — the ageing bucketing, the onboarding
 * progress %, and the royalty-invoice payable. Kept pure so they are unit-tested directly
 * (franchise-ops.spec.ts) and the service and any preview agree.
 */

export type AgeBucket = 'current' | '31-60' | '61-90' | '90+';

/** The ageing bucket for an invoice whose issue_date is `ageDays` old (current = 0-30). */
export function royaltyAgeBucket(ageDays: number): AgeBucket {
  const d = Math.trunc(Number(ageDays) || 0);
  if (d <= 30) return 'current';
  if (d <= 60) return '31-60';
  if (d <= 90) return '61-90';
  return '90+';
}

export interface AgeingRow { outstanding_minor: number; age_days: number }
export interface AgeingBuckets {
  current_minor: number; d30_minor: number; d60_minor: number; d90_minor: number; total_minor: number;
}

/** Sum outstanding into current / 31-60 / 61-90 / 90+ buckets. Ignores non-positive outstanding. */
export function ageingBuckets(rows: AgeingRow[]): AgeingBuckets {
  const b: AgeingBuckets = { current_minor: 0, d30_minor: 0, d60_minor: 0, d90_minor: 0, total_minor: 0 };
  for (const r of rows) {
    const o = Math.trunc(Number(r.outstanding_minor) || 0);
    if (o <= 0) continue;
    switch (royaltyAgeBucket(r.age_days)) {
      case 'current': b.current_minor += o; break;
      case '31-60': b.d30_minor += o; break;
      case '61-90': b.d60_minor += o; break;
      default: b.d90_minor += o; break;
    }
    b.total_minor += o;
  }
  return b;
}

/** Onboarding progress: done / total as a rounded %. */
export function onboardingProgress(steps: Array<{ done: boolean }>): { total: number; done: number; progress_pct: number } {
  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  return { total, done, progress_pct: total ? Math.round((done / total) * 100) : 0 };
}

/** The outstanding on an invoice = payable amount less the sum collected (never below 0). */
export function invoiceOutstanding(amountMinor: number, paidMinor: number): number {
  return Math.max(0, (Math.trunc(Number(amountMinor) || 0)) - (Math.trunc(Number(paidMinor) || 0)));
}

/** Is an invoice fully collected (paid >= amount)? Drives the flip to status 'paid'. */
export function isFullyPaid(amountMinor: number, paidMinor: number): boolean {
  return (Math.trunc(Number(paidMinor) || 0)) >= (Math.trunc(Number(amountMinor) || 0));
}
