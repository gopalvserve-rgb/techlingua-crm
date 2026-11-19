import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { LEAD_SCOPE_COLS } from '../rbac/scope-cols';
import { TemplateService } from '../templates/template.service';
import { toDateString } from '../common/date.util';

/**
 * CROSS-SELL OPPORTUNITIES — client 12 Nov 2026 ("Cross sell module is still pending, complete it
 * now like this" + mockup).
 *
 *   Opportunities    separate records (cross_sell_opportunity) moving through 8 stages:
 *                    New → Assigned → Contacted → Interested → Quotation Sent → Negotiation →
 *                    Converted / Lost. Type: cross-sell, upsell, downsell, cross-vertical.
 *   Converted        is NEVER typed in: it is set when a real ACTIVE enrolment for that contact
 *                    and course exists (the normal Sale Closure), so "additional revenue" is the
 *                    enrolment's net fee and admissions / students / fees are untouched.
 *   Recommendations  converted contacts × a course they do not hold, with a MATCH %:
 *                      base   rule weight (admin, default 85) — or 60 for a same-vertical guess
 *                      +5     the contact's latest enrolment is fully paid
 *                      +5     they enrolled in the last 6 months
 *                      +4     the next level of the same course family ("German A1" → "German A2")
 *                    capped at 99. Every part is shown on hover so the number is never magic.
 *   Campaigns        an offer to a group of contacts: one opportunity each + a WhatsApp / SMS /
 *                    email template through the existing guarded message queue (opt-out, caps).
 *
 * RBAC: the existing crosssell.read / act / manage permissions. Opportunities are scoped on their
 * own denormalised path (owner / team / branch / vertical / pipeline / the contact's campaign);
 * recommendations and campaign audiences on the contact lead (LEAD_SCOPE_COLS).
 */

export const OPP_STAGES = ['new', 'assigned', 'contacted', 'interested', 'quotation_sent', 'negotiation', 'converted', 'lost'] as const;
export const SALE_TYPES = ['cross_sell', 'upsell', 'downsell', 'cross_vertical'] as const;
export type OppStage = (typeof OPP_STAGES)[number];
export type SaleType = (typeof SALE_TYPES)[number];
const OPEN_STAGES: OppStage[] = ['new', 'assigned', 'contacted', 'interested', 'quotation_sent', 'negotiation'];

export const OPP_SCOPE_COLS: ScopeColumnMap = {
  owner: 'o.owner_id', team: 'o.team_id', branch: 'o.branch_id',
  vertical: 'o.vertical_id', pipeline: 'o.pipeline_id', campaign: 'o.lead_campaign_id',
};

