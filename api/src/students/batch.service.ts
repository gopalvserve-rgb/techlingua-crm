import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange, requireDateString, toDateString, SQL_TODAY } from '../common/date.util';

/**
 * BATCH — a class bound to Branch -> Vertical -> Course.
 *
 * A batch ALWAYS carries branch + vertical + course (all NOT NULL, validated here as a strict
 * cascade), so it can never be created outside the hierarchy.
 *
 * BATCH STATUS LIFECYCLE (migration 080, client feedback) — 7 codes:
 *   upcoming / active / expired  are DATE-DERIVED (IST): before start -> upcoming; within
 *     start..end -> active; after end -> expired.
 *   completed / cancelled / suspended / archived are MANUAL — set explicitly by a user and
 *     STICK (never re-derived). status_is_manual pins them; a suspended batch can RESUME
 *     (clears the pin, re-derives from dates). deriveBatchStatus() is the one rule; the
 *     migration mirrors it for backfill; refreshBatchStatuses() keeps the stored value in
 *     sync opportunistically so the list filter is accurate (stored+derived hybrid).
 */
export const BATCH_SCOPE_COLS: ScopeColumnMap = {
  branch: 'bt.branch_id', vertical: 'bt.vertical_id',
};

/** All 7 lifecycle codes. */
export const BATCH_STATUS_CODES = [
  'upcoming', 'active', 'completed', 'cancelled', 'expired', 'archived', 'suspended',
] as const;
export type BatchStatus = (typeof BATCH_STATUS_CODES)[number];

/** The four MANUAL statuses — set by a user and never overridden by the date logic. */
export const BATCH_MANUAL_STATUSES = new Set<string>(['completed', 'cancelled', 'suspended', 'archived']);

/**
 * BATCH TYPE + CLASS DAYS + FREQUENCY (migration 081, client feedback).
 *
 * batch_type — a seeded catalog code (batch_type_def). class_days — ISO weekday numbers the
 * batch meets (Mon=1 … Sun=7). frequency — daily|weekdays|weekends|custom, which DERIVES
 * class_days server-side (both are stored explicitly). Empty class_days = unrestricted (legacy
 * back-compat): attendance may then be marked on any day.
 */
export const BATCH_TYPE_CODES = [
  'regular', 'fast_track', 'weekend', 'weekday', 'intensive',
  'crash_course', 'online', 'corporate', 'customized',
] as const;
export type BatchType = (typeof BATCH_TYPE_CODES)[number];

/** The 4 frequency codes. A NON-custom frequency DERIVES the class_days set. */
export const BATCH_FREQUENCIES = ['daily', 'weekdays', 'weekends', 'custom'] as const;
export type BatchFrequency = (typeof BATCH_FREQUENCIES)[number];

/**
 * Resolve the class_days (ISO weekday numbers Mon=1 … Sun=7) a batch meets, from its frequency.
 *   daily → [1..7] · weekdays → [1..5] · weekends → [6,7] · custom → the user-selected set,
 * sanitised to ⊆ [1..7], de-duplicated + sorted. This is the ONE rule that ties frequency and
 * class_days together (create/update call it; the front-end auto-checks the same days).
 */
export function normaliseClassDays(frequency: string, custom: unknown): number[] {
  if (frequency === 'daily') return [1, 2, 3, 4, 5, 6, 7];
  if (frequency === 'weekdays') return [1, 2, 3, 4, 5];
  if (frequency === 'weekends') return [6, 7];
  const arr = Array.isArray(custom) ? custom : [];       // custom (or anything unexpected)
  const set = new Set<number>();
  for (const x of arr) { const n = Number(x); if (Number.isInteger(n) && n >= 1 && n <= 7) set.add(n); }
  return [...set].sort((a, b) => a - b);
}

/** Normalise/validate a batch_type code — anything unknown falls back to 'regular'. */
export function normaliseBatchType(v: unknown): BatchType {
  const s = String(v ?? '').trim();
  return (BATCH_TYPE_CODES as readonly string[]).includes(s) ? (s as BatchType) : 'regular';
}

/** Normalise/validate a frequency code — anything unknown falls back to 'custom'. */
export function normaliseFrequency(v: unknown): BatchFrequency {
  const s = String(v ?? '').trim();
  return (BATCH_FREQUENCIES as readonly string[]).includes(s) ? (s as BatchFrequency) : 'custom';
}

