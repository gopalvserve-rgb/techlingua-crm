/**
 * ROYALTY COMPUTATION — the PURE core (Phase 4 Batch 1).
 *
 * `computeRoyalty` is the single definition of "what royalty does a franchise owe
 * for a period", given the period's revenue (collected + refunds, from the SAME
 * finance sources as the Finance Dashboard) and the franchise's royalty plan. It is
 * a pure function so it is unit-tested directly (royalty.spec.ts) and so the server
 * and any preview agree.
 *
 * FOUR models:
 *   · percent_collected — % of GROSS collected (fee_receipt sum)
 *   · percent_net       — % of NET collected  (gross collected - approved refunds)
 *   · fixed             — a fixed MONTHLY fee (x number of months in the period)
 *   · tiered            — % from the band the revenue base lands in (royalty_slab);
 *                         the base is gross or net per the plan's tier_basis.
 * An optional monthly MINIMUM GUARANTEE floors the payable (x months).
 */

export type RoyaltyModel = 'percent_collected' | 'percent_net' | 'fixed' | 'tiered';
export type TierBasis = 'collected' | 'net';

export interface RoyaltySlab {
  min_amount_minor: number;
  max_amount_minor: number | null;
  percent: number;
  label?: string;
  sort_order?: number;
}

export interface RoyaltyPlanCompute {
  model: RoyaltyModel;
  percent: number;              // for percent_collected / percent_net
  fixed_amount_minor: number;   // per month, for the fixed model
  min_guarantee_minor: number;  // per month floor (0 = no floor)
  tier_basis: TierBasis;        // which base the tiered slabs read
  slabs: RoyaltySlab[];         // for the tiered model
}

export interface RoyaltyRevenue {
  gross_collected_minor: number;
  refunds_minor: number;
}

export interface RoyaltyResult {
  model: RoyaltyModel;
  base_label: string;           // human label of the base the rate was applied to
  base_minor: number;           // the revenue base the % was applied to (0 for fixed)
  rate_pct: number | null;      // the % applied (null for fixed)
  slab: RoyaltySlab | null;     // the resolved band (tiered only)
  gross_royalty_minor: number;  // before the minimum-guarantee floor
  min_guarantee_minor: number;  // the floor for the whole period (per-month x months)
  floor_applied: boolean;
  royalty_minor: number;        // the final royalty (after floor)
}

/** Half-up % of a paise amount, with up to 4 decimals of percent — deterministic. */
export function pctOfMinor(baseMinor: number, percent: number): number {
  const base = Math.trunc(Number(baseMinor) || 0);
  const p = Number(percent);
  if (!Number.isFinite(p) || p <= 0 || base <= 0) return 0;
  // percent has <= 4 decimals: scale to an integer basis-of-10000ths to avoid float drift.
  const pScaled = Math.round(p * 10000);            // e.g. 12.5% -> 125000
  const num = base * pScaled;                        // paise * (percent x 10000)
  const den = 100 * 10000;                           // divide by 100 (percent) x 10000 (scale)
  const q = Math.floor(num / den);
  const r = num - q * den;
  return 2 * r >= den ? q + 1 : q;                   // half-up
}

/**
 * The earned tiered band for a revenue base: the slab with the GREATEST
 * min_amount_minor that is <= the base. max_amount_minor is a display bound only.
 * Below the lowest slab there is no band (null). Order-independent.
 */
export function resolveRoyaltySlab(slabs: RoyaltySlab[], baseMinor: number): RoyaltySlab | null {
  const base = Math.trunc(Number(baseMinor) || 0);
  const sorted = [...slabs].sort((a, b) => a.min_amount_minor - b.min_amount_minor);
  let earned: RoyaltySlab | null = null;
  for (const s of sorted) {
    if (base >= s.min_amount_minor) earned = s;
    else break;
  }
  return earned;
}

/** Count of calendar months a [from, to] span touches (inclusive). Defaults to 1. */
export function monthsInPeriod(from?: string | null, to?: string | null): number {
  const mf = /^(\d{4})-(\d{2})/.exec(from ?? '');
  const mt = /^(\d{4})-(\d{2})/.exec(to ?? '');
  if (!mf || !mt) return 1;
  const a = Number(mf[1]) * 12 + (Number(mf[2]) - 1);
  const b = Number(mt[1]) * 12 + (Number(mt[2]) - 1);
  return Math.max(1, b - a + 1);
}

/** PURE. The royalty a plan produces for a period's revenue. */
export function computeRoyalty(
  plan: RoyaltyPlanCompute,
  revenue: RoyaltyRevenue,
  months = 1,
): RoyaltyResult {
  const gross = Math.max(0, Math.trunc(Number(revenue.gross_collected_minor) || 0));
  const refunds = Math.max(0, Math.trunc(Number(revenue.refunds_minor) || 0));
  const net = Math.max(0, gross - refunds);
  const m = Math.max(1, Math.trunc(Number(months) || 1));

  let base = 0;
  let baseLabel = '';
  let rate: number | null = null;
  let slab: RoyaltySlab | null = null;
  let gross_royalty = 0;

  switch (plan.model) {
    case 'percent_collected':
      base = gross; baseLabel = 'Gross collected'; rate = Number(plan.percent) || 0;
      gross_royalty = pctOfMinor(base, rate);
      break;
    case 'percent_net':
      base = net; baseLabel = 'Net collected (after refunds)'; rate = Number(plan.percent) || 0;
      gross_royalty = pctOfMinor(base, rate);
      break;
    case 'fixed':
      base = 0; baseLabel = `Fixed monthly fee x ${m} month(s)`; rate = null;
      gross_royalty = Math.max(0, Math.trunc(Number(plan.fixed_amount_minor) || 0)) * m;
      break;
    case 'tiered': {
      base = plan.tier_basis === 'net' ? net : gross;
      baseLabel = plan.tier_basis === 'net' ? 'Net collected (tiered)' : 'Gross collected (tiered)';
      slab = resolveRoyaltySlab(plan.slabs ?? [], base);
      rate = slab ? Number(slab.percent) || 0 : 0;
      gross_royalty = slab ? pctOfMinor(base, rate) : 0;
      break;
    }
  }

  const floor = Math.max(0, Math.trunc(Number(plan.min_guarantee_minor) || 0)) * m;
  const floorApplied = floor > gross_royalty;
  const royalty = Math.max(gross_royalty, floor);

  return {
    model: plan.model,
    base_label: baseLabel,
    base_minor: base,
    rate_pct: rate,
    slab,
    gross_royalty_minor: gross_royalty,
    min_guarantee_minor: floor,
    floor_applied: floorApplied,
    royalty_minor: royalty,
  };
}
