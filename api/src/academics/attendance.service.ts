import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange, requireDateString } from '../common/date.util';
import { MessagingService } from '../messaging/messaging.service';

/**
 * ATTENDANCE — per-session (batch + date) marking.
 *
 * A session is a (batch, date). The roster is the batch's live students; the trainer/staff
 * marks each Present/Absent/Late/Excused. `mode` records HOW it was marked — 'staff' (the live
 * UI), 'self' (a student marking their own), or 'biometric' (a device feed posting to the same
 * /mark endpoint; the live UI is staff/self — biometric is a later device integration, docs/dev/39).
 *
 * PARENT ALERT: marking a student ABSENT fires a parent-notification ATTEMPT via the shared
 * MessagingService (SMS to guardian/father mobile). It degrades cleanly — if no channel is
 * configured the send log records `not_configured` and marking still succeeds; a student with
 * no guardian number is simply not reachable. Marking NEVER fails because of a notification.
 */
export const ATT_SCOPE_COLS: ScopeColumnMap = { branch: 'a.branch_id', vertical: 'a.vertical_id', owner: 'a.marked_by' };
const BATCH_SCOPE_COLS: ScopeColumnMap = { branch: 'bt.branch_id', vertical: 'bt.vertical_id' };
const VALID = ['present', 'absent', 'late', 'excused'];
const MODES = ['staff', 'self', 'biometric'];