/**
 * BATCH DELIVERY MODE (migration 083, client feedback) — Offline / Online / Hybrid. Reuses the
 * SAME seeded catalog the Course uses (course_delivery_def) so the value never drifts. Anything
 * unknown falls back to 'Offline' (the sensible default, matching the column default + backfill).
 */
export const BATCH_DELIVERY_MODES = ['Offline', 'Online', 'Hybrid'] as const;
export type BatchDeliveryMode = (typeof BATCH_DELIVERY_MODES)[number];

/** Normalise/validate a delivery_mode value — anything unknown falls back to 'Offline'. */
export function normaliseDeliveryMode(v: unknown): BatchDeliveryMode {
  const s = String(v ?? '').trim();
  return (BATCH_DELIVERY_MODES as readonly string[]).includes(s) ? (s as BatchDeliveryMode) : 'Offline';
}

/** Today (YYYY-MM-DD) in the app timezone (IST) — the day all derivation buckets against. */
export function istTodayStr(): string {
  // en-CA renders YYYY-MM-DD; the timeZone option pins it to IST regardless of server TZ.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Derive the date-driven status from a batch's start/end dates (IST day compare). Returns one
 * of upcoming / active / expired, or NULL when the batch has NO dates (caller keeps the stored
 * value). NEVER returns a manual status — manual statuses are decided by the user, not dates.
 */
export function deriveBatchStatus(
  start: unknown, end: unknown, today: string = istTodayStr(),
): 'upcoming' | 'active' | 'expired' | null {
  const s = toDateString(start);
  const e = toDateString(end);
  if (!s && !e) return null;                 // no dates -> keep whatever is stored
  if (s && today < s) return 'upcoming';     // before the start day
  if (e && today > e) return 'expired';      // after the end day, no manual closure
  return 'active';                           // within the window (or only one bound, inside it)
}

@Injectable()
export class BatchService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /**
   * OPPORTUNISTIC SWEEP — recompute upcoming/active/expired for every NON-manual batch that has
   * at least one date, persisting only the rows whose derived value actually changed (IST). A
   * manual/terminal batch (status_is_manual) is never touched; a date-less batch keeps its
   * stored value. Idempotent + cheap; run before a list/get so the filter reads a fresh status.
   */
  async refreshBatchStatuses(): Promise<void> {
    const derived = `CASE
        WHEN bt.start_date IS NOT NULL AND ${SQL_TODAY} < bt.start_date THEN 'upcoming'
        WHEN bt.end_date   IS NOT NULL AND ${SQL_TODAY} > bt.end_date   THEN 'expired'
        ELSE 'active' END`;
    await this.db.query(
      `UPDATE batch bt SET status = (${derived})
        WHERE bt.deleted_at IS NULL AND bt.status_is_manual = FALSE
          AND (bt.start_date IS NOT NULL OR bt.end_date IS NOT NULL)
          AND bt.status IS DISTINCT FROM (${derived})`);
  }

  async list(scope: ResolvedScope, f: {
    branch_id?: string; vertical_id?: string; course_id?: string; status?: string; q?: string;
    trainer_id?: string; owner_id?: string; batch_type?: string; delivery_mode?: string;
    from?: string; to?: string; limit?: number;
  } = {}) {
    await this.refreshBatchStatuses();
    const params: unknown[] = [];
    const where = [`bt.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, BATCH_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return;
      params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('bt.branch_id', f.branch_id);
    multi('bt.vertical_id', f.vertical_id);
    multi('bt.course_id', f.course_id);
    // Trainer (assigned trainer user) + Owner (created_by) — numeric-id multi-select, each narrows.
    multi('bt.trainer_id', f.trainer_id);
    multi('bt.created_by', f.owner_id);
    // Multi-select status filter: ?status=active,upcoming (only the 7 valid codes are honoured).
    const statuses = String(f.status ?? '').split(',').map((x) => x.trim())
      .filter((x) => (BATCH_STATUS_CODES as readonly string[]).includes(x));
    if (statuses.length) { params.push(statuses); where.push(`bt.status = ANY($${params.length}::varchar[])`); }
    // Multi-select batch-type filter: ?batch_type=weekend,online (only the 9 valid codes honoured).
    const btypes = String(f.batch_type ?? '').split(',').map((x) => x.trim())
      .filter((x) => (BATCH_TYPE_CODES as readonly string[]).includes(x));
    if (btypes.length) { params.push(btypes); where.push(`bt.batch_type = ANY($${params.length}::varchar[])`); }
    // Multi-select delivery-mode filter: ?delivery_mode=Online,Hybrid (only the 3 valid values).
    const dmodes = String(f.delivery_mode ?? '').split(',').map((x) => x.trim())
      .filter((x) => (BATCH_DELIVERY_MODES as readonly string[]).includes(x));
    if (dmodes.length) { params.push(dmodes); where.push(`bt.delivery_mode = ANY($${params.length}::varchar[])`); }
    const _dr = assertDateRange(f.from, f.to);
    if (_dr.from) { params.push(_dr.from); where.push(`bt.created_at >= $${params.length}::timestamptz`); }
    if (_dr.to) { params.push(_dr.to); where.push(`bt.created_at < ($${params.length}::date + 1)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(bt.name ILIKE $${params.length} OR bt.batch_code ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));

    return this.db.query<any>(
      `SELECT bt.id, bt.batch_code, bt.name, bt.status, bt.status_is_manual, bt.status_reason,
              sd.label AS status_label, sd.meaning AS status_meaning, sd.is_manual AS status_is_terminalable,
              bt.batch_type, td.label AS batch_type_label, bt.class_days, bt.frequency,
              bt.delivery_mode, bt.description,
              bt.capacity, bt.room, bt.schedule,
              bt.start_date, bt.end_date, bt.branch_id, bt.vertical_id, bt.course_id, bt.trainer_id,
              bt.created_by, bt.created_at,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, u.name AS trainer_name,
              cu.name AS owner_name,
              (SELECT count(*) FROM student st WHERE st.batch_id = bt.id AND st.deleted_at IS NULL)::int AS enrolled
         FROM batch bt
         LEFT JOIN branch  b  ON b.id = bt.branch_id
         LEFT JOIN vertical v ON v.id = bt.vertical_id
         LEFT JOIN m_course c ON c.id = bt.course_id
         LEFT JOIN "user"  u  ON u.id = bt.trainer_id
         LEFT JOIN "user"  cu ON cu.id = bt.created_by
         LEFT JOIN batch_status_def sd ON sd.code = bt.status
         LEFT JOIN batch_type_def   td ON td.code = bt.batch_type
        WHERE ${where.join(' AND ')}
        ORDER BY bt.created_at DESC, bt.id DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  async get(id: number, scope: ResolvedScope) {
    await this.refreshBatchStatuses();
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, BATCH_SCOPE_COLS, params);
    const row = await this.db.one<any>(
      `SELECT bt.*, b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, u.name AS trainer_name,
              cu.name AS owner_name,
              sd.label AS status_label, sd.meaning AS status_meaning, td.label AS batch_type_label
         FROM batch bt
         LEFT JOIN branch b ON b.id = bt.branch_id
         LEFT JOIN vertical v ON v.id = bt.vertical_id
         LEFT JOIN m_course c ON c.id = bt.course_id
         LEFT JOIN "user" u ON u.id = bt.trainer_id
         LEFT JOIN "user" cu ON cu.id = bt.created_by
         LEFT JOIN batch_status_def sd ON sd.code = bt.status
         LEFT JOIN batch_type_def   td ON td.code = bt.batch_type
        WHERE bt.id = $1::bigint AND bt.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!row) throw new NotFoundException('Batch not found (or outside your access)');
    return row;
  }

  /** STRICT CASCADE — vertical must be under the branch; course must be active. */
  private async assertHierarchy(branchId: number, verticalId: number, courseId: number) {
    if (!branchId) throw new BadRequestException('Choose a branch.');
    if (!verticalId) throw new BadRequestException('Choose a vertical.');
    if (!courseId) throw new BadRequestException('Choose a course.');
    const v = await this.db.one<any>(
      `SELECT id FROM vertical WHERE id = $1::bigint AND branch_id = $2::bigint AND deleted_at IS NULL`,
      [verticalId, branchId],
    );
    if (!v) throw new BadRequestException('That vertical does not belong to the chosen branch.');
    const c = await this.db.one<any>(
      `SELECT id FROM m_course WHERE id = $1::bigint AND is_active`,
      [courseId],
    );
    if (!c) throw new BadRequestException('Choose an active course.');
  }

  private date(v: unknown): string | null {
    return requireDateString(v, () => { throw new BadRequestException('That date is not a valid date.'); });
  }

  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const branchId = Number(dto?.branch_id);
    const verticalId = Number(dto?.vertical_id);
    const courseId = Number(dto?.course_id);
    await this.assertHierarchy(branchId, verticalId, courseId);
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the batch a name.');
    const orgId = await this.orgId();
    const trainerId = dto?.trainer_id ? Number(dto.trainer_id) : null;
    const capacity = Number.isFinite(Number(dto?.capacity)) ? Math.max(0, Number(dto.capacity)) : 0;
    const start = this.date(dto?.start_date);
    const end = this.date(dto?.end_date);
    const wanted = String(dto?.batch_code ?? '').trim() || null;

    // Initial status: an explicit MANUAL status pins (status_is_manual), otherwise DERIVE from
    // the dates (upcoming / active / expired), defaulting to 'upcoming' when there are no dates.
    const reqStatus = String(dto?.status ?? '').trim();
    let status: string; let isManual = false;
    if (reqStatus && BATCH_MANUAL_STATUSES.has(reqStatus)) { status = reqStatus; isManual = true; }
    else { status = deriveBatchStatus(start, end) ?? 'upcoming'; }

    // Batch type + frequency + class_days (081). Frequency DERIVES class_days when non-custom;
    // for 'custom' the supplied list is sanitised to ISO weekdays 1..7. Both are stored.
    const batchType = normaliseBatchType(dto?.batch_type);
    const frequency = normaliseFrequency(dto?.frequency);
    const classDays = normaliseClassDays(frequency, dto?.class_days);
    // Delivery mode (083) — Offline/Online/Hybrid; unknown falls back to 'Offline'. A batch of
    // type 'online' with no explicit delivery mode sensibly defaults to 'Online' (still settable).
    let deliveryMode = normaliseDeliveryMode(dto?.delivery_mode);
    if ((dto?.delivery_mode == null || String(dto.delivery_mode).trim() === '') && batchType === 'online') {
      deliveryMode = 'Online';
    }
    const description = dto?.description == null || String(dto.description).trim() === '' ? null : String(dto.description).trim();

    return this.db.tx(async (c) => {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO batch (org_id, name, branch_id, vertical_id, course_id, trainer_id,
                            capacity, room, schedule, start_date, end_date, status, status_is_manual,
                            status_changed_by, status_changed_at, remarks, created_by,
                            batch_type, frequency, class_days, delivery_mode, description)
         VALUES ($1::bigint, $2, $3::bigint, $4::bigint, $5::bigint, $6::bigint,
                 $7::int, $8, $9, $10::date, $11::date, $12, $13, $14::bigint, now(), $15, $16::bigint,
                 $17, $18, $19::int[], $20, $21)
         RETURNING id`,
        [orgId, name, branchId, verticalId, courseId, trainerId, capacity,
          dto?.room ?? null, dto?.schedule ?? null, start, end, status, isManual, me.id,
          dto?.remarks ?? null, me.id, batchType, frequency, classDays, deliveryMode, description],
      );
      const id = Number(ins.rows[0].id);
      const code = wanted ?? `BAT-${String(id).padStart(4, '0')}`;
      await c.query(`UPDATE batch SET batch_code = $2 WHERE id = $1::bigint`, [id, code]);
      await c.query(
        `INSERT INTO batch_status_history (org_id, branch_id, vertical_id, batch_id, from_status, to_status, is_manual, reason, changed_by)
         VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,NULL,$5,$6,$7,$8::bigint)`,
        [orgId, branchId, verticalId, id, status, isManual, isManual ? 'Set on creation' : 'Derived from dates on creation', me.id]);
      return { id, batch_code: code, status, status_is_manual: isManual };
    });
  }

  async update(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    // if branch/vertical/course change, re-validate the cascade
    const branchId = dto?.branch_id !== undefined ? Number(dto.branch_id) : Number(cur.branch_id);
    const verticalId = dto?.vertical_id !== undefined ? Number(dto.vertical_id) : Number(cur.vertical_id);
    const courseId = dto?.course_id !== undefined ? Number(dto.course_id) : Number(cur.course_id);
    if (dto?.branch_id !== undefined || dto?.vertical_id !== undefined || dto?.course_id !== undefined) {
      await this.assertHierarchy(branchId, verticalId, courseId);
    }
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    set('branch_id', branchId); set('vertical_id', verticalId); set('course_id', courseId);
    if (dto?.name !== undefined) { const n = String(dto.name).trim(); if (!n) throw new BadRequestException('Name cannot be empty.'); set('name', n); }
    if (dto?.trainer_id !== undefined) set('trainer_id', dto.trainer_id ? Number(dto.trainer_id) : null);
    if (dto?.capacity !== undefined) set('capacity', Math.max(0, Number(dto.capacity) || 0));
    if (dto?.room !== undefined) set('room', dto.room ?? null);
    if (dto?.schedule !== undefined) set('schedule', dto.schedule ?? null);
    if (dto?.start_date !== undefined) set('start_date', this.date(dto.start_date));
    if (dto?.end_date !== undefined) set('end_date', this.date(dto.end_date));
    if (dto?.remarks !== undefined) set('remarks', dto.remarks ?? null);
    // Batch type (081) — validated against the catalog (unknown -> 'regular').
    if (dto?.batch_type !== undefined) set('batch_type', normaliseBatchType(dto.batch_type));
    // Delivery mode + description (083). delivery_mode normalises to Offline/Online/Hybrid.
    if (dto?.delivery_mode !== undefined) set('delivery_mode', normaliseDeliveryMode(dto.delivery_mode));
    if (dto?.description !== undefined) set('description', dto.description == null || String(dto.description).trim() === '' ? null : String(dto.description).trim());
    // Frequency + class_days (081) — a change to EITHER re-resolves the pair via the one rule.
    // A non-custom frequency derives class_days; 'custom' keeps the (sanitised) supplied list.
    if (dto?.frequency !== undefined || dto?.class_days !== undefined) {
      const freq = dto?.frequency !== undefined ? normaliseFrequency(dto.frequency) : normaliseFrequency(cur.frequency);
      const days = normaliseClassDays(freq, dto?.class_days !== undefined ? dto.class_days : cur.class_days);
      set('frequency', freq);
      params.push(days); sets.push(`class_days = $${params.length}::int[]`);
    }
    // NOTE: `status` is deliberately NOT settable via a plain PATCH — the lifecycle transition
    // (manual sticky vs auto re-derive + history) goes through POST /batches/:id/status.
    params.push(id);
    await this.db.query(`UPDATE batch SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    // If the dates moved and the batch is NOT manually pinned, re-derive its status now.
    await this.refreshBatchStatuses();
    return { id };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    const inUse = await this.db.one<any>(
      `SELECT count(*)::int AS n FROM student WHERE batch_id = $1::bigint AND deleted_at IS NULL`, [id]);
    if (Number(inUse?.n) > 0) throw new BadRequestException(`${inUse.n} student(s) are assigned to this batch — move them first.`);
    await this.db.query(
      `UPDATE batch SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`,
      [id, me.id]);
    return { id, deleted: true };
  }

  /* ------------------------------------------------------ bulk (list) actions */

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }

  /** The subset of the requested ids that are live AND within the caller's scope. */
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, BATCH_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `SELECT bt.id FROM batch bt WHERE bt.id = ANY($1::bigint[]) AND bt.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }

  /** Impact preview for a bulk soft-delete (scoped; out-of-scope ids silently dropped). */
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw);
    const ok = await this.inScopeIds(req, scope);
    return {
      entity: 'batch', label: 'Batch', requested: req.length, in_scope: ok.length,
      out_of_scope: req.length - ok.length, total_associations: 0, impact: [],
    };
  }

  /** Bulk soft-delete — every in-scope id; a batch with students assigned is SKIPPED (not fatal). */
  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    let deleted = 0;
    for (const id of ok) {
      try { await this.remove(id, me, scope); deleted++; } catch { /* skip in-use / already gone */ }
    }
    return { deleted, skipped: this.idList(raw).length - deleted };
  }

  /**
   * BULK CHANGE STATUS — apply ONE target status to every in-scope selected batch. Each row goes
   * through changeStatus() so the SAME rule applies per batch: a manual status sticks, an auto
   * status re-derives from THAT batch's own dates (resume), and history is written per batch.
   * Out-of-scope ids are silently skipped; a row that rejects is skipped (never aborts the set).
   */
  async bulkStatus(raw: unknown, dto: any, me: { id: number }, scope: ResolvedScope) {
    const to = String(dto?.to_status ?? '').trim();
    if (!to) throw new BadRequestException('Choose a status.');
    if (!(BATCH_STATUS_CODES as readonly string[]).includes(to)) throw new BadRequestException('Unknown status.');
    const req = this.idList(raw);
    const ok = await this.inScopeIds(req, scope);
    let changed = 0;
    for (const id of ok) {
      try {
        const r: any = await this.changeStatus(id, { to_status: to, reason: dto?.reason }, me, scope);
        if (!r?.unchanged) changed++;
      } catch { /* skip a row that rejects */ }
    }
    return { changed, requested: req.length, in_scope: ok.length, to_status: to };
  }

  /** The 9-value batch-type catalog (code + label) — powers the Batch Type dropdown on the form. */
  async typeCatalog() {
    return this.db.query<any>(
      `SELECT code, label, ordering FROM batch_type_def ORDER BY ordering, code`);
  }

  /* ------------------------------------------------------ status lifecycle */

  /** The 7-status catalog (labels + meanings + manual/terminal flags) — powers the Change-Status UI. */
  async statusCatalog() {
    return this.db.query<any>(
      `SELECT code, label, meaning, is_manual, is_terminal, ordering
         FROM batch_status_def ORDER BY ordering, code`);
  }

  /**
   * CHANGE STATUS — the lifecycle transition. The route is guarded by batch.update (batch
   * create/update are restricted to Academic Admin / Branch·Vertical Manager / Org·Super Admin),
   * and the batch is loaded through the SCOPED get() so it is scope-enforced. Choosing a MANUAL
   * status (completed / cancelled / suspended / archived) pins it (status_is_manual = TRUE) so
   * the date logic never overrides it. Choosing an AUTO status (upcoming / active / expired) —
   * i.e. RESUMING a suspended batch — clears the pin and RE-DERIVES from the dates. Every change
   * writes batch_status_history. Idempotent (no real change -> unchanged:true).
   */
  async changeStatus(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const batch = await this.get(id, scope);
    const to = String(dto?.to_status ?? '').trim();
    if (!to) throw new BadRequestException('Choose a status.');
    const def = await this.db.one<any>(`SELECT * FROM batch_status_def WHERE code = $1`, [to]);
    if (!def) throw new BadRequestException('Unknown status.');
    const from = String(batch.status);
    const wasManual = !!batch.status_is_manual;
    const reason = dto?.reason == null || String(dto.reason).trim() === '' ? null : String(dto.reason).trim();

    let newStatus: string; let newIsManual: boolean;
    if (BATCH_MANUAL_STATUSES.has(to)) {
      newStatus = to; newIsManual = true;                                   // manual/terminal -> sticks
    } else {
      newIsManual = false;                                                  // back to auto mode
      newStatus = deriveBatchStatus(batch.start_date, batch.end_date) ?? to; // re-derive from dates (resume)
    }

    if (from === newStatus && wasManual === newIsManual) {
      return { id, status: newStatus, status_is_manual: newIsManual, unchanged: true };
    }

    const orgId = await this.orgId();
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE batch SET status = $2, status_is_manual = $3, status_reason = $4,
                          status_changed_by = $5::bigint, status_changed_at = now(), updated_at = now()
          WHERE id = $1::bigint`,
        [id, newStatus, newIsManual, reason, me.id]);
      await c.query(
        `INSERT INTO batch_status_history (org_id, branch_id, vertical_id, batch_id, from_status, to_status, is_manual, reason, changed_by)
         VALUES ($1::bigint,$2,$3,$4::bigint,$5,$6,$7,$8,$9::bigint)`,
        [orgId, batch.branch_id ?? null, batch.vertical_id ?? null, id, from, newStatus, newIsManual, reason, me.id]);
    });

    return {
      id, from_status: from, to_status: newStatus, status: newStatus,
      status_is_manual: newIsManual, label: def.label,
      resumed: !BATCH_MANUAL_STATUSES.has(to) && wasManual,
    };
  }

  /** The transition trail — who / when / from → to / manual? / reason. Scope-enforced via get(). */
  async statusHistory(id: number, scope: ResolvedScope) {
    await this.get(id, scope);
    return this.db.query<any>(
      `SELECT h.id, h.from_status, h.to_status, h.is_manual, h.reason, h.changed_by, h.changed_at,
              df.label AS from_label, dt.label AS to_label, ch.name AS changed_by_name
         FROM batch_status_history h
         LEFT JOIN batch_status_def df ON df.code = h.from_status
         LEFT JOIN batch_status_def dt ON dt.code = h.to_status
         LEFT JOIN "user" ch ON ch.id = h.changed_by
        WHERE h.batch_id = $1::bigint
        ORDER BY h.changed_at DESC, h.id DESC`, [id]);
  }
}
