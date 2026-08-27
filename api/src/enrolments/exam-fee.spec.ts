/**
 * EXAM FEE + AMOUNT-DISCOUNT OVER-CAP — dev/140 (26/27aug Batch B, items 3 & 4).
 *
 * The CRITICAL calc rule (item 3): the exam fee is EXCLUDED from the discount and the
 * instalment plan. Discount applies to the course/level fee only → Net; the plan is built on
 * Net; the exam fee is then ADDED on top → Total payable = Net + Exam + Tax. Balance = Total − Paid.
 *
 * Item 4: a FIXED-AMOUNT discount over the Discount-Master AMOUNT cap must trigger approval
 * exactly like a PERCENT discount does (the paise the user asked for exceeds the cap paise).
 */
import { resolveLevels, sumLevelFees, sumLevelDiscounts, sumLevelExamFees, MasterLevel } from './level.util';
import { computeEnrolmentDiscount } from './discount.util';
import { resolveCapMinor, DiscountCapRow } from '../finance/discount-master.util';

/** Mirror of the service's over-cap decision (appliedDiscountMinor + status), pure for testing. */
function decide(requestedMinor: number, capMinor: number | null, authorized: boolean) {
  if (capMinor == null || requestedMinor <= capMinor) return { applied: requestedMinor, status: 'none' as const };
  if (authorized) return { applied: requestedMinor, status: 'approved' as const };
  return { applied: capMinor, status: 'pending' as const };
}

describe('Exam fee — excluded from discount + instalment, added to Total (item 3)', () => {
  it('worked example: level fee ₹20,000, 10% discount, exam ₹1,000, 18% GST', () => {
    const levelFee = 2_000_000;   // ₹20,000 in paise
    const examFee = 100_000;      // ₹1,000 in paise
    // 1) discount applies to the FEE only
    const d = computeEnrolmentDiscount(levelFee, 'percent', 10);
    expect(d.discount_amount_minor).toBe(200_000);      // ₹2,000
    expect(d.net_fee_minor).toBe(1_800_000);            // Net ₹18,000
    // 2) exam fee is NOT discounted — it stays whole
    const totalPayableBeforeTax = d.net_fee_minor + examFee;
    expect(totalPayableBeforeTax).toBe(1_900_000);      // ₹19,000
    // 3) tax on top (per line, 18%): Net line + Exam line
    const taxNet = Math.round(d.net_fee_minor * 0.18);  // 324000
    const taxExam = Math.round(examFee * 0.18);         // 18000
    const total = d.net_fee_minor + examFee + taxNet + taxExam;
    expect(total).toBe(2_242_000);                      // ₹22,420
    // 4) the instalment plan base is Net ONLY — the exam fee is never split in
    const planBase = d.net_fee_minor;
    expect(planBase).toBe(1_800_000);
    expect(planBase).not.toBe(totalPayableBeforeTax);   // exam fee is not in the plan
  });

  it('balance = Total payable − Amount paid (exam fee is collectible)', () => {
    const net = 1_800_000; const exam = 100_000;
    const totalPayable = net + exam;                    // ₹19,000
    const paid = 500_000;                               // ₹5,000
    expect(totalPayable - paid).toBe(1_400_000);        // Balance ₹14,000 (includes the exam fee)
  });

  it('level-wise: each level snapshots its own exam fee; Σ exam is added on top of Net', () => {
    const master: MasterLevel[] = [
      { id: 1, code: 'A1', fee_minor: 1_000_000, exam_fee_minor: 50_000 },
      { id: 2, code: 'A2', fee_minor: 1_200_000, exam_fee_minor: 60_000 },
    ];
    const levels = resolveLevels(master, [{ code: 'A1' }, { code: 'A2' }], 'overall');
    expect(sumLevelFees(levels)).toBe(2_200_000);       // Total fee ₹22,000
    expect(sumLevelExamFees(levels)).toBe(110_000);     // Σ exam ₹1,100 (NOT discounted)
    expect(sumLevelDiscounts(levels)).toBe(0);
    // exam fee is independent of the discount: a 10% overall discount touches only the fee
    const d = computeEnrolmentDiscount(sumLevelFees(levels), 'percent', 10);
    expect(d.net_fee_minor).toBe(1_980_000);            // Net ₹19,800
    const totalPayable = d.net_fee_minor + sumLevelExamFees(levels);
    expect(totalPayable).toBe(2_090_000);               // ₹20,900
  });

  it('a per-level exam-fee override is snapshotted verbatim; a blank exam fee is 0', () => {
    const master: MasterLevel[] = [{ id: 1, code: 'A1', fee_minor: 1_000_000, exam_fee_minor: 50_000 }];
    const withOverride = resolveLevels(master, [{ code: 'A1', exam_fee_minor: 75_000 }], 'overall');
    expect(withOverride[0].exam_fee_minor).toBe(75_000);
    const noExam = resolveLevels([{ id: 2, code: 'B1', fee_minor: 500_000 }], [{ code: 'B1' }], 'overall');
    expect(noExam[0].exam_fee_minor).toBe(0);
  });
});

describe('Amount-discount over-cap approval (item 4) — mirrors the percent path', () => {
  const caps: DiscountCapRow[] = [
    // cap: max ₹1,500 (150000 paise) OR 10% — the stricter binds
    { id: 1, branch_id: null, vertical_id: null, course_id: null, max_percent: 10, max_amount_minor: 150_000 },
  ];
  const base = 2_000_000; // ₹20,000 fee

  it('a fixed AMOUNT within the amount cap applies with no approval', () => {
    const requested = 100_000; // ₹1,000 <= ₹1,500 cap AND <= 10% (₹2,000)
    const { capMinor } = resolveCapMinor(caps, {}, base);
    expect(capMinor).toBe(150_000);                     // min(10% of 20000 = 2000, 1500) = 1500
    const dec = decide(requested, capMinor, false);
    expect(dec.status).toBe('none');
    expect(dec.applied).toBe(100_000);
  });

  it('a fixed AMOUNT over the amount cap by a non-authorised user is held pending at the cap', () => {
    const requested = 180_000; // ₹1,800 > ₹1,500 cap
    const { capMinor } = resolveCapMinor(caps, {}, base);
    const dec = decide(requested, capMinor, false);
    expect(dec.status).toBe('pending');
    expect(dec.applied).toBe(150_000);                  // only up to the cap applies now
  });

  it('the same over-cap AMOUNT by an authorised user applies in full (approved)', () => {
    const requested = 180_000;
    const { capMinor } = resolveCapMinor(caps, {}, base);
    const dec = decide(requested, capMinor, true);
    expect(dec.status).toBe('approved');
    expect(dec.applied).toBe(180_000);
  });

  it('the amount cap binds even when the percent cap would allow more', () => {
    // 10% of 20000 = ₹2,000, but the amount cap is ₹1,500 — the stricter (amount) wins.
    const { capMinor } = resolveCapMinor(caps, {}, base);
    expect(capMinor).toBe(150_000);
    const dec = decide(200_000, capMinor, false); // ask ₹2,000 (== the % cap) but amount cap is ₹1,500
    expect(dec.status).toBe('pending');
    expect(dec.applied).toBe(150_000);
  });
});