@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    @Optional() private readonly messaging?: MessagingService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private async batchInScope(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, BATCH_SCOPE_COLS, params);
    const b = await this.db.one<any>(
      `SELECT bt.id, bt.name, bt.branch_id, bt.vertical_id FROM batch bt
        WHERE bt.id = $1::bigint AND bt.deleted_at IS NULL AND ${w}`, params);
    if (!b) throw new NotFoundException('Batch not found (or outside your access)');
    return b;
  }

  private day(v: unknown): string {
    return requireDateString(v, () => { throw new BadRequestException('That session date is not a valid date.'); }) as string;
  }

  /** The marking sheet: the batch's students, each with their existing mark for the date. */
  async roster(batchId: number, date: string, scope: ResolvedScope) {
    const b = await this.batchInScope(batchId, scope);
    const d = this.day(date);
    const rows = await this.db.query<any>(
      `SELECT s.id AS student_id, s.full_name, s.student_no, s.guardian_mobile, s.father_mobile, s.phone,
              a.id AS attendance_id, a.status, a.mode, a.remarks, a.parent_notified
         FROM student s
         LEFT JOIN attendance a ON a.student_id = s.id AND a.batch_id = $1::bigint
                               AND a.session_date = $2::date AND a.deleted_at IS NULL
        WHERE s.batch_id = $1::bigint AND s.deleted_at IS NULL
        ORDER BY s.full_name`, [batchId, d]);
    return { batch: b, date: d, roster: rows };
  }

  /** Upsert a whole session's marks. Absent -> parent-notify attempt. */
  async mark(dto: any, me: { id: number }, scope: ResolvedScope) {
    const batchId = Number(dto?.batch_id);
    if (!batchId) throw new BadRequestException('Choose a batch.');
    const b = await this.batchInScope(batchId, scope);
    const date = this.day(dto?.date);
    const mode = MODES.includes(String(dto?.mode)) ? String(dto.mode) : 'staff';
    const entries: any[] = Array.isArray(dto?.entries) ? dto.entries : [];
    if (!entries.length) throw new BadRequestException('No attendance entries to mark.');
    const orgId = await this.orgId();

    let marked = 0;
    const absentStudents: number[] = [];
    await this.db.tx(async (c) => {
      for (const e of entries) {
        const sid = Number(e?.student_id);
        const status = String(e?.status);
        if (!sid || !VALID.includes(status)) continue;
        // student must belong to this batch (defends against a tampered payload)
        const belongs = await c.query(
          `SELECT 1 FROM student WHERE id = $1::bigint AND batch_id = $2::bigint AND deleted_at IS NULL`, [sid, batchId]);
        if (!belongs.rowCount) continue;
        await c.query(
          `INSERT INTO attendance (org_id, batch_id, student_id, branch_id, vertical_id, session_date,
                                   status, mode, remarks, marked_by)
           VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,$5::bigint,$6::date,$7,$8,$9,$10::bigint)
           ON CONFLICT (batch_id, student_id, session_date) WHERE deleted_at IS NULL
           DO UPDATE SET status = EXCLUDED.status, mode = EXCLUDED.mode, remarks = EXCLUDED.remarks,
                         marked_by = EXCLUDED.marked_by, updated_at = now()`,
          [orgId, batchId, sid, b.branch_id, b.vertical_id, date, status, mode, e?.remarks ?? null, me.id]);
        marked++;
        if (status === 'absent') absentStudents.push(sid);
      }
    });

    // Parent notifications (best-effort, outside the marking transaction).
    let notified = 0;
    for (const sid of absentStudents) {
      try {
        const ok = await this.notifyParentAbsent(sid, b.name, date, orgId);
        if (ok) {
          notified++;
          await this.db.query(
            `UPDATE attendance SET parent_notified = TRUE WHERE batch_id = $1::bigint AND student_id = $2::bigint AND session_date = $3::date AND deleted_at IS NULL`,
            [batchId, sid, date]);
        }
      } catch { /* a notification never fails the marking */ }
    }
    return { marked, absent: absentStudents.length, parent_notified: notified };
  }

  private async notifyParentAbsent(studentId: number, batchName: string, date: string, orgId: number): Promise<boolean> {
    const s = await this.db.one<any>(
      `SELECT full_name, guardian_mobile, father_mobile, phone, guardian_name FROM student WHERE id = $1::bigint`, [studentId]);
    const to = s?.guardian_mobile || s?.father_mobile || s?.phone;
    if (!to || !this.messaging) return false;
    const body = `Dear ${s.guardian_name || 'Parent'}, ${s.full_name} was marked ABSENT for ${batchName} on ${date}. — Tech Lingua`;
    await this.messaging.queue({ channel: 'sms', to, body, guarded: false });
    return true;
  }

  /** Attendance list — the Attendance screen + export. */
  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`a.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, ATT_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return;
      params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('a.batch_id', f.batch_id);
    multi('a.branch_id', f.branch_id);
    multi('a.vertical_id', f.vertical_id);
    if (VALID.includes(String(f.status))) { params.push(f.status); where.push(`a.status = $${params.length}::varchar`); }
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`a.session_date >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`a.session_date <= $${params.length}::date`); }
    params.push(Math.min(Number(f.limit ?? 500), 2000));
    return this.db.query<any>(
      `SELECT a.id, a.session_date, a.status, a.mode, a.parent_notified, a.remarks,
              s.full_name AS student_name, s.student_no, bt.name AS batch_name,
              b.name AS branch_name, v.name AS vertical_name, u.name AS marked_by_name
         FROM attendance a
         JOIN student s ON s.id = a.student_id
         JOIN batch bt ON bt.id = a.batch_id
         LEFT JOIN branch b ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN "user" u ON u.id = a.marked_by
        WHERE ${where.join(' AND ')}
        ORDER BY a.session_date DESC, s.full_name
        LIMIT $${params.length}`, params);
  }

  /** Present-% summary, per batch and (optionally) per student. */
  async summary(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`a.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, ATT_SCOPE_COLS, params)];
    const one = (col: string, raw?: string) => {
      const n = Number(raw); if (!Number.isFinite(n) || n <= 0) return;
      params.push(n); where.push(`${col} = $${params.length}::bigint`);
    };
    one('a.batch_id', f.batch_id);
    one('a.student_id', f.student_id);
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`a.session_date >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`a.session_date <= $${params.length}::date`); }
    const w = where.join(' AND ');
    const kpi = await this.db.one<any>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE a.status = 'present')::int AS present,
              count(*) FILTER (WHERE a.status = 'absent')::int  AS absent,
              count(*) FILTER (WHERE a.status = 'late')::int    AS late,
              count(*) FILTER (WHERE a.status = 'excused')::int AS excused,
              count(*) FILTER (WHERE a.parent_notified)::int    AS parent_alerts
         FROM attendance a WHERE ${w}`, params);
    const total = Number(kpi?.total ?? 0);
    const present = Number(kpi?.present ?? 0);
    const byStudent = await this.db.query<any>(
      `SELECT s.id AS student_id, s.full_name, count(*)::int AS sessions,
              count(*) FILTER (WHERE a.status = 'present')::int AS present,
              count(*) FILTER (WHERE a.status = 'absent')::int AS absent
         FROM attendance a JOIN student s ON s.id = a.student_id
        WHERE ${w} GROUP BY s.id, s.full_name ORDER BY s.full_name LIMIT 200`, params);
    return {
      kpis: {
        total, present, absent: Number(kpi?.absent ?? 0), late: Number(kpi?.late ?? 0),
        excused: Number(kpi?.excused ?? 0), parent_alerts: Number(kpi?.parent_alerts ?? 0),
        present_pct: total ? Math.round((present / total) * 1000) / 10 : null,
      },
      by_student: byStudent.map((r: any) => ({
        ...r, present_pct: r.sessions ? Math.round((r.present / r.sessions) * 1000) / 10 : null,
      })),
    };
  }
}
