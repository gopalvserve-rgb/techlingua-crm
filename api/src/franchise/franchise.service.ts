import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { assertDateRange } from '../common/date.util';
import { computeRoyalty, monthsInPeriod, RoyaltyPlanCompute } from './royalty.util';

/**
 * FRANCHISE (Phase 4 Batch 1) — franchise records, their branch mapping, a scope
 * resolver (franchise -> branch_ids) and the per-franchise reporting rollup.
 *
 * A franchise's DATA is everything under its mapped branches. Every ₹ figure below
 * is a scoped aggregate over the SAME finance sources the Finance Dashboard reads
 * (fee_receipt collected, approved refund, enrolment net fee, live dues), so a
 * franchise's numbers RECONCILE with Finance when the franchise's branches are the
 * finance filter.
 */

const STATUSES = ['prospect', 'onboarding', 'active', 'suspended', 'terminated'];

export interface FranchiseRevenue {
  gross_collected_minor: number;
  refunds_minor: number;
  net_collected_minor: number;
  receipts: number;
}

@Injectable()
export class FranchiseService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /** franchise -> its mapped branch_ids (the definition of the franchise's data scope). */
  async branchIds(franchiseId: number): Promise<number[]> {
    const rows = await this.db.query<{ branch_id: string }>(
      `SELECT branch_id FROM franchise_branch WHERE franchise_id = $1::bigint ORDER BY branch_id`,
      [franchiseId],
    );
    return rows.map((r) => Number(r.branch_id));
  }

  async scope(franchiseId: number) {
    const f = await this.getRaw(franchiseId);
    const branch_ids = await this.branchIds(franchiseId);
    return { franchise_id: f.id, code: f.code, name: f.name, branch_ids };
  }

  private async getRaw(id: number) {
    const f = await this.db.one<any>(
      `SELECT * FROM franchise WHERE id = $1::bigint AND deleted_at IS NULL`, [id],
    );
    if (!f) throw new NotFoundException('Franchise not found');
    return { ...f, id: Number(f.id) };
  }

  async list() {
    const rows = await this.db.query<any>(
      `SELECT f.id, f.name, f.code, f.owner_name, f.owner_email, f.owner_phone,
              f.city, f.gst_no, f.status, f.agreement_start, f.agreement_end,
              (SELECT count(*) FROM franchise_branch fb WHERE fb.franchise_id = f.id) AS branch_count
         FROM franchise f
        WHERE f.deleted_at IS NULL
        ORDER BY f.status = 'active' DESC, lower(f.name)`,
    );
    return rows.map((f) => ({
      id: Number(f.id), name: f.name, code: f.code,
      owner_name: f.owner_name, owner_email: f.owner_email, owner_phone: f.owner_phone,
      city: f.city, gst_no: f.gst_no, status: f.status,
      agreement_start: f.agreement_start, agreement_end: f.agreement_end,
      branch_count: Number(f.branch_count ?? 0),
    }));
  }

  async get(id: number) {
    const f = await this.getRaw(id);
    const branches = await this.db.query<any>(
      `SELECT b.id, b.name, b.code FROM franchise_branch fb JOIN branch b ON b.id = fb.branch_id
        WHERE fb.franchise_id = $1::bigint ORDER BY lower(b.name)`, [id],
    );
    return {
      id: f.id, name: f.name, code: f.code,
      owner_name: f.owner_name, owner_email: f.owner_email, owner_phone: f.owner_phone,
      address: f.address, city: f.city, gst_no: f.gst_no, status: f.status,
      agreement_start: f.agreement_start, agreement_end: f.agreement_end, note: f.note,
      branches: branches.map((b) => ({ id: Number(b.id), name: b.name, code: b.code })),
      branch_ids: branches.map((b) => Number(b.id)),
    };
  }

  private cleanIds(raw: unknown): number[] {
    const arr = Array.isArray(raw) ? raw : [];
    return [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  }

  async save(dto: any, me: { id: number }) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the franchise a name.');
    const code = String(dto?.code ?? '').trim().toUpperCase();
    if (!code) throw new BadRequestException('Give the franchise a code.');
    const status = STATUSES.includes(dto?.status) ? dto.status : 'prospect';
    const branchIds = this.cleanIds(dto?.branch_ids);
    const orgId = await this.orgId();
    const id = dto?.id ? Number(dto.id) : null;

    // A branch belongs to at most one franchise — surface a clear error before the unique index does.
    if (branchIds.length) {
      const clash = await this.db.query<{ branch_id: string; fid: string; fname: string }>(
        `SELECT fb.branch_id, fb.franchise_id AS fid, f.name AS fname
           FROM franchise_branch fb JOIN franchise f ON f.id = fb.franchise_id
          WHERE fb.branch_id = ANY($1::bigint[]) AND fb.franchise_id <> COALESCE($2::bigint, 0)`,
        [branchIds, id],
      );
      if (clash.length) {
        const b = clash[0];
        throw new BadRequestException(`A branch is already mapped to franchise "${b.fname}". Unmap it there first.`);
      }
    }

    return this.db.tx(async (c) => {
      let fid: number;
      const fields = [name, code, dto?.owner_name ?? null, dto?.owner_email ?? null, dto?.owner_phone ?? null,
        dto?.address ?? null, dto?.city ?? null, dto?.gst_no ?? null, status,
        dto?.agreement_start || null, dto?.agreement_end || null, dto?.note ?? null];
      try {
        if (id) {
          const upd = await c.query(
            `UPDATE franchise SET name=$2, code=$3, owner_name=$4, owner_email=$5, owner_phone=$6,
                    address=$7, city=$8, gst_no=$9, status=$10, agreement_start=$11, agreement_end=$12,
                    note=$13, updated_at=now()
              WHERE id=$1::bigint AND deleted_at IS NULL RETURNING id`,
            [id, ...fields],
          );
          if (!upd.rowCount) throw new NotFoundException('Franchise not found');
          fid = id;
        } else {
          const ins = await c.query(
            `INSERT INTO franchise (org_id, name, code, owner_name, owner_email, owner_phone,
                    address, city, gst_no, status, agreement_start, agreement_end, note, created_by)
             VALUES ($1::bigint,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::bigint) RETURNING id`,
            [orgId, ...fields, me.id],
          );
          fid = Number(ins.rows[0].id);
        }
      } catch (e: any) {
        if (e?.code === '23505') throw new BadRequestException('A franchise with this code already exists.');
        throw e;
      }
      // Replace the branch mapping.
      await c.query(`DELETE FROM franchise_branch WHERE franchise_id = $1::bigint`, [fid]);
      for (const bId of branchIds) {
        await c.query(`INSERT INTO franchise_branch (franchise_id, branch_id) VALUES ($1::bigint, $2::bigint)`, [fid, bId]);
      }
      return { id: fid };
    });
  }

  async remove(id: number, me: { id: number }) {
    const plans = await this.db.one<{ n: string }>(
      `SELECT count(*) AS n FROM royalty_plan WHERE franchise_id = $1::bigint AND deleted_at IS NULL`, [id],
    );
    if (Number(plans?.n ?? 0) > 0) throw new BadRequestException('Delete this franchise’s royalty plans first.');
    const r = await this.db.query<{ id: string }>(
      `UPDATE franchise SET deleted_at = now(), deleted_by = $2::bigint
        WHERE id = $1::bigint AND deleted_at IS NULL RETURNING id`, [id, me.id],
    );
    if (!r.length) throw new NotFoundException('Franchise not found');
    await this.db.query(`DELETE FROM franchise_branch WHERE franchise_id = $1::bigint`, [id]);
    return { id, ok: true };
  }

  /**
   * Collected / refunds / net collected for a set of branches over an optional
   * DateRange (received_at / refunded_at). Mirrors the Finance Dashboard SQL.
   */
  async revenueForBranches(branchIds: number[], from: string | null, to: string | null): Promise<FranchiseRevenue> {
    if (!branchIds.length) return { gross_collected_minor: 0, refunds_minor: 0, net_collected_minor: 0, receipts: 0 };
    const rp: unknown[] = [branchIds];
    let rDate = '';
    if (from) { rp.push(from); rDate += ` AND fr.received_at >= $${rp.length}::date`; }
    if (to) { rp.push(to); rDate += ` AND fr.received_at < ($${rp.length}::date + 1)`; }
    const coll = await this.db.one<any>(
      `SELECT COALESCE(sum(fr.amount_minor), 0) AS gross, count(*) AS receipts
         FROM fee_receipt fr
        WHERE fr.deleted_at IS NULL AND fr.branch_id = ANY($1::bigint[])${rDate}`, rp);

    const fp: unknown[] = [branchIds];
    let fDate = '';
    if (from) { fp.push(from); fDate += ` AND rf.refunded_at >= $${fp.length}::date`; }
    if (to) { fp.push(to); fDate += ` AND rf.refunded_at < ($${fp.length}::date + 1)`; }
    const ref = await this.db.one<any>(
      `SELECT COALESCE(sum(rf.amount_minor), 0) AS refunds
         FROM refund rf
        WHERE rf.deleted_at IS NULL AND rf.status = 'approved' AND rf.branch_id = ANY($1::bigint[])${fDate}`, fp);

    const gross = Number(coll?.gross ?? 0);
    const refunds = Number(ref?.refunds ?? 0);
    return { gross_collected_minor: gross, refunds_minor: refunds, net_collected_minor: Math.max(0, gross - refunds), receipts: Number(coll?.receipts ?? 0) };
  }

  /** The franchise's ACTIVE royalty plan effective within [from,to] (most recent effective_from). */
  async activePlan(franchiseId: number, from: string | null, to: string | null) {
    const rp: unknown[] = [franchiseId];
    let clause = '';
    if (to) { rp.push(to); clause += ` AND p.effective_from <= $${rp.length}::date`; }
    if (from) { rp.push(from); clause += ` AND (p.effective_to IS NULL OR p.effective_to >= $${rp.length}::date)`; }
    const p = await this.db.one<any>(
      `SELECT * FROM royalty_plan p
        WHERE p.franchise_id = $1::bigint AND p.deleted_at IS NULL AND p.status = 'active'${clause}
        ORDER BY p.effective_from DESC LIMIT 1`, rp);
    if (!p) return null;
    const slabs = await this.db.query<any>(
      `SELECT min_amount_minor, max_amount_minor, percent, label, sort_order
         FROM royalty_slab WHERE plan_id = $1::bigint ORDER BY min_amount_minor`, [p.id]);
    return { row: p, slabs };
  }

  static toCompute(planRow: any, slabs: any[]): RoyaltyPlanCompute {
    return {
      model: planRow.model,
      percent: Number(planRow.percent) || 0,
      fixed_amount_minor: Number(planRow.fixed_amount_minor) || 0,
      min_guarantee_minor: Number(planRow.min_guarantee_minor) || 0,
      tier_basis: planRow.tier_basis === 'net' ? 'net' : 'collected',
      slabs: (slabs ?? []).map((s) => ({
        min_amount_minor: Number(s.min_amount_minor) || 0,
        max_amount_minor: s.max_amount_minor === null || s.max_amount_minor === undefined ? null : Number(s.max_amount_minor),
        percent: Number(s.percent) || 0,
        label: s.label, sort_order: Number(s.sort_order ?? 0),
      })),
    };
  }

  /** Per-franchise KPI rollup (active branches, students/enrolments, revenue, royalty, dues). */
  async dashboard(franchiseId: number, opts: { from?: string; to?: string } = {}) {
    const dr = assertDateRange(opts.from, opts.to);
    const f = await this.getRaw(franchiseId);
    const branchIds = await this.branchIds(franchiseId);

    const rev = await this.revenueForBranches(branchIds, dr.from, dr.to);

    // Live enrolment snapshot for the franchise's branches (active enrolments).
    let students = 0, enrolments = 0, booked = 0, outstanding = 0, activeBranches = 0;
    if (branchIds.length) {
      const e = await this.db.one<any>(
        `SELECT count(*) AS enrolments,
                count(DISTINCT e.lead_id) AS students,
                COALESCE(sum(e.net_fee_minor), 0) AS booked,
                COALESCE(sum(GREATEST(e.net_fee_minor - COALESCE(p.paid_minor, 0), 0)), 0) AS outstanding
           FROM enrolment e
           LEFT JOIN LATERAL (SELECT COALESCE(sum(fr.amount_minor),0) AS paid_minor
                                FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL) p ON TRUE
          WHERE e.deleted_at IS NULL AND e.status = 'active' AND e.branch_id = ANY($1::bigint[])`,
        [branchIds]);
      students = Number(e?.students ?? 0);
      enrolments = Number(e?.enrolments ?? 0);
      booked = Number(e?.booked ?? 0);
      outstanding = Number(e?.outstanding ?? 0);
      const ab = await this.db.one<any>(
        `SELECT count(*) AS n FROM branch WHERE id = ANY($1::bigint[]) AND is_active = TRUE`, [branchIds]);
      activeBranches = Number(ab?.n ?? 0);
    }

    // Royalty payable for the period, using the franchise's active plan (if any).
    const plan = await this.activePlan(franchiseId, dr.from, dr.to);
    let royaltyPayable = 0;
    let planName: string | null = null;
    let royaltyDetail: any = null;
    if (plan) {
      planName = plan.row.name;
      const result = computeRoyalty(
        FranchiseService.toCompute(plan.row, plan.slabs),
        { gross_collected_minor: rev.gross_collected_minor, refunds_minor: rev.refunds_minor },
        monthsInPeriod(dr.from, dr.to),
      );
      royaltyPayable = result.royalty_minor;
      royaltyDetail = result;
    }

    return {
      franchise: { id: f.id, name: f.name, code: f.code, status: f.status },
      range: { from: dr.from ?? null, to: dr.to ?? null },
      branch_ids: branchIds,
      kpis: {
        total_branches: branchIds.length,
        active_branches: activeBranches,
        students,
        enrolments,
        revenue_collected_minor: rev.gross_collected_minor,
        refunds_minor: rev.refunds_minor,
        net_revenue_minor: rev.net_collected_minor,
        net_booked_minor: booked,
        outstanding_minor: outstanding,
        receipts: rev.receipts,
        royalty_payable_minor: royaltyPayable,
        royalty_plan_name: planName,
      },
      royalty: royaltyDetail,
    };
  }
}
