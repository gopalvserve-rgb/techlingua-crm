import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { onboardingProgress } from './franchise-ops.util';

/**
 * FRANCHISE ONBOARDING + TERRITORY (Phase 4 Batch 2).
 *
 *  · ONBOARDING — a per-franchise checklist materialised from a seeded default TEMPLATE
 *    (migration 106) on first access; each step is done/pending with completed_by/at and
 *    a progress %. Steps can be added or removed per franchise.
 *  · TERRITORY — the allowed operating area(s) for a franchise (city / region / pincode /
 *    area). A simple list; a shared value across two franchises is surfaced as an OVERLAP
 *    warning rather than blocked (a metro can be shared while pincodes are carved).
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private async assertFranchise(id: number) {
    const f = await this.db.one<{ id: string }>(`SELECT id FROM franchise WHERE id = $1::bigint AND deleted_at IS NULL`, [id]);
    if (!f) throw new NotFoundException('Franchise not found');
  }

  /** Copy the org's default template steps into a franchise that has none yet (idempotent). */
  private async materialise(franchiseId: number, orgId: number) {
    const has = await this.db.one<{ n: string }>(
      `SELECT count(*) AS n FROM franchise_onboarding_step WHERE franchise_id = $1::bigint`, [franchiseId]);
    if (Number(has?.n ?? 0) > 0) return;
    await this.db.query(
      `INSERT INTO franchise_onboarding_step (org_id, franchise_id, title, sort_order)
       SELECT $1::bigint, $2::bigint, t.title, t.sort_order
         FROM franchise_onboarding_template t
        WHERE t.org_id = $1::bigint
        ORDER BY t.sort_order`, [orgId, franchiseId]);
  }

  async list(franchiseId: number) {
    await this.assertFranchise(franchiseId);
    const orgId = await this.orgId();
    await this.materialise(franchiseId, orgId);
    const rows = await this.db.query<any>(
      `SELECT s.id, s.title, s.sort_order, s.done, s.completed_at, s.note, u.name AS completed_by_name
         FROM franchise_onboarding_step s LEFT JOIN "user" u ON u.id = s.completed_by
        WHERE s.franchise_id = $1::bigint
        ORDER BY s.sort_order, s.id`, [franchiseId]);
    const steps = rows.map((s) => ({
      id: Number(s.id), title: s.title, sort_order: Number(s.sort_order ?? 0),
      done: !!s.done, completed_at: s.completed_at, completed_by_name: s.completed_by_name ?? null, note: s.note ?? null,
    }));
    return { steps, ...onboardingProgress(steps) };
  }

  async toggle(franchiseId: number, stepId: number, done: boolean, me: { id: number }) {
    await this.assertFranchise(franchiseId);
    const r = await this.db.query<{ id: string }>(
      `UPDATE franchise_onboarding_step
          SET done = $3::boolean,
              completed_by = CASE WHEN $3::boolean THEN $4::bigint ELSE NULL END,
              completed_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
        WHERE id = $1::bigint AND franchise_id = $2::bigint RETURNING id`,
      [stepId, franchiseId, done, me.id]);
    if (!r.length) throw new NotFoundException('Onboarding step not found');
    return this.list(franchiseId);
  }

  async addStep(franchiseId: number, title: string) {
    await this.assertFranchise(franchiseId);
    const t = String(title ?? '').trim();
    if (!t) throw new BadRequestException('Give the step a title.');
    const orgId = await this.orgId();
    await this.materialise(franchiseId, orgId);
    const max = await this.db.one<{ m: string }>(
      `SELECT COALESCE(max(sort_order),0) AS m FROM franchise_onboarding_step WHERE franchise_id = $1::bigint`, [franchiseId]);
    await this.db.query(
      `INSERT INTO franchise_onboarding_step (org_id, franchise_id, title, sort_order)
       VALUES ($1::bigint,$2::bigint,$3,$4::int)`,
      [orgId, franchiseId, t.slice(0, 160), Number(max?.m ?? 0) + 10]);
    return this.list(franchiseId);
  }

  async removeStep(franchiseId: number, stepId: number) {
    await this.assertFranchise(franchiseId);
    const r = await this.db.query<{ id: string }>(
      `DELETE FROM franchise_onboarding_step WHERE id = $1::bigint AND franchise_id = $2::bigint RETURNING id`,
      [stepId, franchiseId]);
    if (!r.length) throw new NotFoundException('Onboarding step not found');
    return this.list(franchiseId);
  }
}

const TERRITORY_KINDS = ['city', 'region', 'pincode', 'area'];

@Injectable()
export class TerritoryService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private async assertFranchise(id: number) {
    const f = await this.db.one<{ id: string }>(`SELECT id FROM franchise WHERE id = $1::bigint AND deleted_at IS NULL`, [id]);
    if (!f) throw new NotFoundException('Franchise not found');
  }

  async list(franchiseId: number) {
    await this.assertFranchise(franchiseId);
    const rows = await this.db.query<any>(
      `SELECT t.id, t.kind, t.value, t.note, t.created_at,
              (SELECT string_agg(DISTINCT f2.name, ', ')
                 FROM franchise_territory t2 JOIN franchise f2 ON f2.id = t2.franchise_id AND f2.deleted_at IS NULL
                WHERE lower(t2.value) = lower(t.value) AND t2.franchise_id <> t.franchise_id AND t2.org_id = t.org_id
              ) AS overlaps_with
         FROM franchise_territory t
        WHERE t.franchise_id = $1::bigint
        ORDER BY t.kind, lower(t.value)`, [franchiseId]);
    return rows.map((t) => ({
      id: Number(t.id), kind: t.kind, value: t.value, note: t.note ?? null,
      overlaps_with: t.overlaps_with ?? null, created_at: t.created_at,
    }));
  }

  async add(franchiseId: number, dto: any, me: { id: number }) {
    await this.assertFranchise(franchiseId);
    const kind = TERRITORY_KINDS.includes(dto?.kind) ? dto.kind : 'city';
    const value = String(dto?.value ?? '').trim();
    if (!value) throw new BadRequestException('Enter a city / region / pincode / area.');
    const orgId = await this.orgId();
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO franchise_territory (org_id, franchise_id, kind, value, note, created_by)
       VALUES ($1::bigint,$2::bigint,$3,$4,$5,$6::bigint) RETURNING id`,
      [orgId, franchiseId, kind, value.slice(0, 160), dto?.note ?? null, me.id]);
    return { id: Number(ins[0].id) };
  }

  async remove(franchiseId: number, territoryId: number) {
    await this.assertFranchise(franchiseId);
    const r = await this.db.query<{ id: string }>(
      `DELETE FROM franchise_territory WHERE id = $1::bigint AND franchise_id = $2::bigint RETURNING id`,
      [territoryId, franchiseId]);
    if (!r.length) throw new NotFoundException('Territory entry not found');
    return { id: territoryId, ok: true };
  }
}
