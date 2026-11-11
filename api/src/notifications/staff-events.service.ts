import { Injectable, Logger, Optional } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../common/settings.service';
import { MessagingService } from '../messaging/messaging.service';
import { ManagerResolverService } from './manager-resolver.service';
import { CHANNELS, NotifyMessage } from './notifier.service';

/**
 * STAFF NOTIFICATION SETTINGS — client 11 Nov 2026 ("Development Requirements — 11 Nov", §2–4).
 *
 * One rule per business event (staff_notif_rule, migration 133) decides:
 *   · on / off (and the module master switch in app_setting `staff_notif_global`)
 *   · the channels — bell, toast pop-up, sound, desktop/browser, email, WhatsApp
 *   · WHO — the assigned user (owner / counsellor / trainer) and/or every holder of chosen roles
 *     in the record's branch
 *   · priority (low · medium · high · critical) — carried to the bell, colours + sorts the pop-up
 *   · WHEN — instantly, after a delay, or N minutes before / at / after a follow-up's time
 *   · HIERARCHY escalation — when it is not actioned within N minutes it goes to the person's
 *     Reports-To manager, then that manager's manager … for as many levels as configured.
 *
 * Delayed sends and escalations sit in staff_notif_queue and are claimed exactly once by the
 * reminder worker's tick (processQueue). Nothing here ever throws into a business action.
 */
export type Priority = 'low' | 'medium' | 'high' | 'critical';

export interface StaffRule {
  event_key: string; module: string; name: string; message: string;
  timing_kind: 'instant' | 'before' | 'at' | 'after'; sort_order: number;
  enabled: boolean; in_app: boolean; toast: boolean; sound: boolean; desktop: boolean;
  email: boolean; whatsapp: boolean; priority: Priority; delay_minutes: number;
  notify_owner: boolean; role_ids: number[];
  escalate: boolean; escalate_after_minutes: number; escalate_levels: number;
}

export interface StaffGlobal {
  modules: Record<string, boolean>;
  toast: boolean; sound: boolean; desktop: boolean; email: boolean; whatsapp: boolean;
}

export interface StaffEventCtx {
  title?: string;
  body?: string;
  /** the assigned user — counsellor / owner / trainer */
  owner_id?: number | null;
  /** who did it — never notified about their own action (unless include_actor) */
  actor_id?: number | null;
  include_actor?: boolean;
  branch_id?: number | null;
  vertical_id?: number | null;
  lead_id?: number | null;
  link?: NotifyMessage['link'];
  /** once-only key for repeatable instants (an instalment's due day …) */
  dedupe?: string | null;
  /** escalation keeps going only while this is still open: 'followup:<id>' | 'installment:<id>' */
  cond?: string | null;
  meta?: Record<string, unknown>;
}

const SEVERITY: Record<Priority, 'info' | 'warn' | 'error'> = { low: 'info', medium: 'info', high: 'warn', critical: 'error' };
export const DEFAULT_GLOBAL: StaffGlobal = {
  modules: { CRM: true, Admissions: true, Students: true, Finance: true, Academics: true, Attendance: true },
  toast: true, sound: true, desktop: true, email: true, whatsapp: true,
};

/** The running app's instance — lets any service fire a staff event without a constructor change
 *  (unit tests that never build the notifications module simply get null → no-op). */
let INSTANCE: StaffEventsService | null = null;
export const staffEvents = (): StaffEventsService | null => INSTANCE;

