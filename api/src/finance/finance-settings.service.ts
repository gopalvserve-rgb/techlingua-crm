import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RbacDataService } from '../rbac/rbac-data.service';
import { applyPct, rupeesToMinor } from '../common/money.util';

/**
 * FINANCE SETTINGS — the discount / scholarship / capping-limit config, and the ENFORCER
 * that every place a discount is applied (quotation line, enrolment) runs through.
 *
 * =============================================================================
 * THE MODEL  (migration 045)
 * =============================================================================
 * `finance_setting` holds, per scope (org-wide default or per-vertical), THREE {percent,
 * amount} cap pairs:  discount, scholarship, and the hard `cap`. Amounts are paise;
 * percentages are NUMERIC(6,3). A NULL on either side means "not enforced" (blank = off).
 *
 * Scope resolution is MOST-SPECIFIC-WINS, per field: a vertical's own value overrides the
 * org-wide default, and where the vertical leaves a field blank the org-wide value shows
 * through. This is the number_series / channel_config rule, so the product has ONE mental
 * model for "per-vertical overrides org-wide".
 *
 * =============================================================================
 * THE CAP SEMANTICS  (percent AND amount — the stricter binds)
 * =============================================================================
 * For a discount D (paise) on a base B (paise), of a KIND (discount|scholarship):
 *   effectivePctCap    = min(kind.pct,    cap.pct)     over the non-null ones
 *   effectiveAmountCap = min(kind.minor,  cap.minor)   over the non-null ones
 *   allowed  ⇔  (pctCap is null    OR D <= applyPct(B, pctCap))
 *          AND  (amountCap is null OR D <= amountCap)
 * So BOTH a percent ceiling AND an absolute-₹ ceiling can be set, and a discount must be
 * within BOTH; leaving either side blank switches that side off. A user holding
 * `finance.override` bypasses the check; everyone else is rejected with a clear message.
 */

export interface CapPair { pct: number | null; minor: number | null }
export interface EffectiveCaps {
  discount: CapPair;
  scholarship: CapPair;
  cap: CapPair;         // the hard ceiling, applied on top of discount AND scholarship
}
export type DiscountKind = 'discount' | 'scholarship';

export interface FinanceRow {
  id: number | null;
  vertical_id: number | null;
  vertical_name?: string | null;
  discount_max_pct: number | null;
  discount_max_minor: number | null;
  scholarship_max_pct: number | null;
  scholarship_max_minor: number | null;
  cap_max_pct: number | null;
  cap_max_minor: number | null;
  updated_at?: string | null;
}

