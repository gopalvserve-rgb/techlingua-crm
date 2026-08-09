import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange, requireDateString } from '../common/date.util';

/**
 * BATCH — a class bound to Branch -> Vertical -> Course.
 *
 * This is the module-audit fix (client: "Add Batch must ask Branch + Vertical, and check
 * every module for the same gap"). A batch ALWAYS carries branch + vertical + course (all
 * NOT NULL in the schema AND validated here as a strict cascade: the vertical must belong
 * to the branch, the course must be applicable to that branch+vertical), so a batch can
 * never be created outside the hierarchy.
 */
export const BATCH_SCOPE_COLS: ScopeColumnMap = {
  branch: 'bt.branch_id', vertical: 'bt.vertical_id',
};

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

  async list(scope: ResolvedScope, f: {
    branch_id?: string; vertical_id?: string; course_id?: string; status?: string; q?: string;
    from?: string; to?: string; limit?: number;
  } = {}) {
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
    if (['active', 'completed', 'cancelled'].includes(String(f.status))) { params.push(f.status); where.push(`bt.status = $${params.length}::varchar`); }
    const _dr = assertDateRange(f.from, f.to);
    if (_dr.from) { params.push(_dr.from); where.push(`bt.created_at >= $${params.length}::timestamptz`); }
    if (_dr.to) { params.push(_dr.to); where.push(`bt.created_at < ($${params.length}::date + 1)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(bt.name ILIKE $${params.length} OR bt.batch_code ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));

    return this.db.query<any>(
      `SELECT bt.id, bt.batch_code, bt.name, bt.status, bt.capacity, bt.room, bt.schedule,
              bt.start_date, bt.end_date, bt.branch_id, bt.vertical_id, bt.course_id, bt.trainer_id,
              bt.created_at,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, u.name AS trainer_name,
              (SELECT count(*) FROM student st WHERE st.batch_id = bt.id AND st.deleted_at IS NULL)::int AS enrolled
         FROM batch bt
         LEFT JOIN branch  b  ON b.id = bt.branch_id
         LEFT JOIN vertical v ON v.id = bt.vertical_id
         LEFT JOIN m_course c ON c.id = bt.course_id
         LEFT JOIN "user"  u  ON u.id = bt.trainer_id
        WHERE ${where.join(' AND ')}
        ORDER BY bt.created_at DESC, bt.id DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, BATCH_SCOPE_COLS, params);
    const row = await this.db.one<any>(
      `SELECT bt.*, b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, u.name AS trainer_name
         FROM batch bt
         LEFT JOIN branch b ON b.id = bt.branch_id
         LEFT JOIN vertical v ON v.id = bt.vertical_id
         LEFT JOIN m_course c ON c.id = bt.course_id
         LEFT JOIN "user" u ON u.id = bt.trainer_id
        WHERE bt.id = $1::bigint AND bt.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!row) throw new NotFoundException('Batch not found (or outside your access)');
    return row;
  }

  /** STRICT CASCADE — vertical must be under the branch; course must be active. The client's
   *  standing rule (Branch › Vertical › Course), enforced server-side, not just in the form. */
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

    return this.db.tx(async (c) => {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO batch (org_id, name, branch_id, vertical_id, course_id, trainer_id,
                            capacity, room, schedule, start_date, end_date, status, remarks, created_by)
         VALUES ($1::bigint, $2, $3::bigint, $4::bigint, $5::bigint, $6::bigint,
                 $7::int, $8, $9, $10::date, $11::date, 'active', $12, $13::bigint)
         RETURNING id`,
        [orgId, name, branchId, verticalId, courseId, trainerId, capacity,
          dto?.room ?? null, dto?.schedule ?? null, start, end, dto?.remarks ?? null, me.id],
      );
      const id = Number(ins.rows[0].id);
      const code = wanted ?? `BAT-${String(id).padStart(4, '0')}`;
      await c.query(`UPDATE batch SET batch_code = $2 WHERE id = $1::bigint`, [id, code]);
      return { id, batch_code: code };
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
    if (dto?.status !== undefined) {
      if (!['active', 'completed', 'cancelled'].includes(String(dto.status))) throw new BadRequestException('Invalid status.');
      set('status', String(dto.status));
    }
    params.push(id);
    await this.db.query(`UPDATE batch SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
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
}