@Injectable()
export class StaffEventsService {
  private readonly log = new Logger('StaffEvents');
  private cache: { at: number; rules: Map<string, StaffRule>; global: StaffGlobal } | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    @Optional() private readonly managers?: ManagerResolverService,
    @Optional() private readonly messaging?: MessagingService,
  ) { INSTANCE = this; }

  /* ------------------------------------------------------------------ config */

  private async load() {
    if (this.cache && Date.now() - this.cache.at < 15_000) return this.cache;
    let rows: StaffRule[] = [];
    try {
      rows = await this.db.query<StaffRule>(`SELECT * FROM staff_notif_rule ORDER BY sort_order, event_key`);
    } catch { rows = []; } // table not migrated yet (unit tests) — every event behaves as before
    const g = await this.settings.get('staff_notif_global', DEFAULT_GLOBAL as unknown as Record<string, unknown>) as unknown as StaffGlobal;
    const global: StaffGlobal = { ...DEFAULT_GLOBAL, ...g, modules: { ...DEFAULT_GLOBAL.modules, ...(g?.modules ?? {}) } };
    this.cache = {
      at: Date.now(),
      rules: new Map(rows.map((r) => [r.event_key, { ...r, role_ids: (r.role_ids ?? []).map(Number), delay_minutes: Number(r.delay_minutes), escalate_after_minutes: Number(r.escalate_after_minutes), escalate_levels: Number(r.escalate_levels) }])),
      global,
    };
    return this.cache;
  }

  invalidate() { this.cache = null; }

  async rule(eventKey: string): Promise<StaffRule | null> { return (await this.load()).rules.get(eventKey) ?? null; }

  async global(): Promise<StaffGlobal> { return (await this.load()).global; }

  /** A rule that is switched on AND whose module is switched on. */
  async active(eventKey: string): Promise<StaffRule | null> {
    const c = await this.load();
    const r = c.rules.get(eventKey);
    if (!r || !r.enabled || c.global.modules[r.module] === false) return null;
    return r;
  }

  async listRules() {
    const c = await this.load();
    return { global: c.global, rules: [...c.rules.values()] };
  }

  async saveGlobal(dto: any, actorId: number) {
    const cur = await this.global();
    const next: StaffGlobal = {
      modules: { ...cur.modules },
      toast: dto?.toast !== undefined ? !!dto.toast : cur.toast,
      sound: dto?.sound !== undefined ? !!dto.sound : cur.sound,
      desktop: dto?.desktop !== undefined ? !!dto.desktop : cur.desktop,
      email: dto?.email !== undefined ? !!dto.email : cur.email,
      whatsapp: dto?.whatsapp !== undefined ? !!dto.whatsapp : cur.whatsapp,
    };
    if (dto?.modules && typeof dto.modules === 'object') {
      for (const [k, v] of Object.entries(dto.modules)) if (k in next.modules) next.modules[k] = !!v;
    }
    await this.settings.set('staff_notif_global', next as unknown as Record<string, unknown>, actorId);
    this.invalidate();
    return next;
  }

  async saveRule(eventKey: string, dto: any, actorId: number) {
    const cur = await this.rule(eventKey);
    if (!cur) return null;
    const b = (k: keyof StaffRule) => (dto?.[k] !== undefined ? !!dto[k] : (cur[k] as boolean));
    const n = (k: keyof StaffRule, min: number, max: number) => {
      if (dto?.[k] === undefined || dto[k] === null || dto[k] === '') return cur[k] as number;
      const v = Math.round(Number(dto[k]));
      if (!Number.isFinite(v)) return cur[k] as number;
      return Math.min(max, Math.max(min, v));
    };
    const priority = ['low', 'medium', 'high', 'critical'].includes(dto?.priority) ? dto.priority : cur.priority;
    const roleIds = Array.isArray(dto?.role_ids)
      ? [...new Set(dto.role_ids.map((x: unknown) => Number(x)).filter((x: number) => Number.isInteger(x) && x > 0))]
      : cur.role_ids;
    await this.db.query(
      `UPDATE staff_notif_rule SET enabled = $2, in_app = $3, toast = $4, sound = $5, desktop = $6, email = $7,
              whatsapp = $8, priority = $9, delay_minutes = $10, notify_owner = $11, role_ids = $12::bigint[],
              escalate = $13, escalate_after_minutes = $14, escalate_levels = $15, updated_at = now(), updated_by = $16
        WHERE event_key = $1`,
      [eventKey, b('enabled'), b('in_app'), b('toast'), b('sound'), b('desktop'), b('email'), b('whatsapp'), priority,
        n('delay_minutes', 0, 10080), b('notify_owner'), roleIds, b('escalate'),
        n('escalate_after_minutes', 1, 10080), n('escalate_levels', 1, 5), actorId],
    );
    this.invalidate();
    return this.rule(eventKey);
  }

  /* ------------------------------------------------------------------ firing */

  /** Fire an event: resolve the recipients, then deliver now or queue for the configured delay. */
  async emit(eventKey: string, ctx: StaffEventCtx): Promise<number> {
    const rule = await this.active(eventKey);
    if (!rule) return 0;
    if (ctx.dedupe) {
      const r = await this.db.query(
        `INSERT INTO staff_notif_sent (dedupe_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING dedupe_key`,
        [`${eventKey}:${ctx.dedupe}`.slice(0, 160)],
      );
      if (!r.length) return 0;
    }
    const recipients = await this.recipients(rule, ctx);
    if (!recipients.length) return 0;
    const payload = this.payload(rule, ctx);
    const primary = ctx.owner_id && recipients.includes(Number(ctx.owner_id)) ? Number(ctx.owner_id) : recipients[0];

    if (rule.timing_kind === 'instant' && rule.delay_minutes > 0) {
      for (const uid of recipients) {
        await this.db.query(
          `INSERT INTO staff_notif_queue (event_key, user_id, level, due_at, payload, cond)
           VALUES ($1, $2, 0, now() + ($3 || ' minutes')::interval, $4::jsonb, $5)`,
          [eventKey, uid, String(rule.delay_minutes), JSON.stringify({ ...payload, primary: uid === primary }), ctx.cond ?? null],
        );
      }
      return recipients.length;
    }
    for (const uid of recipients) {
      await this.deliver(rule, uid, payload, { escalateFrom: uid === primary, cond: ctx.cond ?? null });
    }
    return recipients.length;
  }

  async safeEmit(eventKey: string, ctx: StaffEventCtx): Promise<void> {
    try { await this.emit(eventKey, ctx); } catch (e) { this.log.warn(`staff event ${eventKey} failed: ${(e as Error).message}`); }
  }

  private payload(rule: StaffRule, ctx: StaffEventCtx) {
    return {
      title: (ctx.title || rule.message).slice(0, 200),
      body: ctx.body ?? null,
      link: ctx.link ?? (ctx.lead_id ? { type: 'lead', id: Number(ctx.lead_id) } : null),
      lead_id: ctx.lead_id ?? null, branch_id: ctx.branch_id ?? null, vertical_id: ctx.vertical_id ?? null,
      meta: ctx.meta ?? {},
    };
  }

  /** owner (when the rule says so) + active holders of the chosen roles in the record's branch/vertical. */
  async recipients(rule: StaffRule, ctx: StaffEventCtx): Promise<number[]> {
    const out = new Set<number>();
    if (rule.notify_owner && ctx.owner_id) out.add(Number(ctx.owner_id));
    if (rule.role_ids.length) {
      const rows = await this.db.query<{ id: string }>(
        `SELECT DISTINCT u.id FROM user_assignment a
           JOIN "user" u ON u.id = a.user_id AND u.status = 'active' AND u.deleted_at IS NULL
          WHERE a.is_active AND a.role_id = ANY($1::bigint[])
            AND ($2::bigint IS NULL OR a.branch_id IS NULL OR a.branch_id = $2::bigint)
            AND ($3::bigint IS NULL OR a.vertical_id IS NULL OR a.vertical_id = $3::bigint)`,
        [rule.role_ids, ctx.branch_id ?? null, ctx.vertical_id ?? null],
      );
      for (const r of rows) out.add(Number(r.id));
    }
    if (ctx.actor_id && !ctx.include_actor) out.delete(Number(ctx.actor_id));
    return [...out].filter((n) => Number.isInteger(n) && n > 0);
  }

  /**
   * Deliver ONE notification to ONE user on the rule's channels and, when this is the primary
   * recipient of an escalating rule, schedule the first hierarchy level. Returns the bell row id.
   */
  async deliver(rule: StaffRule, userId: number, p: any, opts: { escalateFrom?: boolean; cond?: string | null; level?: number } = {}, client?: PoolClient): Promise<number | null> {
    const g = await this.global();
    const q = async (sql: string, params: unknown[]) => (client ? (await client.query(sql, params as any[])).rows : this.db.query<any>(sql, params));
    const org = (await q(`SELECT id FROM organisation ORDER BY id LIMIT 1`, []))[0];
    const meta = {
      ...(p.meta ?? {}), event_key: rule.event_key, priority: rule.priority,
      toast: rule.toast && g.toast, sound: rule.sound && g.sound, desktop: rule.desktop && g.desktop,
      ...(opts.level ? { escalation_level: opts.level } : {}),
    };
    let nid: number | null = null;
    // the bell is the system of record — written whenever the rule keeps it on (default), and
    // always when a pop-up / sound / desktop alert needs a row to carry it.
    if (rule.in_app || meta.toast || meta.sound || meta.desktop) {
      const r = await q(
        `INSERT INTO notification (org_id, user_id, type, severity, title, body, link_type, link_id, meta, priority)
         VALUES ($1,$2,'event',$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
        [Number(org.id), userId, SEVERITY[rule.priority], String(p.title).slice(0, 200), p.body ?? null,
          p.link?.type ?? null, p.link?.id ?? null, JSON.stringify(meta), rule.priority],
      );
      nid = Number(r[0].id);
    }
    const msg: NotifyMessage = { userId, type: 'system', title: p.title, body: p.body ?? undefined, link: p.link ?? undefined };
    for (const ch of CHANNELS) {
      if (ch.key === 'in_app') continue;
      if (ch.key === 'email' && !(rule.email && g.email)) continue;
      if (ch.key === 'whatsapp' && !(rule.whatsapp && g.whatsapp)) continue;
      if (ch.key === 'sms') continue; // not offered on this screen
      try { await ch.send(msg, { db: this.db, orgId: Number(org.id), messaging: this.messaging as never }); }
      catch (e) { this.log.debug(`${ch.key} for ${rule.event_key} skipped: ${(e as Error).message}`); }
    }
    if (rule.escalate && opts.escalateFrom && (opts.level ?? 0) < rule.escalate_levels) {
      await q(
        `INSERT INTO staff_notif_queue (event_key, user_id, level, due_at, payload, parent_notification_id, cond)
         VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval, $5::jsonb, $6, $7)`,
        [rule.event_key, userId, (opts.level ?? 0) + 1, String(rule.escalate_after_minutes),
          JSON.stringify({ ...p, origin_user_id: p.origin_user_id ?? userId }), nid, opts.cond ?? null],
      );
    }
    return nid;
  }

  /** For the worker's own sweeps (follow-up upcoming / due / overdue): deliver to one user now. */
  async deliverEvent(eventKey: string, userId: number, ctx: StaffEventCtx, client?: PoolClient): Promise<boolean> {
    const rule = await this.active(eventKey);
    if (!rule) return false;
    await this.deliver(rule, userId, this.payload(rule, ctx), { escalateFrom: true, cond: ctx.cond ?? null }, client);
    return true;
  }

  /** An enrolment-centred event (enrolment, invoice, receipt, refund, fee due …): the owner is the
   *  enrolment's counsellor; the lead opens from the bell. Never throws. */
  async emitEnrolment(eventKey: string, enrolmentId: number, ctx: Omit<StaffEventCtx, 'owner_id' | 'lead_id' | 'branch_id' | 'vertical_id'> & { what?: string }) {
    try {
      if (!(await this.active(eventKey))) return;
      const e = await this.db.one<any>(
        `SELECT e.id, e.enrolment_no, e.lead_id, e.branch_id, e.vertical_id, e.counsellor_id,
                COALESCE(l.full_name, sp.full_name) AS name, c.name AS course
           FROM enrolment e LEFT JOIN lead l ON l.id = e.lead_id
           LEFT JOIN student sp ON sp.id = e.student_profile_id
           LEFT JOIN m_course c ON c.id = e.course_id
          WHERE e.id = $1`, [enrolmentId]);
      if (!e) return;
      const rule = (await this.rule(eventKey))!;
      await this.emit(eventKey, {
        ...ctx,
        owner_id: e.counsellor_id ? Number(e.counsellor_id) : null,
        lead_id: e.lead_id ? Number(e.lead_id) : null,
        branch_id: Number(e.branch_id), vertical_id: Number(e.vertical_id),
        title: ctx.title ?? `${rule.message} — ${e.name ?? e.enrolment_no}`,
        body: ctx.body ?? [e.enrolment_no, e.course, ctx.what].filter(Boolean).join(' · '),
      });
    } catch (err) { this.log.warn(`staff event ${eventKey} failed: ${(err as Error).message}`); }
  }

  /** A batch-centred event (batch created, timetable, attendance): the owner is the trainer. */
  async emitBatch(eventKey: string, batchId: number, ctx: Omit<StaffEventCtx, 'owner_id' | 'branch_id' | 'vertical_id'> & { what?: string }) {
    try {
      if (!(await this.active(eventKey))) return;
      const b = await this.db.one<any>(
        `SELECT bt.id, bt.name, bt.branch_id, bt.vertical_id, bt.trainer_id, c.name AS course
           FROM batch bt LEFT JOIN m_course c ON c.id = bt.course_id WHERE bt.id = $1`, [batchId]);
      if (!b) return;
      const rule = (await this.rule(eventKey))!;
      await this.emit(eventKey, {
        ...ctx,
        owner_id: b.trainer_id ? Number(b.trainer_id) : null,
        branch_id: Number(b.branch_id), vertical_id: Number(b.vertical_id),
        title: ctx.title ?? `${rule.message} — ${b.name}`,
        body: ctx.body ?? [b.course, ctx.what].filter(Boolean).join(' · '),
      });
    } catch (err) { this.log.warn(`staff event ${eventKey} failed: ${(err as Error).message}`); }
  }

  private lastFeeSweep = 0;

  /**
   * "Fee due" (an instalment due today, from 9 AM IST) and "Fee over due" (still unpaid N minutes
   * after its due date — the rule's delay; default 1 day). Each instalment notifies once per stage;
   * the overdue one escalates up the hierarchy while the instalment stays unpaid. At most every 10 min.
   */
  async sweepFees(): Promise<number> {
    if (Date.now() - this.lastFeeSweep < 10 * 60_000) return 0;
    this.lastFeeSweep = Date.now();
    let n = 0;
    const istHour = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }));
    const base = `SELECT i.id, i.seq_no, i.due_date, (i.amount_minor - i.paid_minor) AS out_minor, i.enrolment_id
                    FROM installment i
                    JOIN payment_plan pp ON pp.id = i.plan_id AND pp.status = 'active' AND pp.deleted_at IS NULL
                    JOIN enrolment e ON e.id = i.enrolment_id AND e.deleted_at IS NULL AND e.status = 'active'
                   WHERE i.status <> 'waived' AND i.amount_minor > i.paid_minor`;
    const rupees = (m: unknown) => `₹${(Number(m) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    if (istHour >= 9 && (await this.active('fee_due'))) {
      const rows = await this.db.query<any>(`${base} AND i.due_date = (now() AT TIME ZONE 'Asia/Kolkata')::date LIMIT 200`, []);
      for (const r of rows) {
        await this.emitEnrolment('fee_due', Number(r.enrolment_id), {
          dedupe: `inst:${r.id}:${String(r.due_date).slice(0, 10)}`, cond: `installment:${r.id}`,
          title: `Fee due today — ${rupees(r.out_minor)}`, what: `instalment ${r.seq_no}`,
        });
        n++;
      }
    }
    const od = await this.active('fee_overdue');
    if (od) {
      const rows = await this.db.query<any>(
        `${base} AND (i.due_date::timestamp AT TIME ZONE 'Asia/Kolkata') + ($1 || ' minutes')::interval <= now()
             AND i.due_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 45 LIMIT 200`, [String(od.delay_minutes)]);
      for (const r of rows) {
        const days = Math.max(1, Math.floor((Date.now() - new Date(String(r.due_date)).getTime()) / 86_400_000));
        await this.emitEnrolment('fee_overdue', Number(r.enrolment_id), {
          dedupe: `inst:${r.id}`, cond: `installment:${r.id}`,
          title: `Fee overdue — ${rupees(r.out_minor)}`, what: `instalment ${r.seq_no} · ${days} day(s) late`,
        });
        n++;
      }
    }
    return n;
  }

  /* ------------------------------------------------------------------ hierarchy */

  /**
   * The person ABOVE `userId`: their Reports-To manager (user.report_to_id). With none on file,
   * the record's own hierarchy (team leader → vertical manager → branch manager → org admin).
   */
  async managerOf(userId: number, p: { lead_id?: number | null; branch_id?: number | null }): Promise<number[]> {
    const u = await this.db.one<{ report_to_id: string | null }>(
      `SELECT r.id AS report_to_id FROM "user" u
         JOIN "user" r ON r.id = u.report_to_id AND r.status = 'active' AND r.deleted_at IS NULL
        WHERE u.id = $1`, [userId],
    );
    if (u?.report_to_id && Number(u.report_to_id) !== userId) return [Number(u.report_to_id)];
    if (p.lead_id && this.managers) {
      const m = await this.managers.managersFor(Number(p.lead_id), userId);
      if (m.length) return m;
    }
    const rows = await this.db.query<{ id: string }>(
      `SELECT DISTINCT u.id, CASE r.name WHEN 'Branch Manager' THEN 1 ELSE 2 END AS rk
         FROM user_assignment a JOIN role r ON r.id = a.role_id
         JOIN "user" u ON u.id = a.user_id AND u.status = 'active' AND u.deleted_at IS NULL
        WHERE a.is_active AND u.id <> $1
          AND ((r.name = 'Branch Manager' AND $2::bigint IS NOT NULL AND a.branch_id = $2::bigint)
               OR r.name = 'Organization Admin')
        ORDER BY rk`, [userId, p.branch_id ?? null],
    );
    const best = rows.length ? (rows[0] as any).rk : null;
    return rows.filter((r: any) => r.rk === best).map((r) => Number(r.id));
  }

  /** Is the thing the escalation is about still open? */
  private async stillOpen(row: any): Promise<boolean> {
    const cond = String(row.cond ?? '');
    if (cond.startsWith('followup:')) {
      const f = await this.db.one(`SELECT 1 FROM follow_up WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL`, [Number(cond.slice(9))]);
      return !!f;
    }
    if (cond.startsWith('installment:')) {
      const i = await this.db.one(`SELECT 1 FROM installment WHERE id = $1 AND amount_minor > paid_minor AND status <> 'waived'`, [Number(cond.slice(12))]);
      return !!i;
    }
    if (row.parent_notification_id) {
      const n = await this.db.one<{ read_at: string | null }>(`SELECT read_at FROM notification WHERE id = $1`, [Number(row.parent_notification_id)]);
      return !!n && !n.read_at;
    }
    return true;
  }

  /** Worker tick: deliver due delayed sends and fire due hierarchy escalations, each exactly once. */
  async processQueue(batch = 50): Promise<number> {
    let rows: any[] = [];
    try {
      rows = await this.db.query<any>(
        `SELECT * FROM staff_notif_queue WHERE sent_at IS NULL AND cancelled_at IS NULL AND due_at <= now()
          ORDER BY due_at LIMIT $1`, [batch]);
    } catch { return 0; }
    let done = 0;
    for (const row of rows) {
      const claim = await this.db.query(
        `UPDATE staff_notif_queue SET sent_at = now() WHERE id = $1 AND sent_at IS NULL AND cancelled_at IS NULL RETURNING id`, [Number(row.id)]);
      if (!claim.length) continue;
      try {
        const rule = await this.active(String(row.event_key));
        if (!rule) continue;
        const p = row.payload ?? {};
        if (Number(row.level) === 0) {
          await this.deliver(rule, Number(row.user_id), p, { escalateFrom: !!p.primary, cond: row.cond });
          done++; continue;
        }
        if (!(await this.stillOpen(row))) continue; // actioned in time — no escalation
        const level = Number(row.level);
        const mgrs = (await this.managerOf(Number(row.user_id), { lead_id: p.lead_id, branch_id: p.branch_id }))
          .filter((m) => m !== Number(p.origin_user_id ?? 0));
        if (!mgrs.length) continue;
        const who = await this.db.one<{ name: string }>(`SELECT name FROM "user" WHERE id = $1`, [Number(row.user_id)]);
        const ep = {
          ...p,
          title: `Escalation (level ${level}) — ${String(p.title ?? rule.message).replace(/^Escalation \(level \d+\) — /, '')}`.slice(0, 200),
          body: `Not actioned by ${who?.name ?? 'the assignee'} within ${rule.escalate_after_minutes} min.${p.body ? ` ${String(p.body).replace(/^Not actioned by .*? min\. /, '')}` : ''}`,
        };
        let first = true;
        for (const m of mgrs) {
          // only the first manager carries the next level on, so one chain never fans out
          await this.deliver(rule, m, ep, { escalateFrom: first, cond: row.cond, level }, undefined);
          first = false; done++;
        }
      } catch (e) {
        this.log.warn(`queue row ${row.id} failed: ${(e as Error).message}`);
      }
    }
    return done;
  }
}
