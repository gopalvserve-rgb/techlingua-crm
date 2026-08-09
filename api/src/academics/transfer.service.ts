import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';

/**
 * BATCH TRANSFER + WAITLIST (Phase 2 ERP Batch 1).
 *
 * A student's batch assignment lives on `student.batch_id`. Moving it is the transfer; the
 * move is RECORDED in `batch_transfer` (from/to/when/by) and audited by the interceptor.
 *
 * CAPACITY: a batch's `capacity` (0 = unlimited) caps its live students. A transfer/assign
 * into a FULL batch does NOT move the student — it queues them on that batch's `batch_waitlist`
 * (ordered). "Promote from waitlist" (manual) fills a freed seat and performs the move. (Auto-
 * promote on a freed seat is a documented follow-up — see docs/dev/39.)
 *
 * CROSS-BRANCH: a transfer MAY cross branch/vertical/course. When it does, the student's
 * placement (branch/vertical/course) is updated to follow the target batch, so scoping and
 * reports stay consistent. Everything is validated against the caller's scope on BOTH ends.
 */
export const BATCH_SCOPE_COLS: ScopeColumnMap = { branch: 'bt.branch_id', vertical: 'bt.vertical_id' };
export const STUDENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 's.owner_id', team: 's.team_id', branch: 's.branch_id', vertical: 's.vertical_id',
  pipeline: 's.pipeline_id', campaign: 's.campaign_id',
};

@Injectable()
export class TransferService {
  constructor(private readonly db: DatabaseService, private readonly resolver: ScopeResolverService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private async batchInScope(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, BATCH_SCOPE_COLS, params);
    const b = await this.db.one<any>(
      `SELECT bt.id, bt.name, bt.batch_code, bt.capacity, bt.branch_id, bt.vertical_id, bt.course_id,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name
         FROM batch bt
         LEFT JOIN branch b ON b.id = bt.branch_id
         LEFT JOIN vertical v ON v.id = bt.vertical_id
         LEFT JOIN m_course c ON c.id = bt.course_id
        WHERE bt.id = $1::bigint AND bt.deleted_at IS NULL AND ${w}`, params);
    if (!b) throw new NotFoundException('Batch not found (or outside your access)');
    return b;
  }

