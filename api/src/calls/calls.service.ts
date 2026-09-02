import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { ScopeColumnMap } from '../rbac/rbac.types';
import { StorageService } from '../storage/storage.service';

interface Me { id: number; name: string }

/** call_event scope map: OWN = the calling user's own device rows (matched or not);
 *  branch/vertical/etc. narrow by the LINKED lead. Unmatched calls stay visible to the
 *  owner + to 'all' admins, never leaking into another branch. */
const CALL_SCOPE_COLS: ScopeColumnMap = {
  owner: 'ce.user_id', team: 'l.team_id', branch: 'l.branch_id',
  vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
};

const csvStrs = (v: unknown): string[] => v == null ? []
  : (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
const csvNums = (v: unknown): number[] => [...new Set(csvStrs(v).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

/** last-10-digits normaliser (India mobile). '' when < 4 usable digits. */
function norm(phone: unknown): string {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length < 4) return '';
  return d.length > 10 ? d.slice(-10) : d;
}

const isNotConfigured = (e: unknown) =>
  e instanceof Error && /not configured/i.test(e.message);

/**
 * CALL PIPELINE (Call-Tracking Blueprint). Three isolated sources write into call_event;
 * the phone's own call log is the single source of truth, live events are a fast preview
 * corrected later. `src`: NULL live | calllog (authoritative) | calllog-fix | live-dup (hidden).
 * Recordings are read from the OEM dialer's files and stored in R2. RBAC-scoped in SQL.
 */
@Injectable()
export class CallsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly storage: StorageService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private scopeWhere(scope: ResolvedScope, params: unknown[]): string {
    return this.resolver.buildScopeWhere(scope, CALL_SCOPE_COLS, params);
  }

  /** Best lead match for a normalised phone (most recently created, not deleted). */
  private async matchLead(orgId: number, phone10: string): Promise<number | null> {
    if (!phone10) return null;
    const r = await this.db.one<{ id: string }>(
      `SELECT id FROM lead
        WHERE org_id = $1 AND deleted_at IS NULL
          AND (right(regexp_replace(coalesce(phone,''),        '\\D','','g'), 10) = $2
            OR right(regexp_replace(coalesce(alt_phone,''),     '\\D','','g'), 10) = $2
            OR right(regexp_replace(coalesce(whatsapp_phone,''),'\\D','','g'), 10) = $2)
        ORDER BY created_at DESC LIMIT 1`,
      [orgId, phone10]);
    return r ? Number(r.id) : null;
  }

  // ------------------------------------------------------------------ reads

  /** Dispositions (for the log-disposition control + filters). */
  async meta() {
    const orgId = await this.orgId();
    const dispositions = await this.db.query(
      `SELECT id, name FROM m_call_disposition WHERE org_id=$1 AND is_active AND deleted_at IS NULL ORDER BY sort_order, name`,
      [orgId]);
    return { dispositions };
  }

  /** RBAC-scoped call list/report. Hides live-dup + bare live rows superseded by the log. */
  async list(scope: ResolvedScope, q: any) {
    const params: unknown[] = [];
    const scopeSql = this.scopeWhere(scope, params);
    const where: string[] = [scopeSql, `ce.src IS DISTINCT FROM 'live-dup'`];

    if (q.lead_id && Number(q.lead_id) > 0) { params.push(Number(q.lead_id)); where.push(`ce.lead_id = $${params.length}`); }
    const dirs = csvStrs(q.direction).filter((d) => ['in', 'out', 'missed', 'unknown'].includes(d));
    if (dirs.length) { params.push(dirs); where.push(`ce.direction = ANY($${params.length}::text[])`); }
    const users = csvNums(q.user_ids ?? q.user_id);
    if (users.length) { params.push(users); where.push(`ce.user_id = ANY($${params.length}::bigint[])`); }
    if (q.has_recording === 'true' || q.has_recording === true) where.push(`ce.recording_id IS NOT NULL`);
    const qs = String(q.q ?? '').trim();
    if (qs) {
      params.push(`%${qs}%`); const a = params.length;
      params.push(`%${qs.replace(/\D/g, '')}%`); const b = params.length;
      where.push(`(coalesce(le.full_name,'') ILIKE $${a} OR regexp_replace(ce.phone_number,'\\D','','g') ILIKE $${b})`);
    }
    if (q.from) { params.push(q.from); where.push(`ce.created_at >= $${params.length}::timestamptz`); }
    if (q.to)   { params.push(q.to);   where.push(`ce.created_at < ($${params.length}::timestamptz + interval '1 day')`); }

    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000);
    const rows = await this.db.query(
      `SELECT ce.id, ce.lead_id, ce.user_id, ce.phone_number, ce.phone_raw,
              ce.direction, ce.event, ce.duration_s, ce.call_start_at, ce.created_at,
              ce.sim_slot, ce.sim_label, ce.src, ce.recording_id, ce.note,
              ce.disposition_id, d.name AS disposition_name,
              le.full_name AS lead_name, le.branch_id, le.vertical_id,
              u.name AS user_name,
              r.duration_s AS rec_duration_s, r.file_name AS rec_file_name
         FROM call_event ce
         LEFT JOIN lead l  ON l.id = ce.lead_id
         LEFT JOIN lead le ON le.id = ce.lead_id
         LEFT JOIN "user" u ON u.id = ce.user_id
         LEFT JOIN m_call_disposition d ON d.id = ce.disposition_id
         LEFT JOIN lead_recording r ON r.id = ce.recording_id
        WHERE ${where.join(' AND ')}
        ORDER BY coalesce(ce.call_start_at, ce.created_at) DESC
        LIMIT ${limit}`,
      params);
    return { rows };
  }

  /** Small KPI block for the Calls screen header. */
  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const scopeSql = this.scopeWhere(scope, params);
    const row = await this.db.one<any>(
      `SELECT
         count(*) FILTER (WHERE ce.created_at::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
                            AND ce.src IS DISTINCT FROM 'live-dup') AS calls_today,
         count(*) FILTER (WHERE ce.duration_s > 0 AND ce.src IS DISTINCT FROM 'live-dup') AS connected,
         coalesce(round(avg(NULLIF(ce.duration_s,0))),0) AS avg_duration,
         count(*) FILTER (WHERE ce.recording_id IS NOT NULL) AS recordings
       FROM call_event ce
       LEFT JOIN lead l ON l.id = ce.lead_id
       WHERE ${scopeSql}`,
      params);
    return {
      calls_today: Number(row?.calls_today || 0),
      connected: Number(row?.connected || 0),
      avg_duration: Number(row?.avg_duration || 0),
      recordings: Number(row?.recordings || 0),
    };
  }

  /** Call history for one lead (used by the lead Calls tab). Scoped. */
  async leadCalls(scope: ResolvedScope, leadId: number) {
    if (!leadId) throw new BadRequestException('lead_id required');
    return this.list(scope, { lead_id: leadId, limit: 500 });
  }

  // ------------------------------------------------------------------ writes

  /** Tap-to-dial: record a live dial_requested row (fast preview). src = NULL. */
  async dial(me: Me, dto: any) {
    const orgId = await this.orgId();
    const phoneRaw = String(dto?.phone ?? '').trim();
    const phone10 = norm(phoneRaw);
    if (!phone10) throw new BadRequestException('A valid phone number is required');
    let leadId: number | null = dto?.lead_id ? Number(dto.lead_id) : null;
    if (!leadId) leadId = await this.matchLead(orgId, phone10);
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO call_event (org_id, lead_id, user_id, phone_number, phone_raw, direction, event, src)
       VALUES ($1,$2,$3,$4,$5,'out','dial_requested',NULL) RETURNING id`,
      [orgId, leadId, me.id, phone10, phoneRaw.slice(0, 48)]);
    return { ok: true, id: Number(r!.id), lead_id: leadId, tel: `tel:${phoneRaw.replace(/[^0-9+]/g, '')}` };
  }

  /**
   * Call-log import (authoritative). Batch of device CallLog rows for the calling user.
   * Dedupe by (user, external_log_id); if a matching bare live row exists (same user+phone,
   * within a 3-minute window, src NULL), mark it live-dup so the log row supersedes it.
   */
  async logSync(me: Me, dto: any) {
    const orgId = await this.orgId();
    const rows = Array.isArray(dto?.rows) ? dto.rows : [];
    if (!rows.length) return { ok: true, inserted: 0, deduped: 0, superseded: 0 };
    let inserted = 0, deduped = 0, superseded = 0;

    for (const raw of rows.slice(0, 2000)) {
      const ext = raw?.external_log_id != null ? String(raw.external_log_id).slice(0, 80) : null;
      const phoneRaw = String(raw?.phone ?? '').trim();
      const phone10 = norm(phoneRaw);
      const dir = ['in', 'out', 'missed'].includes(String(raw?.direction)) ? String(raw.direction) : 'unknown';
      const dur = Math.max(0, Math.round(Number(raw?.duration_s) || 0));
      const startAt = raw?.call_start_at ? new Date(raw.call_start_at) : null;
      const simSlot = raw?.sim_slot != null ? Number(raw.sim_slot) : null;
      const simLabel = raw?.sim_label ? String(raw.sim_label).slice(0, 60) : null;
      const event = dir === 'missed' ? 'no_answer' : 'ended';

      // dedupe: same call-log row already imported for this user
      if (ext) {
        const dup = await this.db.one<{ id: string }>(
          `SELECT id FROM call_event WHERE org_id=$1 AND user_id=$2 AND external_log_id=$3 LIMIT 1`,
          [orgId, me.id, ext]);
        if (dup) { deduped++; continue; }
      }
      const leadId = await this.matchLead(orgId, phone10);

      // repair: supersede a bare live row (dial_requested / live) for the same user+phone nearby
      if (startAt) {
        const sup = await this.db.query(
          `UPDATE call_event SET src='live-dup'
            WHERE org_id=$1 AND user_id=$2 AND src IS NULL
              AND phone_number=$3
              AND created_at BETWEEN $4::timestamptz - interval '3 minutes' AND $4::timestamptz + interval '3 minutes'
            RETURNING id`,
          [orgId, me.id, phone10, startAt.toISOString()]);
        superseded += sup.length;
      }

      await this.db.query(
        `INSERT INTO call_event
           (org_id, lead_id, user_id, phone_number, phone_raw, direction, event, duration_s, call_start_at, sim_slot, sim_label, external_log_id, src)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'calllog')
         ON CONFLICT (org_id, user_id, external_log_id) WHERE external_log_id IS NOT NULL DO NOTHING`,
        [orgId, leadId, me.id, phone10, phoneRaw.slice(0, 48), dir, event, dur,
         startAt ? startAt.toISOString() : null, simSlot, simLabel, ext]);
      inserted++;
    }
    // link any recordings that arrived before their call row
    await this.relinkRecordings(orgId, me.id);
    return { ok: true, inserted, deduped, superseded };
  }

  /**
   * Recording sync: store one audio file (R2, bytea fallback), match to a lead by phone,
   * and link to the nearest call_event for the same user+phone within a 5-minute window.
   */
  async recordingUpload(me: Me, dto: any) {
    const orgId = await this.orgId();
    const phoneRaw = String(dto?.phone ?? '').trim();
    const phone10 = norm(phoneRaw);
    const b64 = String(dto?.content_base64 ?? '');
    if (!b64) throw new BadRequestException('content_base64 required');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new BadRequestException('empty audio');
    if (buf.length > 25 * 1024 * 1024) throw new BadRequestException('recording too large (>25MB)');
    const fileName = String(dto?.file_name ?? 'recording.m4a').slice(0, 200);
    const mime = String(dto?.mime ?? 'audio/mp4').slice(0, 80);
    const mtime = dto?.file_mtime ? new Date(dto.file_mtime) : null;
    const dur = dto?.duration_s != null ? Math.max(0, Math.round(Number(dto.duration_s))) : null;
    const srcHash = dto?.source_hash ? String(dto.source_hash).slice(0, 120)
      : `${me.id}:${fileName}:${mtime ? mtime.getTime() : buf.length}`;

    // dedupe on source_hash
    const dup = await this.db.one<{ id: string }>(
      `SELECT id FROM lead_recording WHERE org_id=$1 AND user_id=$2 AND source_hash=$3 LIMIT 1`,
      [orgId, me.id, srcHash]);
    if (dup) return { ok: true, id: Number(dup.id), deduped: true };

    const leadId = await this.matchLead(orgId, phone10);
    let r2Key: string | null = null;
    if (await this.storage.isConfigured()) {
      try {
        const key = `recordings/${me.id}/${Date.now()}-${fileName.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
        await this.storage.putObject(key, buf, mime);
        r2Key = key;
      } catch (e) { if (!isNotConfigured(e)) throw e; }
    }
    const rec = await this.db.one<{ id: string }>(
      `INSERT INTO lead_recording
         (org_id, lead_id, user_id, phone_number, file_name, mime, size_bytes, duration_s, file_mtime, r2_key, content, source_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [orgId, leadId, me.id, phone10, fileName, mime, buf.length, dur,
       mtime ? mtime.toISOString() : null, r2Key, r2Key ? null : buf, srcHash]);
    const recId = Number(rec!.id);

    // link to the nearest unlinked call for this user+phone (±5 min of the file mtime)
    if (mtime) {
      await this.db.query(
        `UPDATE call_event SET recording_id=$1
          WHERE id = (
            SELECT id FROM call_event
             WHERE org_id=$2 AND user_id=$3 AND phone_number=$4 AND recording_id IS NULL
               AND coalesce(call_start_at, created_at) BETWEEN $5::timestamptz - interval '5 minutes'
                                                           AND $5::timestamptz + interval '5 minutes'
             ORDER BY abs(extract(epoch FROM (coalesce(call_start_at, created_at) - $5::timestamptz))) ASC
             LIMIT 1)`,
        [recId, orgId, me.id, phone10, mtime.toISOString()]);
    }
    return { ok: true, id: recId, lead_id: leadId, stored: r2Key ? 'r2' : 'db' };
  }

  /** Sweep: attach any orphan recordings to freshly-imported calls (called after logSync). */
  private async relinkRecordings(orgId: number, userId: number) {
    await this.db.query(
      `UPDATE call_event ce SET recording_id = r.id
         FROM lead_recording r
        WHERE ce.org_id=$1 AND ce.user_id=$2 AND ce.recording_id IS NULL
          AND r.org_id=$1 AND r.user_id=$2 AND r.phone_number = ce.phone_number
          AND r.file_mtime IS NOT NULL
          AND coalesce(ce.call_start_at, ce.created_at) BETWEEN r.file_mtime - interval '5 minutes'
                                                           AND r.file_mtime + interval '5 minutes'`,
      [orgId, userId]);
  }

  /** Playback URL for a recording (presigned R2; DB-stream fallback path handled by controller). */
  async recordingUrl(scope: ResolvedScope, id: number) {
    const params: unknown[] = [id];
    const scopeSql = this.scopeWhere(scope, params);
    // visible if the recording is linked to a call the caller may see, or the caller owns it
    const rec = await this.db.one<{ r2_key: string | null; file_name: string }>(
      `SELECT r.r2_key, r.file_name FROM lead_recording r
        WHERE r.id = $1 AND EXISTS (
          SELECT 1 FROM call_event ce
           LEFT JOIN lead l ON l.id = ce.lead_id
           WHERE ce.recording_id = r.id AND (${scopeSql})
        )
        LIMIT 1`, params);
    if (!rec) throw new NotFoundException('Recording not found');
    if (rec.r2_key) {
      const url = await this.storage.presignGet(rec.r2_key, 600, rec.file_name);
      return { url, mode: 'r2' as const };
    }
    return { url: null, mode: 'db' as const };
  }

  /** Raw bytes for a DB-stored recording (fallback when R2 off). */
  async recordingBytes(id: number): Promise<{ body: Buffer; mime: string; name: string } | null> {
    const r = await this.db.one<{ content: Buffer | null; r2_key: string | null; mime: string; file_name: string }>(
      `SELECT content, r2_key, mime, file_name FROM lead_recording WHERE id=$1`, [id]);
    if (!r) return null;
    if (r.r2_key) { const o = await this.storage.getObject(r.r2_key); return { body: o.body, mime: o.contentType, name: r.file_name }; }
    if (r.content) return { body: r.content as Buffer, mime: r.mime || 'audio/mp4', name: r.file_name };
    return null;
  }

  /** Log a disposition + note against a call; also updates the lead's last-call disposition. */
  async logDisposition(me: Me, id: number, dto: any) {
    const orgId = await this.orgId();
    const dispId = dto?.disposition_id ? Number(dto.disposition_id) : null;
    const note = dto?.note != null ? String(dto.note).slice(0, 2000) : null;
    const ce = await this.db.one<{ lead_id: string | null }>(
      `UPDATE call_event SET disposition_id=$2, note=coalesce($3, note)
        WHERE id=$1 AND org_id=$4 RETURNING lead_id`, [id, dispId, note, orgId]);
    if (!ce) throw new NotFoundException('Call not found');
    if (ce.lead_id && dispId) {
      await this.db.query(
        `UPDATE lead SET last_call_disposition_id=$2, last_call_disposition_at=now() WHERE id=$1`,
        [Number(ce.lead_id), dispId]);
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ settings

  async getSettings(me: Me) {
    const orgId = await this.orgId();
    let row = await this.db.one<any>(
      `SELECT tracking_enabled, sim_slots, recording_folder, log_sync_minutes, rec_sync_minutes
         FROM call_setting WHERE org_id=$1 AND user_id=$2`, [orgId, me.id]);
    if (!row) {
      await this.db.query(`INSERT INTO call_setting (org_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [orgId, me.id]);
      row = await this.db.one<any>(
        `SELECT tracking_enabled, sim_slots, recording_folder, log_sync_minutes, rec_sync_minutes
           FROM call_setting WHERE org_id=$1 AND user_id=$2`, [orgId, me.id]);
    }
    return row;
  }

  async updateSettings(me: Me, dto: any) {
    const orgId = await this.orgId();
    const enabled = dto?.tracking_enabled != null ? !!dto.tracking_enabled : true;
    const slots = Array.isArray(dto?.sim_slots) ? dto.sim_slots.map(Number).filter((n: number) => Number.isInteger(n)) : [];
    const folder = dto?.recording_folder ? String(dto.recording_folder).slice(0, 300) : null;
    const logMin = Math.min(Math.max(Number(dto?.log_sync_minutes) || 60, 15), 24 * 60);
    const recMin = Math.min(Math.max(Number(dto?.rec_sync_minutes) || 15, 15), 24 * 60);
    await this.db.query(
      `INSERT INTO call_setting (org_id, user_id, tracking_enabled, sim_slots, recording_folder, log_sync_minutes, rec_sync_minutes, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7, now())
       ON CONFLICT (org_id, user_id) DO UPDATE SET
         tracking_enabled=EXCLUDED.tracking_enabled, sim_slots=EXCLUDED.sim_slots,
         recording_folder=EXCLUDED.recording_folder, log_sync_minutes=EXCLUDED.log_sync_minutes,
         rec_sync_minutes=EXCLUDED.rec_sync_minutes, updated_at=now()`,
      [orgId, me.id, enabled, JSON.stringify(slots), folder, logMin, recMin]);
    return this.getSettings(me);
  }
}
