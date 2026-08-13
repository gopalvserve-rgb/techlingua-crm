/**
 * ENROLMENT DISCOUNT — a pure, unit-tested computation. No DB, no floats-as-money.
 *
 * Item 4: a discount is entered EITHER as an amount (₹, paise) OR as a percentage (%) on
 * the GROSS course fee. This derives the discount AMOUNT (paise) and the NET (payable)
 * fee. The server is the truth — controllers recompute this from (gross, type, value) and
 * NEVER trust a client-sent net.
 *
 *   none     -> discount 0
 *   amount   -> discount = value paise, clamped to the gross (a discount never exceeds
 *               the fee — the same rule money.util applies per quotation line)
 *   percent  -> discount = gross × value%, half-up to the paisa (applyPct), clamped to gross
 *
 *   net = gross − discount
 */
import { applyPct } from '../common/money.util';

export type EnrolmentDiscountType = 'none' | 'amount' | 'percent';

export interface DiscountResult {
  discount_type: EnrolmentDiscountType;
  discount_value: number;         // as entered: paise for amount, percent number for percent
  gross_fee_minor: number;
  discount_amount_minor: number;  // derived ₹ discount (paise)
  net_fee_minor: number;
}

/**
 * Compute the discount amount + net from the gross fee and how the discount was entered.
 * `grossMinor` and (for an amount) `value` are integer paise; for a percent, `value` is a
 * percentage number (e.g. 10 or 10.5). Throws on nonsense so a bad figure is a 400, never
 * a silent ₹0.
 */
export function computeEnrolmentDiscount(grossMinor: number, type: EnrolmentDiscountType, value: number): DiscountResult {
  const gross = Math.trunc(Number(grossMinor));
  if (!Number.isFinite(gross) || gross < 0) throw new Error('The fee must be a non-negative amount.');
  const t: EnrolmentDiscountType = type === 'amount' || type === 'percent' ? type : 'none';

  let val = Number(value);
  if (!Number.isFinite(val) || val < 0) val = 0;

  let discount = 0;
  if (t === 'amount') {
    discount = Math.trunc(val);
  } else if (t === 'percent') {
    if (val > 100) throw new Error('A percentage discount cannot exceed 100%.');
    discount = applyPct(gross, val);
  }
  if (discount < 0) discount = 0;
  if (discount > gross) discount = gross;         // never more than the fee

  return {
    discount_type: t,
    discount_value: t === 'none' ? 0 : val,
    gross_fee_minor: gross,
    discount_amount_minor: discount,
    net_fee_minor: gross - discount,
  };
}