  private async studentInScope(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, params);
    const s = await this.db.one<any>(
      `SELECT s.id, s.full_name, s.student_no, s.batch_id, s.branch_id, s.vertical_id, s.course_id
         FROM student s WHERE s.id = $1::bigint AND s.deleted_at IS NULL AND ${w}`, params);
    if (!s) throw new NotFoundException('Student not found (or outside your access)');
    return s;
  }

  private async filled(batchId: number): Promise<number> {
    const r = await this.db.one<{ n: string }>(
      `SELECT count(*)::int AS n FROM student WHERE batch_id = $1::bigint AND deleted_at IS NULL`, [batchId]);
    return Number(r?.n ?? 0);
  }

  private async seats(b: { id: number; capacity: number }) {
    const filled = await this.filled(Number(b.id));
    const capacity = Number(b.capacity ?? 0);
    const waiting = await this.db.one<{ n: string }>(
      `SELECT count(*)::int AS n FROM batch_waitlist WHERE batch_id = $1::bigint AND status = 'waiting'`, [b.id]);
    return { capacity, filled, free: capacity > 0 ? Math.max(0, capacity - filled) : null, waitlist: Number(waiting?.n ?? 0) };
  }

  /** Batch roster: seats, current members, waitlist and recent transfer history. */
  async roster(batchId: number, scope: ResolvedScope) {
    const b = await this.batchInScope(batchId, scope);
    const seats = await this.seats(b);
    const members = await this.db.query<any>(
      `SELECT s.id, s.full_name, s.student_no, s.phone, u.name AS owner_name
         FROM student s LEFT JOIN "user" u ON u.id = s.owner_id
        WHERE s.batch_id = $1::bigint AND s.deleted_at IS NULL
        ORDER BY s.full_name`, [batchId]);
    const waitlist = await this.db.query<any>(
      `SELECT w.id, w.student_id, w.position, w.note, w.created_at, s.full_name, s.student_no
         FROM batch_waitlist w JOIN student s ON s.id = w.student_id
        WHERE w.batch_id = $1::bigint AND w.status = 'waiting'
        ORDER BY w.position, w.created_at`, [batchId]);
    const history = await this.db.query<any>(
      `SELECT t.id, t.from_batch_id, t.to_batch_id, t.reason, t.created_at,
              s.full_name AS student_name, fb.name AS from_batch_name, tb.name AS to_batch_name, u.name AS by_name
         FROM batch_transfer t
         JOIN student s ON s.id = t.student_id
         LEFT JOIN batch fb ON fb.id = t.from_batch_id
         LEFT JOIN batch tb ON tb.id = t.to_batch_id
         LEFT JOIN "user" u ON u.id = t.transferred_by
        WHERE t.to_batch_id = $1::bigint OR t.from_batch_id = $1::bigint
        ORDER BY t.created_at DESC LIMIT 50`, [batchId]);
    return { batch: b, seats, members, waitlist, history };
  }

  /** Move a student into a target batch, or waitlist them if the batch is full. */
  async transfer(dto: any, me: { id: number }, scope: ResolvedScope) {
    const studentId = Number(dto?.student_id);
    const toBatchId = Number(dto?.to_batch_id);
    if (!studentId || !toBatchId) throw new BadRequestException('Choose a student and a target batch.');
    const student = await this.studentInScope(studentId, scope);
    const target = await this.batchInScope(toBatchId, scope);
    if (Number(student.batch_id) === toBatchId) throw new BadRequestException('The student is already in that batch.');

    const seats = await this.seats(target);
    if (seats.capacity > 0 && seats.filled >= seats.capacity) {
      // FULL — queue the student instead of moving them.
      return this.addWaitlist({ batch_id: toBatchId, student_id: studentId, note: dto?.reason ?? null }, me, scope, true);
    }

    const orgId = await this.orgId();
    const fromBatchId = student.batch_id ? Number(student.batch_id) : null;
    return this.db.tx(async (c) => {
      await c.query(
        `UPDATE student SET batch_id = $2::bigint, branch_id = $3::bigint, vertical_id = $4::bigint,
                            course_id = COALESCE($5::bigint, course_id), updated_at = now()
          WHERE id = $1::bigint`,
        [studentId, toBatchId, target.branch_id, target.vertical_id, target.course_id ?? null]);
      await c.query(
        `INSERT INTO batch_transfer (org_id, student_id, from_batch_id, to_batch_id, reason, transferred_by)
         VALUES ($1::bigint, $2::bigint, $3, $4::bigint, $5, $6::bigint)`,
        [orgId, studentId, fromBatchId, toBatchId, dto?.reason ?? null, me.id]);
      // if they were waiting on this batch, that seat is now taken -> promote the row
      await c.query(
        `UPDATE batch_waitlist SET status = 'promoted', promoted_at = now(), promoted_by = $3::bigint
          WHERE batch_id = $1::bigint AND student_id = $2::bigint AND status = 'waiting'`,
        [toBatchId, studentId, me.id]);
      return { id: studentId, moved: true, waitlisted: false, from_batch_id: fromBatchId, to_batch_id: toBatchId };
    });
  }

  /** Add a student to a batch's waitlist (ordered). */
  async addWaitlist(dto: any, me: { id: number }, scope: ResolvedScope, viaTransfer = false) {
    const batchId = Number(dto?.batch_id);
    const studentId = Number(dto?.student_id);
    if (!batchId || !studentId) throw new BadRequestException('Choose a batch and a student.');
    await this.batchInScope(batchId, scope);
    await this.studentInScope(studentId, scope);
    const exists = await this.db.one<any>(
      `SELECT id FROM batch_waitlist WHERE batch_id = $1::bigint AND student_id = $2::bigint AND status = 'waiting'`,
      [batchId, studentId]);
    if (exists) {
      if (viaTransfer) return { id: studentId, moved: false, waitlisted: true, waitlist_id: Number(exists.id), already: true };
      throw new BadRequestException('That student is already on this batch\'s waitlist.');
    }
    const orgId = await this.orgId();
    const pos = await this.db.one<{ n: string }>(
      `SELECT COALESCE(max(position), 0) + 1 AS n FROM batch_waitlist WHERE batch_id = $1::bigint AND status = 'waiting'`, [batchId]);
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO batch_waitlist (org_id, batch_id, student_id, position, note, created_by)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4::int, $5, $6::bigint) RETURNING id`,
      [orgId, batchId, studentId, Number(pos?.n ?? 1), dto?.note ?? null, me.id]);
    return { id: Number(ins[0].id), moved: false, waitlisted: true, position: Number(pos?.n ?? 1) };
  }

  /** Manually promote a waitlist entry into its batch (fills a freed seat). */
  async promote(id: number, me: { id: number }, scope: ResolvedScope) {
    const w = await this.db.one<any>(
      `SELECT w.id, w.batch_id, w.student_id, w.status FROM batch_waitlist w WHERE w.id = $1::bigint`, [id]);
    if (!w || w.status !== 'waiting') throw new NotFoundException('Waitlist entry not found.');
    const batch = await this.batchInScope(Number(w.batch_id), scope);
    await this.studentInScope(Number(w.student_id), scope);
    const seats = await this.seats(batch);
    if (seats.capacity > 0 && seats.filled >= seats.capacity) {
      throw new BadRequestException('The batch is still full — free a seat before promoting.');
    }
    // reuse transfer to perform the move + history + promote the row
    return this.transfer({ student_id: Number(w.student_id), to_batch_id: Number(w.batch_id), reason: 'Promoted from waitlist' }, me, scope);
  }

  async removeWaitlist(id: number, me: { id: number }, scope: ResolvedScope) {
    const w = await this.db.one<any>(`SELECT batch_id, status FROM batch_waitlist WHERE id = $1::bigint`, [id]);
    if (!w || w.status !== 'waiting') throw new NotFoundException('Waitlist entry not found.');
    await this.batchInScope(Number(w.batch_id), scope);
    await this.db.query(`UPDATE batch_waitlist SET status = 'removed' WHERE id = $1::bigint`, [id]);
    return { id, removed: true };
  }
}
