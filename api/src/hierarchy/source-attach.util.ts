import { DatabaseService } from '../database/database.service';

/**
 * ORG-WIDE LEAD SOURCES (client, Oct 2026 — "lead source not showing").
 *
 * A Lead Source created without a campaign is ORG-WIDE: it must be pickable under EVERY
 * campaign. A lead, though, always carries a source OF ITS campaign (the source row holds the
 * Branch › Vertical › Pipeline › Campaign path, the ingest idempotency key and the integration
 * config). So when an org-wide source is chosen together with a campaign, the campaign gets
 * its OWN copy of that source — same canonical `m_source`, same name and channel — created
 * once and re-used after that. This is exactly what attaching a source on the Campaign screen
 * does; it now also happens implicitly the first time the source is used.
 *
 * Returns the source id to store on the lead, or null when `sourceId` belongs to a DIFFERENT
 * campaign (still an error for the caller to report) or does not exist.
 */
export async function sourceForCampaign(
  db: Pick<DatabaseService, 'one'>,
  sourceId: number, campaignId: number, actorId: number | null = null,
): Promise<number | null> {
  // the common case first: a source of THIS campaign
  const own = await db.one<{ id: string }>(
    `SELECT id FROM source WHERE id = $1 AND campaign_id = $2 AND deleted_at IS NULL`, [sourceId, campaignId]);
  if (own) return Number(own.id);
  try {
    return await orgWideCopy(db, sourceId, campaignId, actorId);
  } catch (e) {
    console.error('[source-attach] org-wide copy failed', sourceId, campaignId, (e as Error)?.message);
    return null;   // reported by the caller as "source does not belong to the campaign"
  }
}

async function orgWideCopy(db: Pick<DatabaseService, 'one'>, sourceId: number, campaignId: number, actorId: number | null): Promise<number | null> {
  const src = await db.one<any>(
    `SELECT id, org_id, campaign_id, branch_id, vertical_id, pipeline_id, name, channel, master_source_id, cost_per_lead, config
       FROM source WHERE id = $1 AND deleted_at IS NULL`, [sourceId]);
  if (!src) return null;
  if (src.campaign_id != null) return null;   // a source of ANOTHER campaign

  const camp = await db.one<any>(
    `SELECT org_id, branch_id, vertical_id, pipeline_id FROM campaign WHERE id = $1 AND deleted_at IS NULL`, [campaignId]);
  if (!camp) return null;
  // A Lead Source Master entry may be limited to a Branch › Vertical › Pipeline (Oct 2026): it is
  // usable only under campaigns on that path (a blank level means "any").
  if (!sourceFitsPath(src, camp)) return null;

  // org-wide: the campaign's own copy (by canonical master source, else by name)
  const existing = await db.one<{ id: string }>(
    `SELECT id FROM source
      WHERE campaign_id = $1 AND deleted_at IS NULL
        AND (($2::bigint IS NOT NULL AND master_source_id = $2::bigint) OR lower(name) = lower($3))
      ORDER BY is_active DESC, id ASC LIMIT 1`,
    [campaignId, src.master_source_id ?? null, String(src.name)]);
  if (existing) return Number(existing.id);

  const channel = String(src.channel ?? 'manual');
  // same rule as HierarchyService.createSource: an integration channel gets its own webhook token
  const webhookToken = ['meta', 'google', 'justdial', 'indiamart', 'form', 'webhook'].includes(channel)
    ? 'whk_' + Math.random().toString(36).slice(2, 18) : null;
  const created = await db.one<{ id: string }>(
    `INSERT INTO source (org_id, branch_id, vertical_id, pipeline_id, campaign_id, name, channel,
                         master_source_id, webhook_token, config, cost_per_lead, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::jsonb,'{}'::jsonb),COALESCE($11::numeric,0),TRUE,$12::bigint)
     RETURNING id`,
    [camp.org_id, camp.branch_id, camp.vertical_id, camp.pipeline_id, campaignId, src.name,
      channel, src.master_source_id ?? null, webhookToken, src.config ? JSON.stringify(src.config) : null,
      src.cost_per_lead ?? 0, actorId]);
  return created ? Number(created.id) : null;
}

/** Does an org-level source's (optional) Branch › Vertical › Pipeline allow this campaign's path?
 *  A blank level on the source means "any". */
export function sourceFitsPath(
  src: { branch_id?: unknown; vertical_id?: unknown; pipeline_id?: unknown },
  camp: { branch_id?: unknown; vertical_id?: unknown; pipeline_id?: unknown },
): boolean {
  const ok = (a: unknown, b: unknown) => a == null || Number(a) === Number(b);
  return ok(src.branch_id, camp.branch_id) && ok(src.vertical_id, camp.vertical_id) && ok(src.pipeline_id, camp.pipeline_id);
}