/** min over the values that are actually set (null = not set / no constraint). */
function tighter(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

@Injectable()
export class FinanceSettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacDataService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r?.id);
  }

  /** Every configured scope row (org-wide first, then each vertical) for the screen. */
  async list(): Promise<{ rows: FinanceRow[]; verticals: Array<{ id: number; name: string; branch_name: string }> }> {
    const org = await this.orgId();
    const rows = await this.db.query<any>(
      `SELECT fs.id, fs.vertical_id, v.name AS vertical_name,
              fs.discount_max_pct, fs.discount_max_minor,
              fs.scholarship_max_pct, fs.scholarship_max_minor,
              fs.cap_max_pct, fs.cap_max_minor, fs.updated_at
         FROM finance_setting fs
         LEFT JOIN vertical v ON v.id = fs.vertical_id
        WHERE fs.org_id = $1::bigint
        ORDER BY (fs.vertical_id IS NOT NULL), v.name NULLS FIRST`,
      [org],
    );
    const verticals = await this.db.query<any>(
      `SELECT v.id, v.name, b.name AS branch_name
         FROM vertical v JOIN branch b ON b.id = v.branch_id
        WHERE v.is_active AND v.deleted_at IS NULL
        ORDER BY b.name, v.name`,
    );
    return {
      rows: rows.map((r) => this.shape(r)),
      verticals: verticals.map((v) => ({ id: Number(v.id), name: v.name, branch_name: v.branch_name })),
    };
  }

  private shape(r: any): FinanceRow {
    return {
      id: r.id != null ? Number(r.id) : null,
      vertical_id: r.vertical_id != null ? Number(r.vertical_id) : null,
      vertical_name: r.vertical_name ?? null,
      discount_max_pct: num(r.discount_max_pct),
      discount_max_minor: num(r.discount_max_minor),
      scholarship_max_pct: num(r.scholarship_max_pct),
      scholarship_max_minor: num(r.scholarship_max_minor),
      cap_max_pct: num(r.cap_max_pct),
      cap_max_minor: num(r.cap_max_minor),
      updated_at: r.updated_at ?? null,
    };
  }

  /**
   * SAVE one scope's caps. `vertical_id` null = org-wide default. Each field is validated
   * and stored as paise/NUMERIC; an empty string clears it (that dimension is switched
   * off). Guarded by `finance.manage` at the controller — only the permitted user reaches
   * here.
   */
  async save(dto: any, actorId: number): Promise<FinanceRow> {
    const org = await this.orgId();
    const verticalId = dto?.vertical_id ? Number(dto.vertical_id) : null;
    if (verticalId != null) {
      const v = await this.db.one(`SELECT 1 FROM vertical WHERE id = $1::bigint`, [verticalId]);
      if (!v) throw new BadRequestException('That vertical does not exist.');
    }

    const pct = (v: unknown, label: string): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(String(v).trim());
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new BadRequestException(`${label} must be a percentage between 0 and 100.`);
      return n;
    };
    const amt = (rupees: unknown, minor: unknown, label: string): number | null => {
      if (minor !== undefined && minor !== null && minor !== '') {
        const m = Math.trunc(Number(minor));
        if (!Number.isFinite(m) || m < 0) throw new BadRequestException(`${label} cannot be negative.`);
        return m;
      }
      if (rupees === null || rupees === undefined || rupees === '') return null;
      let m: number;
      try { m = rupeesToMinor(rupees); } catch (e) { throw new BadRequestException(`${label}: ${(e as Error).message}`); }
      if (m < 0) throw new BadRequestException(`${label} cannot be negative.`);
      return m;
    };

    const v = {
      discount_max_pct: pct(dto?.discount_max_pct, 'Discount %'),
      discount_max_minor: amt(dto?.discount_max, dto?.discount_max_minor, 'Discount amount'),
      scholarship_max_pct: pct(dto?.scholarship_max_pct, 'Scholarship %'),
      scholarship_max_minor: amt(dto?.scholarship_max, dto?.scholarship_max_minor, 'Scholarship amount'),
      cap_max_pct: pct(dto?.cap_max_pct, 'Cap %'),
      cap_max_minor: amt(dto?.cap_max, dto?.cap_max_minor, 'Cap amount'),
    };

    const row = await this.db.one<any>(
      `INSERT INTO finance_setting (org_id, vertical_id,
            discount_max_pct, discount_max_minor,
            scholarship_max_pct, scholarship_max_minor,
            cap_max_pct, cap_max_minor, updated_by, updated_at)
       VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7, $8, $9::bigint, now())
       ON CONFLICT (org_id, COALESCE(vertical_id, 0)) DO UPDATE
          SET discount_max_pct = EXCLUDED.discount_max_pct,
              discount_max_minor = EXCLUDED.discount_max_minor,
              scholarship_max_pct = EXCLUDED.scholarship_max_pct,
              scholarship_max_minor = EXCLUDED.scholarship_max_minor,
              cap_max_pct = EXCLUDED.cap_max_pct,
              cap_max_minor = EXCLUDED.cap_max_minor,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
       RETURNING id, vertical_id, discount_max_pct, discount_max_minor,
                 scholarship_max_pct, scholarship_max_minor, cap_max_pct, cap_max_minor, updated_at`,
      [org, verticalId, v.discount_max_pct, v.discount_max_minor, v.scholarship_max_pct,
        v.scholarship_max_minor, v.cap_max_pct, v.cap_max_minor, actorId],
    );
    return this.shape(row);
  }

  /** The effective caps for a scope — the vertical row over the org-wide default, per field. */
  async effective(verticalId: number | null): Promise<EffectiveCaps> {
    const org = await this.orgId();
    const rows = await this.db.query<any>(
      `SELECT vertical_id, discount_max_pct, discount_max_minor,
              scholarship_max_pct, scholarship_max_minor, cap_max_pct, cap_max_minor
         FROM finance_setting
        WHERE org_id = $1::bigint AND (vertical_id IS NULL OR vertical_id = $2::bigint)`,
      [org, verticalId],
    );
    const orgRow = rows.find((r) => r.vertical_id == null);
    const verRow = verticalId != null ? rows.find((r) => r.vertical_id != null) : undefined;
    // per-field: vertical value wins when set, else org-wide.
    const pick = (f: string): number | null => {
      const vv = verRow ? num(verRow[f]) : null;
      return vv != null ? vv : (orgRow ? num(orgRow[f]) : null);
    };
    return {
      discount: { pct: pick('discount_max_pct'), minor: pick('discount_max_minor') },
      scholarship: { pct: pick('scholarship_max_pct'), minor: pick('scholarship_max_minor') },
      cap: { pct: pick('cap_max_pct'), minor: pick('cap_max_minor') },
    };
  }

  /** The GET /finance/settings/effective payload — caps for a scope, for the UI hint. */
  async effectiveForApi(verticalId: number | null) {
    return { vertical_id: verticalId, caps: await this.effective(verticalId) };
  }

  /** Does the user hold `finance.override` (may apply a discount beyond the cap)? */
  async userCanOverride(userId: number): Promise<boolean> {
    const grants = await this.rbac.loadUserGrants(userId);
    return grants.rolePermissions.some((p) => p.permissionKey === 'finance.override');
  }

  /**
   * The PURE checker — no I/O, unit-tested. Returns ok=false with a human message when a
   * discount D on base B breaches the effective percent OR amount cap for `kind`.
   */
  check(caps: EffectiveCaps, kind: DiscountKind, base: number, discount: number): { ok: boolean; message?: string } {
    if (discount <= 0) return { ok: true };
    const own = caps[kind];
    const pctCap = tighter(own.pct, caps.cap.pct);
    const minorCap = tighter(own.minor, caps.cap.minor);
    const label = kind === 'scholarship' ? 'scholarship' : 'discount';

    if (pctCap != null) {
      const maxByPct = applyPct(base, pctCap);
      if (discount > maxByPct) {
        return { ok: false, message: `The ${label} exceeds the allowed limit of ${pctCap}% (max ₹${(maxByPct / 100).toFixed(2)} on this amount). A permitted user can raise the cap or apply an override.` };
      }
    }
    if (minorCap != null && discount > minorCap) {
      return { ok: false, message: `The ${label} exceeds the allowed limit of ₹${(minorCap / 100).toFixed(2)}. A permitted user can raise the cap or apply an override.` };
    }
    return { ok: true };
  }

  /**
   * Build a per-request guard: resolves the scope's caps and the caller's override right
   * ONCE, then `enforce()` can be called per line without re-querying. Throws
   * BadRequestException naming the breach when a normal user exceeds the cap.
   */
  async guardFor(verticalId: number | null, userId: number): Promise<{
    enforce: (kind: DiscountKind, base: number, discount: number, label?: string) => void;
  }> {
    const caps = await this.effective(verticalId);
    const canOverride = await this.userCanOverride(userId);
    return {
      enforce: (kind, base, discount, label) => {
        if (canOverride) return;
        const r = this.check(caps, kind, base, discount);
        if (!r.ok) throw new BadRequestException(label ? `${label}: ${r.message}` : r.message);
      },
    };
  }

  /** Convenience one-shot for a single discount (enrolment). */
  async assertAllowed(p: { verticalId: number | null; userId: number; kind: DiscountKind; base: number; discount: number; label?: string }): Promise<void> {
    const g = await this.guardFor(p.verticalId, p.userId);
    g.enforce(p.kind, p.base, p.discount, p.label);
  }
}