const csvStrs = (v: unknown): string[] => v == null ? []
  : (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
const csvNums = (v: unknown): number[] => [...new Set(csvStrs(v).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
const IST_TODAY = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** First word of a course name, lower-cased — "German A1" → "german" (the course family). */
export function courseFamily(name: unknown): string {
  return String(name ?? '').trim().toLowerCase().split(/[\s\-–:(]+/)[0] ?? '';
}

/** Explainable match % for a recommendation. Pure, so it is unit-tested and shown on hover. */
export function matchScore(x: { basis: 'rule' | 'vertical'; weight?: number | null; fullyPaid?: boolean; recent?: boolean;
  sameFamily?: boolean }): { pct: number; parts: Array<[string, number]> } {
  const parts: Array<[string, number]> = [];
  parts.push(x.basis === 'rule' ? ['Cross-sell rule', Number(x.weight ?? 85)] : ['Same vertical', 60]);
  if (x.fullyPaid) parts.push(['Fees fully paid', 5]);
  if (x.recent) parts.push(['Enrolled in the last 6 months', 5]);
  if (x.sameFamily) parts.push(['Next step in the same course family', 4]);
  const pct = Math.min(99, parts.reduce((a, [, v]) => a + v, 0));
  return { pct, parts };
}

/** Which kind of sale: the rule says so; otherwise another vertical → cross-vertical, the same
 *  course family → upsell (or downsell when the new course costs less), else cross-sell. */
export function saleTypeOf(x: { ruleType?: string | null; fromVertical?: unknown; toVertical?: unknown; sameFamily?: boolean;
  fromFee?: number; toFee?: number }): SaleType {
  if (x.ruleType && (SALE_TYPES as readonly string[]).includes(x.ruleType)) return x.ruleType as SaleType;
  if (x.toVertical != null && x.fromVertical != null && Number(x.toVertical) !== Number(x.fromVertical)) return 'cross_vertical';
  if (x.sameFamily) return (x.toFee ?? 0) > 0 && (x.fromFee ?? 0) > 0 && (x.toFee as number) < (x.fromFee as number) ? 'downsell' : 'upsell';
  return 'cross_sell';
}

/** A dashboard period → [from, toExclusive] IST dates, plus the previous period of the same length. */
export function periodWindow(p: string | undefined, from?: string, to?: string, today = IST_TODAY()) {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const add = (s: string, days: number) => { const x = d(s); x.setUTCDate(x.getUTCDate() + days); return iso(x); };
  const t = d(today); const Y = t.getUTCFullYear(); const M = t.getUTCMonth();
  let a: string | null; let b: string | null;
  switch (p) {
    case 'all': return { from: null, to: null, prevFrom: null, prevTo: null };
    case 'last_month': a = iso(new Date(Date.UTC(Y, M - 1, 1))); b = iso(new Date(Date.UTC(Y, M, 1))); break;
    case 'this_quarter': a = iso(new Date(Date.UTC(Y, Math.floor(M / 3) * 3, 1))); b = iso(new Date(Date.UTC(Y, Math.floor(M / 3) * 3 + 3, 1))); break;
    case 'this_year': a = iso(new Date(Date.UTC(Y, 0, 1))); b = iso(new Date(Date.UTC(Y + 1, 0, 1))); break;
    case 'last_30': a = add(today, -29); b = add(today, 1); break;
    case 'custom': a = toDateString(from) ?? null; b = toDateString(to) ? add(toDateString(to) as string, 1) : null; break;
    default: a = iso(new Date(Date.UTC(Y, M, 1))); b = iso(new Date(Date.UTC(Y, M + 1, 1)));   // this month
  }
  if (!a || !b) return { from: a, to: b, prevFrom: null, prevTo: null };
  const len = Math.round((d(b).getTime() - d(a).getTime()) / 86_400_000);
  return { from: a, to: b, prevFrom: add(a, -len), prevTo: a };
}

const pctChange = (now: number, prev: number): number | null => (prev > 0 ? Math.round(((now - prev) * 1000) / prev) / 10 : null);

@Injectable()
export class CrossSellOpportunityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly templates: TemplateService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* ============================================================ auto-convert */

  /**
   * Converted = a real enrolment. Any open opportunity whose contact now has an ACTIVE enrolment
   * for that course (created after the opportunity, a day's grace) is marked converted with the
   * enrolment's net fee. Runs before every read, so it holds whichever screen closed the sale
   * (Sale Closure, Convert to Student, Direct Enrolment, an approved admission).
   */
  async reconcile(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `WITH hit AS (
         SELECT o.id, o.stage AS from_stage, e.id AS enrolment_id, e.net_fee_minor, e.created_at
           FROM cross_sell_opportunity o
           JOIN LATERAL (SELECT e.id, e.net_fee_minor, e.created_at FROM enrolment e
                          WHERE e.lead_id = o.lead_id AND e.course_id = o.course_id AND e.deleted_at IS NULL
                            AND e.status = 'active' AND e.created_at >= o.created_at - interval '1 day'
                          ORDER BY e.created_at LIMIT 1) e ON TRUE
          WHERE o.deleted_at IS NULL AND o.stage NOT IN ('converted', 'lost')
       ), upd AS (
         UPDATE cross_sell_opportunity o
            SET stage = 'converted', enrolment_id = h.enrolment_id, converted_value_minor = h.net_fee_minor,
                converted_at = h.created_at, stage_changed_at = now(), updated_at = now()
           FROM hit h WHERE o.id = h.id
         RETURNING o.id, h.from_stage, h.enrolment_id
       )
       INSERT INTO cross_sell_opportunity_history (opportunity_id, from_stage, to_stage, note)
       SELECT id, from_stage, 'converted', 'Sale closed — enrolment #' || enrolment_id || ' created' FROM upd
       RETURNING opportunity_id AS id`);
    return rows.length;
  }

  /* ========================================================= recommendations */

  /**
   * One row per (contact, recommended course) with its type and match %. A contact is a
   * converted lead (won stage or any enrolment). Excluded: courses they hold, pairs already
   * actioned (cross_sell_attempt) and pairs with an open or converted opportunity.
   */
  async recommendations(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const scopeSql = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);
    const extra: string[] = [];
    const numIn = (col: string, ...keys: string[]) => {
      const vals = [...new Set(keys.flatMap((k) => csvNums(f?.[k])))];
      if (!vals.length) return;
      params.push(vals); extra.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    numIn('l.branch_id', 'branch_id', 'branch_ids');
    numIn('l.vertical_id', 'vertical_id', 'vertical_ids');
    numIn('l.owner_id', 'owner_id', 'owner_ids');
    const lim = Math.min(Number(f?.limit ?? 500), 2000);
    const rows = await this.db.query<any>(
      `WITH cand AS (
         SELECT l.id AS lead_id, l.full_name, l.phone, l.branch_id, l.vertical_id, l.owner_id, l.course_id,
                b.name AS branch_name, v.name AS vertical_name, u.name AS owner_name,
                (SELECT s.id FROM student s WHERE s.lead_id = l.id AND s.deleted_at IS NULL ORDER BY s.id LIMIT 1) AS student_id
           FROM lead l
           LEFT JOIN pipeline_stage st ON st.id = l.stage_id
           LEFT JOIN branch b   ON b.id = l.branch_id
           LEFT JOIN vertical v ON v.id = l.vertical_id
           LEFT JOIN "user" u   ON u.id = l.owner_id
          WHERE l.is_active AND l.deleted_at IS NULL AND ${scopeSql}${extra.length ? ' AND ' + extra.join(' AND ') : ''}
            AND (st.stage_type = 'won' OR EXISTS (SELECT 1 FROM enrolment e WHERE e.lead_id = l.id AND e.deleted_at IS NULL))
       ),
       held AS (
         SELECT c.lead_id, c.course_id FROM cand c WHERE c.course_id IS NOT NULL
         UNION
         SELECT e.lead_id, e.course_id FROM enrolment e JOIN cand c ON c.lead_id = e.lead_id
          WHERE e.deleted_at IS NULL AND e.course_id IS NOT NULL
       ),
       latest AS (   -- the contact's latest enrolment: its course, fee, when, and whether it is fully paid
         SELECT DISTINCT ON (e.lead_id) e.lead_id, e.course_id, e.created_at, e.net_fee_minor,
                (e.net_fee_minor + COALESCE(e.exam_fee_minor, 0)
                  - COALESCE((SELECT sum(fr.amount_minor) FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL), 0)) AS outstanding
           FROM enrolment e JOIN cand c ON c.lead_id = e.lead_id
          WHERE e.deleted_at IS NULL AND e.status = 'active'
          ORDER BY e.lead_id, e.created_at DESC
       ),
       ruled AS (SELECT DISTINCT h.lead_id FROM held h
                   JOIN cross_sell_rule r ON r.source_course_id = h.course_id AND r.is_active AND r.deleted_at IS NULL),
       suggest AS (
         SELECT c.lead_id, h.course_id AS from_course_id, r.target_course_id AS course_id, 'rule'::text AS basis,
                r.sale_type AS rule_type, r.weight
           FROM cand c JOIN held h ON h.lead_id = c.lead_id
           JOIN cross_sell_rule r ON r.source_course_id = h.course_id AND r.is_active AND r.deleted_at IS NULL
         UNION ALL
         SELECT c.lead_id, COALESCE(lt.course_id, c.course_id), oc.id, 'vertical'::text, NULL::text, NULL::int
           FROM cand c LEFT JOIN latest lt ON lt.lead_id = c.lead_id
           JOIN m_course oc ON oc.is_active AND oc.deleted_at IS NULL AND (oc.meta->>'vertical_id') IS NOT NULL
                AND (oc.meta->>'vertical_id')::bigint = c.vertical_id
          WHERE c.lead_id NOT IN (SELECT lead_id FROM ruled)
       )
       SELECT DISTINCT ON (s.lead_id, s.course_id)
              c.lead_id, c.student_id, c.full_name, c.phone, c.branch_id, c.vertical_id, c.owner_id,
              c.branch_name, c.vertical_name, c.owner_name,
              s.from_course_id, fc.name AS from_course_name, s.course_id, tc.name AS course_name,
              s.basis, s.rule_type, s.weight,
              (fc.meta->>'vertical_id') AS from_vertical_id, (tc.meta->>'vertical_id') AS to_vertical_id,
              tv.name AS to_vertical_name,
              NULLIF(fc.meta->>'fee', '')::numeric AS from_fee, NULLIF(tc.meta->>'fee', '')::numeric AS to_fee,
              lt.created_at AS last_enrolled_at, lt.outstanding
         FROM suggest s
         JOIN cand c ON c.lead_id = s.lead_id
         JOIN m_course tc ON tc.id = s.course_id
         LEFT JOIN m_course fc ON fc.id = s.from_course_id
         LEFT JOIN vertical tv ON tv.id = NULLIF(tc.meta->>'vertical_id', '')::bigint
         LEFT JOIN latest lt ON lt.lead_id = s.lead_id
        WHERE s.course_id NOT IN (SELECT h.course_id FROM held h WHERE h.lead_id = s.lead_id)
          AND NOT EXISTS (SELECT 1 FROM cross_sell_attempt a WHERE a.lead_id = s.lead_id AND a.suggested_course_id = s.course_id AND a.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM cross_sell_opportunity o WHERE o.lead_id = s.lead_id AND o.course_id = s.course_id
                             AND o.deleted_at IS NULL AND o.stage <> 'lost')
        ORDER BY s.lead_id, s.course_id, (s.basis = 'rule') DESC, s.weight DESC NULLS LAST
        LIMIT ${lim}`,
      params,
    );
    const sixMonthsAgo = Date.now() - 183 * 86_400_000;
    const out = rows.map((r) => {
      const sameFamily = !!r.from_course_name && courseFamily(r.from_course_name) === courseFamily(r.course_name)
        && courseFamily(r.course_name) !== '';
      const score = matchScore({
        basis: r.basis, weight: r.weight, sameFamily,
        fullyPaid: r.outstanding != null && Number(r.outstanding) <= 0,
        recent: r.last_enrolled_at ? new Date(r.last_enrolled_at).getTime() >= sixMonthsAgo : false,
      });
      const fromFee = Number(r.from_fee ?? 0); const toFee = Number(r.to_fee ?? 0);
      return {
        lead_id: Number(r.lead_id), student_id: r.student_id ? Number(r.student_id) : null,
        full_name: r.full_name, phone: r.phone,
        branch_id: r.branch_id ? Number(r.branch_id) : null, vertical_id: r.vertical_id ? Number(r.vertical_id) : null,
        owner_id: r.owner_id ? Number(r.owner_id) : null,
        branch_name: r.branch_name, vertical_name: r.vertical_name, owner_name: r.owner_name,
        from_course_id: r.from_course_id ? Number(r.from_course_id) : null, from_course_name: r.from_course_name,
        course_id: Number(r.course_id), course_name: r.course_name, to_vertical_name: r.to_vertical_name,
        basis: r.basis,
        sale_type: saleTypeOf({ ruleType: r.rule_type, fromVertical: r.from_vertical_id ?? r.vertical_id, toVertical: r.to_vertical_id, sameFamily, fromFee, toFee }),
        match_pct: score.pct, match_parts: score.parts,
        value_minor: Math.round(toFee * 100),
      };
    });
    const types = csvStrs(f?.sale_type);
    const filtered = types.length ? out.filter((r) => types.includes(r.sale_type)) : out;
    return filtered.sort((a, b) => b.match_pct - a.match_pct || String(a.full_name).localeCompare(String(b.full_name)));
  }

  /** The mockup's "Top Recommendations": per (current course → recommended course), how many
   *  contacts qualify and their average match. */
  async topRecommendations(scope: ResolvedScope, f: any = {}, limit = 5) {
    const recs = await this.recommendations(scope, f);
    const m = new Map<string, any>();
    for (const r of recs) {
      const k = `${r.from_course_id ?? 0}:${r.course_id}`;
      const g = m.get(k) ?? { from_course_id: r.from_course_id, from_course_name: r.from_course_name, course_id: r.course_id,
        course_name: r.course_name, sale_type: r.sale_type, contacts: 0, sum: 0, lead_ids: [] as number[], value_minor: r.value_minor };
      g.contacts += 1; g.sum += r.match_pct; g.lead_ids.push(r.lead_id);
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, match_pct: Math.round(g.sum / g.contacts), sum: undefined }))
      .sort((a, b) => b.match_pct - a.match_pct || b.contacts - a.contacts).slice(0, limit);
  }

  /* =========================================================== opportunities */

  private filterSql(f: any, params: unknown[], alias = 'o') {
    const where: string[] = [];
    const numIn = (col: string, ...keys: string[]) => {
      const vals = [...new Set(keys.flatMap((k) => csvNums(f?.[k])))];
      if (!vals.length) return;
      params.push(vals); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    numIn(`${alias}.branch_id`, 'branch_id', 'branch_ids');
    numIn(`${alias}.vertical_id`, 'vertical_id', 'vertical_ids');
    numIn(`${alias}.course_id`, 'course_id', 'course_ids');
    numIn(`${alias}.owner_id`, 'owner_id', 'owner_ids');
    numIn(`${alias}.campaign_id`, 'campaign_id', 'campaign_ids');
    const stages = csvStrs(f?.stage).filter((s) => (OPP_STAGES as readonly string[]).includes(s));
    if (stages.length) { params.push(stages); where.push(`${alias}.stage = ANY($${params.length}::text[])`); }
    const types = csvStrs(f?.sale_type).filter((s) => (SALE_TYPES as readonly string[]).includes(s));
    if (types.length) { params.push(types); where.push(`${alias}.sale_type = ANY($${params.length}::text[])`); }
    if (f?.customer_type === 'student') where.push(`${alias}.student_id IS NOT NULL`);
    if (f?.customer_type === 'lead') where.push(`${alias}.student_id IS NULL`);
    return where;
  }

  private static readonly OPP_SELECT = `
       SELECT o.*, l.full_name, l.phone, l.email,
              fc.name AS from_course_name, c.name AS course_name, u.name AS owner_name,
              b.name AS branch_name, v.name AS vertical_name, cp.name AS campaign_name,
              e.enrolment_no, fu.scheduled_at AS follow_up_at, fu.status AS follow_up_status
         FROM cross_sell_opportunity o
         JOIN lead l ON l.id = o.lead_id
         LEFT JOIN m_course fc ON fc.id = o.from_course_id
         LEFT JOIN m_course c  ON c.id = o.course_id
         LEFT JOIN "user" u    ON u.id = o.owner_id
         LEFT JOIN branch b    ON b.id = o.branch_id
         LEFT JOIN vertical v  ON v.id = o.vertical_id
         LEFT JOIN cross_sell_campaign cp ON cp.id = o.campaign_id
         LEFT JOIN enrolment e ON e.id = o.enrolment_id
         LEFT JOIN follow_up fu ON fu.id = o.follow_up_id`;

  async list(scope: ResolvedScope, f: any = {}) {
    await this.reconcile();
    const params: unknown[] = [];
    const where = ['o.deleted_at IS NULL', this.resolver.buildScopeWhere(scope, OPP_SCOPE_COLS, params), ...this.filterSql(f, params)];
    const w = periodWindow(f?.period, f?.from, f?.to);
    if (f?.period && w.from) { params.push(w.from); where.push(`o.created_at >= $${params.length}::date`); }
    if (f?.period && w.to) { params.push(w.to); where.push(`o.created_at < $${params.length}::date`); }
    const q = String(f?.q ?? '').trim();
    if (q) {
      params.push(`%${q}%`); const a = params.length;
      params.push(`%${q.replace(/\D/g, '')}%`); const b = params.length;
      where.push(`(l.full_name ILIKE $${a} OR c.name ILIKE $${a}${q.replace(/\D/g, '').length >= 4 ? ` OR regexp_replace(COALESCE(l.phone,''),'\\D','','g') ILIKE $${b}` : ''})`);
    }
    const lim = Math.min(Number(f?.limit ?? 300), 1000);
    return this.db.query<any>(`${CrossSellOpportunityService.OPP_SELECT}
        WHERE ${where.join(' AND ')}
        ORDER BY o.created_at DESC LIMIT ${lim}`, params);
  }

  private async getScoped(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, OPP_SCOPE_COLS, params);
    const r = await this.db.one<any>(`${CrossSellOpportunityService.OPP_SELECT}
        WHERE o.id = $1::bigint AND o.deleted_at IS NULL AND ${w}`, params);
    if (!r) throw new NotFoundException('Opportunity not found (or outside your access)');
    return r;
  }

  async get(id: number, scope: ResolvedScope) {
    await this.reconcile();
    const o = await this.getScoped(id, scope);
    const history = await this.db.query<any>(
      `SELECT h.*, u.name AS actor_name FROM cross_sell_opportunity_history h
         LEFT JOIN "user" u ON u.id = h.actor_id WHERE h.opportunity_id = $1 ORDER BY h.created_at DESC, h.id DESC`, [id]);
    return { ...o, history };
  }

  /** Create an opportunity on a contact the caller can see. Defaults: from-course = the contact's
   *  latest enrolled course, value = the recommended course's fee, owner = the contact's owner,
   *  type computed (or as given). An open one for the same contact + course is a 409. */
  async create(dto: any, me: { id: number }, scope: ResolvedScope, src: 'manual' | 'recommendation' | 'campaign' = 'manual', campaignId: number | null = null) {
    const leadId = Number(dto?.lead_id); const courseId = Number(dto?.course_id);
    if (!leadId || !courseId) throw new BadRequestException('Pick the contact and the course to offer.');
    const params: unknown[] = [leadId];
    const w = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);
    const lead = await this.db.one<any>(
      `SELECT l.* FROM lead l WHERE l.id = $1::bigint AND l.deleted_at IS NULL AND ${w}`, params);
    if (!lead) throw new NotFoundException('Contact not found (or outside your access)');
    const course = await this.db.one<any>(`SELECT id, name, meta FROM m_course WHERE id = $1 AND deleted_at IS NULL`, [courseId]);
    if (!course) throw new BadRequestException('Choose an active course to offer.');
    const latest = await this.db.one<any>(
      `SELECT e.course_id, c.name, c.meta FROM enrolment e LEFT JOIN m_course c ON c.id = e.course_id
        WHERE e.lead_id = $1 AND e.deleted_at IS NULL AND e.course_id IS NOT NULL ORDER BY e.created_at DESC LIMIT 1`, [leadId]);
    const fromCourseId = dto?.from_course_id ? Number(dto.from_course_id) : (latest?.course_id ? Number(latest.course_id) : (lead.course_id ? Number(lead.course_id) : null));
    if (fromCourseId === courseId) throw new BadRequestException('The contact already has that course — pick a different one to offer.');
    const fromCourse = fromCourseId ? (latest && Number(latest.course_id) === fromCourseId ? latest
      : await this.db.one<any>(`SELECT id, name, meta FROM m_course WHERE id = $1`, [fromCourseId])) : null;
    const sameFamily = !!fromCourse && courseFamily(fromCourse.name) === courseFamily(course.name);
    const saleType: SaleType = (SALE_TYPES as readonly string[]).includes(String(dto?.sale_type)) ? dto.sale_type
      : saleTypeOf({ fromVertical: fromCourse?.meta?.vertical_id ?? lead.vertical_id, toVertical: course.meta?.vertical_id, sameFamily,
        fromFee: Number(fromCourse?.meta?.fee ?? 0), toFee: Number(course.meta?.fee ?? 0) });
    const value = dto?.value_minor != null && dto.value_minor !== '' ? Math.max(0, Math.round(Number(dto.value_minor)))
      : dto?.value != null && dto.value !== '' ? Math.max(0, Math.round(Number(dto.value) * 100))
        : Math.round(Number(course.meta?.fee ?? 0) * 100);
    if (!Number.isFinite(value)) throw new BadRequestException('Enter a valid value.');
    const ownerId = dto?.owner_id ? Number(dto.owner_id) : (lead.owner_id ? Number(lead.owner_id) : me.id);
    const student = await this.db.one<{ id: string }>(`SELECT id FROM student WHERE lead_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`, [leadId]);
    const stage: OppStage = ownerId !== me.id ? 'assigned' : 'new';
    const orgId = Number(lead.org_id);
    try {
      const out = await this.db.tx(async (c) => {
        const ins = await c.query(
          `INSERT INTO cross_sell_opportunity (org_id, lead_id, student_id, from_course_id, course_id, sale_type, stage, value_minor,
                                               match_pct, source, campaign_id, owner_id, branch_id, vertical_id, team_id, pipeline_id,
                                               lead_campaign_id, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
          [orgId, leadId, student ? Number(student.id) : null, fromCourseId, courseId, saleType, stage, value,
            dto?.match_pct != null ? Math.min(100, Math.max(0, Math.round(Number(dto.match_pct)))) : null, src, campaignId, ownerId,
            lead.branch_id, lead.vertical_id, lead.team_id ?? null, lead.pipeline_id ?? null, lead.campaign_id ?? null,
            dto?.note ? String(dto.note).slice(0, 2000) : null, me.id]);
        const id = Number(ins.rows[0].id);
        await c.query(`INSERT INTO cross_sell_opportunity_history (opportunity_id, from_stage, to_stage, actor_id, note) VALUES ($1, NULL, $2, $3, $4)`,
          [id, stage, me.id, src === 'campaign' ? 'Created by a cross-sell campaign' : src === 'recommendation' ? 'Created from a recommendation' : 'Created']);
        await c.query(
          `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, to_value, note) VALUES ($1,$2,$3,$4,'cross_sell',$5,$6)`,
          [leadId, orgId, lead.branch_id, me.id, JSON.stringify({ opportunity_id: id, course_id: courseId, sale_type: saleType }),
            `Cross-sell opportunity: ${course.name}`]);
        return id;
      });
      if (dto?.next_follow_up_at) await this.scheduleFollowUp(out, String(dto.next_follow_up_at), me, dto?.follow_up_note);
      return { id: out, stage, sale_type: saleType, value_minor: value };
    } catch (e: any) {
      if (String(e?.code) === '23505') throw new ConflictException('This contact already has an open opportunity for that course.');
      throw e;
    }
  }

  /** Book the next follow-up as a real follow_up (Today's Follow-ups, reminders, escalation all apply). */
  private async scheduleFollowUp(id: number, when: string, me: { id: number }, note?: string) {
    const at = new Date(when);
    if (isNaN(at.getTime())) throw new BadRequestException('Enter a valid follow-up date and time.');
    const o = await this.db.one<any>(`SELECT o.*, c.name AS course_name FROM cross_sell_opportunity o LEFT JOIN m_course c ON c.id = o.course_id WHERE o.id = $1`, [id]);
    const fu = await this.db.one<{ id: string }>(
      `INSERT INTO follow_up (lead_id, owner_id, scheduled_at, status, notes, created_by, report_to_id)
       VALUES ($1::bigint, $2::bigint, $3::timestamptz, 'pending', $4, $5::bigint, $5::bigint) RETURNING id`,
      [o.lead_id, o.owner_id ?? me.id, at.toISOString(), `Cross-sell: ${o.course_name ?? 'course'}${note ? ` — ${String(note).slice(0, 500)}` : ''}`, me.id]);
    await this.db.query(`UPDATE cross_sell_opportunity SET follow_up_id = $2, next_follow_up_at = $3, updated_at = now() WHERE id = $1`,
      [id, Number(fu!.id), at.toISOString()]);
    return Number(fu!.id);
  }

  /** Move a stage / change value, owner, type, note, next follow-up. "Converted" only comes from a
   *  real enrolment; "Lost" needs a reason. */
  async update(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    await this.reconcile();
    const o = await this.getScoped(id, scope);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    let toStage: OppStage | null = null;
    if (dto?.stage !== undefined && dto.stage !== o.stage) {
      const s = String(dto.stage) as OppStage;
      if (!(OPP_STAGES as readonly string[]).includes(s)) throw new BadRequestException('Unknown stage.');
      if (o.stage === 'converted') throw new BadRequestException('This opportunity is converted — the sale is closed.');
      if (s === 'converted') {
        throw new BadRequestException(`Close the sale with Sale Closure (enrol the student in ${o.course_name ?? 'the course'}) — the opportunity converts by itself.`);
      }
      if (s === 'lost' && !String(dto?.lost_reason ?? '').trim()) throw new BadRequestException('Say why it was lost.');
      toStage = s;
      set('stage', s); set('stage_changed_at', new Date().toISOString());
      set('lost_reason', s === 'lost' ? String(dto.lost_reason).trim().slice(0, 500) : null);
    }
    if (dto?.value !== undefined && dto.value !== '') {
      const v = Math.round(Number(dto.value) * 100);
      if (!Number.isFinite(v) || v < 0) throw new BadRequestException('Enter a valid value.');
      set('value_minor', v);
    }
    if (dto?.sale_type !== undefined) {
      if (!(SALE_TYPES as readonly string[]).includes(String(dto.sale_type))) throw new BadRequestException('Unknown type.');
      set('sale_type', dto.sale_type);
    }
    if (dto?.owner_id !== undefined && Number(dto.owner_id) !== Number(o.owner_id)) {
      const u = await this.db.one<{ id: string }>(`SELECT id FROM "user" WHERE id = $1 AND deleted_at IS NULL`, [Number(dto.owner_id)]);
      if (!u) throw new BadRequestException('Pick an active user.');
      set('owner_id', Number(dto.owner_id));
      if (!toStage && o.stage === 'new') { toStage = 'assigned'; set('stage', 'assigned'); set('stage_changed_at', new Date().toISOString()); }
    }
    if (dto?.note !== undefined) set('note', dto.note ? String(dto.note).slice(0, 2000) : null);
    if (sets.length) {
      params.push(id);
      await this.db.query(`UPDATE cross_sell_opportunity SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
    }
    if (toStage) {
      await this.db.query(`INSERT INTO cross_sell_opportunity_history (opportunity_id, from_stage, to_stage, actor_id, note) VALUES ($1,$2,$3,$4,$5)`,
        [id, o.stage, toStage, me.id, toStage === 'lost' ? String(dto.lost_reason).trim().slice(0, 500) : (dto?.stage_note ? String(dto.stage_note).slice(0, 500) : null)]);
    }
    if (dto?.next_follow_up_at) await this.scheduleFollowUp(id, String(dto.next_follow_up_at), me, dto?.follow_up_note);
    return this.get(id, scope);
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.getScoped(id, scope);
    await this.db.query(`UPDATE cross_sell_opportunity SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  /* =============================================================== dashboard */

  async dashboard(scope: ResolvedScope, f: any = {}) {
    await this.reconcile();
    const w = periodWindow(f?.period, f?.from, f?.to);
    const base = (params: unknown[]) => ['o.deleted_at IS NULL', this.resolver.buildScopeWhere(scope, OPP_SCOPE_COLS, params), ...this.filterSql({ ...f, stage: undefined }, params)];
    const kpis = async (from: string | null, to: string | null) => {
      const params: unknown[] = [from, to];
      const where = base(params);
      const r = await this.db.one<any>(
        `SELECT
           COALESCE(sum(o.converted_value_minor) FILTER (WHERE o.stage = 'converted'
             AND ($1::date IS NULL OR o.converted_at >= $1::date) AND ($2::date IS NULL OR o.converted_at < $2::date)), 0) AS revenue,
           count(*) FILTER (WHERE ($1::date IS NULL OR o.created_at >= $1::date) AND ($2::date IS NULL OR o.created_at < $2::date)) AS opps,
           count(*) FILTER (WHERE o.stage = 'converted'
             AND ($1::date IS NULL OR o.converted_at >= $1::date) AND ($2::date IS NULL OR o.converted_at < $2::date)) AS converted,
           COALESCE(avg(o.value_minor) FILTER (WHERE ($1::date IS NULL OR o.created_at >= $1::date) AND ($2::date IS NULL OR o.created_at < $2::date)), 0) AS avg_value,
           COALESCE(sum(o.value_minor) FILTER (WHERE o.stage = ANY($${params.length + 1}::text[])), 0) AS pipeline
         FROM cross_sell_opportunity o JOIN lead l ON l.id = o.lead_id
        WHERE ${where.join(' AND ')}`, [...params, OPEN_STAGES]);
      const opps = Number(r?.opps ?? 0); const converted = Number(r?.converted ?? 0);
      return { revenue_minor: Number(r?.revenue ?? 0), opportunities: opps, converted,
        conversion_pct: opps > 0 ? Math.round((converted * 1000) / opps) / 10 : null,
        avg_value_minor: Math.round(Number(r?.avg_value ?? 0)), pipeline_value_minor: Number(r?.pipeline ?? 0) };
    };
    const now = await kpis(w.from, w.to);
    const prev = w.prevFrom ? await kpis(w.prevFrom, w.prevTo) : null;
    const change = prev ? {
      revenue_minor: pctChange(now.revenue_minor, prev.revenue_minor), opportunities: pctChange(now.opportunities, prev.opportunities),
      converted: pctChange(now.converted, prev.converted),
      conversion_pct: now.conversion_pct != null && prev.conversion_pct != null ? Math.round((now.conversion_pct - prev.conversion_pct) * 10) / 10 : null,
      avg_value_minor: pctChange(now.avg_value_minor, prev.avg_value_minor),
    } : null;

    // revenue split by type (converted in the period); stage strip; 6-month trend
    const p2: unknown[] = [w.from, w.to];
    const w2 = base(p2);
    const byType = await this.db.query<any>(
      `SELECT o.sale_type, count(*) FILTER (WHERE o.stage = 'converted') AS converted,
              COALESCE(sum(o.converted_value_minor) FILTER (WHERE o.stage = 'converted'), 0) AS revenue,
              count(*) AS opps, COALESCE(sum(o.value_minor), 0) AS value
         FROM cross_sell_opportunity o JOIN lead l ON l.id = o.lead_id
        WHERE ${w2.join(' AND ')} AND ($1::date IS NULL OR o.created_at >= $1::date OR o.converted_at >= $1::date)
          AND ($2::date IS NULL OR o.created_at < $2::date)
        GROUP BY o.sale_type`, p2);
    const p3: unknown[] = [w.from, w.to];
    const w3 = base(p3);
    const stages = await this.db.query<any>(
      `SELECT o.stage, count(*) AS n, COALESCE(sum(o.value_minor), 0) AS value
         FROM cross_sell_opportunity o JOIN lead l ON l.id = o.lead_id
        WHERE ${w3.join(' AND ')} AND (o.stage = ANY($${p3.length + 1}::text[])
              OR (($1::date IS NULL OR o.stage_changed_at >= $1::date) AND ($2::date IS NULL OR o.stage_changed_at < $2::date)))
        GROUP BY o.stage`, [...p3, OPEN_STAGES]);
    const p4: unknown[] = [];
    const w4 = base(p4);
    const months = await this.db.query<any>(
      `WITH m AS (SELECT to_char(d, 'YYYY-MM') AS k FROM generate_series(date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') - interval '5 months',
                                                                  date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata'), '1 month') d)
       SELECT m.k AS label,
              (SELECT count(*) FROM cross_sell_opportunity o JOIN lead l ON l.id = o.lead_id
                WHERE ${w4.join(' AND ')} AND to_char(o.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = m.k) AS opportunities,
              (SELECT COALESCE(sum(o.converted_value_minor), 0) FROM cross_sell_opportunity o JOIN lead l ON l.id = o.lead_id
                WHERE ${w4.join(' AND ')} AND o.stage = 'converted' AND to_char(o.converted_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = m.k) AS revenue
         FROM m ORDER BY m.k`, p4);
    const recent = (await this.list(scope, { ...f, limit: 8, period: undefined })) as any[];
    const p5: unknown[] = [];
    const w5 = base(p5);
    const followups = await this.db.query<any>(
      `SELECT o.id AS opportunity_id, fu.id AS follow_up_id, fu.scheduled_at, l.full_name, c.name AS course_name, u.name AS owner_name
         FROM cross_sell_opportunity o
         JOIN follow_up fu ON fu.id = o.follow_up_id AND fu.status = 'pending' AND fu.deleted_at IS NULL
         JOIN lead l ON l.id = o.lead_id
         LEFT JOIN m_course c ON c.id = o.course_id
         LEFT JOIN "user" u ON u.id = o.owner_id
        WHERE ${w5.join(' AND ')} AND o.stage = ANY($${p5.length + 1}::text[])
        ORDER BY fu.scheduled_at ASC LIMIT 5`, [...p5, OPEN_STAGES]);
    const top = await this.topRecommendations(scope, { branch_ids: f?.branch_ids ?? f?.branch_id, vertical_ids: f?.vertical_ids ?? f?.vertical_id }, 3);
    return {
      period: { from: w.from, to: w.to },
      kpis: now, previous: prev, change,
      by_type: SALE_TYPES.map((t) => {
        const r = byType.find((x) => x.sale_type === t);
        return { sale_type: t, revenue_minor: Number(r?.revenue ?? 0), converted: Number(r?.converted ?? 0), opportunities: Number(r?.opps ?? 0), value_minor: Number(r?.value ?? 0) };
      }),
      stages: OPP_STAGES.map((s) => { const r = stages.find((x) => x.stage === s); return { stage: s, count: Number(r?.n ?? 0), value_minor: Number(r?.value ?? 0) }; }),
      months: months.map((m) => ({ label: m.label, opportunities: Number(m.opportunities), revenue_minor: Number(m.revenue) })),
      recent, followups, top_recommendations: top,
    };
  }

  /* =============================================================== campaigns */

  async campaigns(scope: ResolvedScope) {
    await this.reconcile();
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, OPP_SCOPE_COLS, params);
    return this.db.query<any>(
      `SELECT cp.*, c.name AS course_name, fc.name AS from_course_name, b.name AS branch_name, v.name AS vertical_name,
              u.name AS created_by_name, t.name AS template_name,
              (SELECT count(*) FROM cross_sell_opportunity o WHERE o.campaign_id = cp.id AND o.deleted_at IS NULL AND ${w}) AS opps_now,
              (SELECT count(*) FROM cross_sell_opportunity o WHERE o.campaign_id = cp.id AND o.deleted_at IS NULL AND o.stage = 'converted' AND ${w}) AS converted,
              (SELECT COALESCE(sum(o.converted_value_minor), 0) FROM cross_sell_opportunity o WHERE o.campaign_id = cp.id AND o.deleted_at IS NULL AND o.stage = 'converted' AND ${w}) AS revenue_minor
         FROM cross_sell_campaign cp
         LEFT JOIN m_course c  ON c.id = cp.course_id
         LEFT JOIN m_course fc ON fc.id = cp.from_course_id
         LEFT JOIN branch b    ON b.id = cp.branch_id
         LEFT JOIN vertical v  ON v.id = cp.vertical_id
         LEFT JOIN "user" u    ON u.id = cp.created_by
         LEFT JOIN message_template t ON t.id = cp.template_id
        WHERE cp.deleted_at IS NULL
        ORDER BY cp.created_at DESC LIMIT 200`, params);
  }

  /** Who a campaign would reach: the scoped contacts the recommendation engine pairs with the
   *  offer course (optionally only holders of `from_course_id`), minus those already in an open
   *  or converted opportunity for it. */
  async audience(scope: ResolvedScope, f: any) {
    const courseId = Number(f?.course_id);
    if (!courseId) throw new BadRequestException('Pick the course to offer.');
    const recs = await this.recommendations(scope, { branch_ids: f?.branch_id, vertical_ids: f?.vertical_id, limit: 2000 });
    const fromId = f?.from_course_id ? Number(f.from_course_id) : null;
    const rows = recs.filter((r) => r.course_id === courseId && (!fromId || r.from_course_id === fromId));
    return { count: rows.length, contacts: rows.slice(0, 500) };
  }

  /** Create + send a campaign: one opportunity per audience contact (source "campaign") and, when a
   *  template is chosen, the message through the guarded queue (opt-out / daily cap / business hours). */
  async sendCampaign(dto: any, me: { id: number }, scope: ResolvedScope) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the campaign a name.');
    const courseId = Number(dto?.course_id);
    if (!courseId) throw new BadRequestException('Pick the course to offer.');
    const aud = await this.audience(scope, dto);
    const pick = new Set(csvNums(dto?.lead_ids));
    const contacts = pick.size ? aud.contacts.filter((c: any) => pick.has(c.lead_id)) : aud.contacts;
    if (!contacts.length) throw new BadRequestException('Nobody in your access qualifies for this offer right now.');
    const saleType: SaleType = (SALE_TYPES as readonly string[]).includes(String(dto?.sale_type)) ? dto.sale_type : contacts[0].sale_type;
    const orgId = await this.orgId();
    const cp = await this.db.one<{ id: string }>(
      `INSERT INTO cross_sell_campaign (org_id, name, course_id, from_course_id, sale_type, branch_id, vertical_id, template_id,
                                        audience, status, audience_count, note, created_by, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'sent',$10,$11,$12, now()) RETURNING id`,
      [orgId, name.slice(0, 160), courseId, dto?.from_course_id ? Number(dto.from_course_id) : null, saleType,
        dto?.branch_id ? Number(dto.branch_id) : null, dto?.vertical_id ? Number(dto.vertical_id) : null,
        dto?.template_id ? Number(dto.template_id) : null, JSON.stringify({ lead_ids: contacts.map((c: any) => c.lead_id) }),
        contacts.length, dto?.note ? String(dto.note).slice(0, 1000) : null, me.id]);
    const campaignId = Number(cp!.id);
    let created = 0; let notified = 0; let skipped = 0; let failed = 0;
    for (const c of contacts) {
      try {
        await this.create({ lead_id: c.lead_id, course_id: courseId, from_course_id: c.from_course_id, sale_type: saleType,
          match_pct: c.match_pct, value_minor: c.value_minor }, me, scope, 'campaign', campaignId);
        created++;
      } catch { /* already open, or out of scope — counted as not created */ }
    }
    if (dto?.template_id) {
      // the Bulk WhatsApp / SMS / email path: same template rendering, same guardrails
      const out = await this.templates.bulk({ template_id: Number(dto.template_id), lead_ids: contacts.map((c: any) => c.lead_id) }, scope, me.id);
      notified = out.queued; skipped = out.skipped; failed = out.failed;
    }
    await this.db.query(`UPDATE cross_sell_campaign SET opportunities_count = $2, notified_count = $3, updated_at = now() WHERE id = $1`,
      [campaignId, created, notified]);
    return { id: campaignId, audience: contacts.length, opportunities: created, notified, skipped, failed };
  }

  /* ================================================================= reports */

  async reports(scope: ResolvedScope, f: any = {}) {
    await this.reconcile();
    const w = periodWindow(f?.period, f?.from, f?.to);
    const run = async (groupSql: string, labelSql: string, join = '') => {
      const params: unknown[] = [w.from, w.to];
      const where = ['o.deleted_at IS NULL', this.resolver.buildScopeWhere(scope, OPP_SCOPE_COLS, params), ...this.filterSql({ ...f, stage: undefined }, params)];
      const rows = await this.db.query<any>(
        `SELECT ${labelSql} AS label,
                count(*) AS opportunities,
                count(*) FILTER (WHERE o.stage = 'converted') AS converted,
                count(*) FILTER (WHERE o.stage = 'lost') AS lost,
                count(*) FILTER (WHERE o.stage NOT IN ('converted', 'lost')) AS open,
                COALESCE(sum(o.converted_value_minor) FILTER (WHERE o.stage = 'converted'), 0) AS revenue,
                COALESCE(sum(o.value_minor) FILTER (WHERE o.stage NOT IN ('converted', 'lost')), 0) AS pipeline
           FROM cross_sell_opportunity o JOIN lead l ON l.id = o.lead_id ${join}
          WHERE ${where.join(' AND ')} AND ($1::date IS NULL OR o.created_at >= $1::date) AND ($2::date IS NULL OR o.created_at < $2::date)
          GROUP BY ${groupSql} ORDER BY revenue DESC, opportunities DESC`, params);
      return rows.map((r) => {
        const opps = Number(r.opportunities); const conv = Number(r.converted);
        return { label: r.label ?? '—', opportunities: opps, converted: conv, lost: Number(r.lost), open: Number(r.open),
          revenue_minor: Number(r.revenue), pipeline_minor: Number(r.pipeline), conversion_pct: opps ? Math.round((conv * 1000) / opps) / 10 : null };
      });
    };
    return {
      period: { from: w.from, to: w.to },
      by_counsellor: await run('u.name', 'u.name', 'LEFT JOIN "user" u ON u.id = o.owner_id'),
      by_course: await run('c.name', 'c.name', 'LEFT JOIN m_course c ON c.id = o.course_id'),
      by_type: await run('o.sale_type', 'o.sale_type'),
      by_branch: await run('b.name', 'b.name', 'LEFT JOIN branch b ON b.id = o.branch_id'),
      by_campaign: await run(`COALESCE(cp.name, 'No campaign')`, `COALESCE(cp.name, 'No campaign')`, 'LEFT JOIN cross_sell_campaign cp ON cp.id = o.campaign_id'),
      lost_reasons: await run(`COALESCE(NULLIF(o.lost_reason, ''), '—')`, `COALESCE(NULLIF(o.lost_reason, ''), '—')`).then((r) => r.filter((x) => x.lost > 0)),
    };
  }
}
