import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { safeEqual } from '../../common/crypto.util';
import { ChannelService, ChannelRow } from './channel.service';
import { WebhookService } from './webhook.service';

/**
 * ROUTING MANIFEST (SmartCRM integration spec v1, Nov 2026).
 *
 * Every Facebook page on the shared Meta app (965594974738358) delivers to SmartCRM, which forwards
 * a page's leads here only if its routing table has a row for that page. A page with no row loses
 * its leads silently (British College of Language lost 153 that way). SmartCRM polls this manifest
 * every 15 minutes and adds or retires its rows to match, so a page added here routes by itself.
 *
 * Built straight from the capture channels, so it cannot drift from what is configured:
 *   · meta_pages        — every page monitored on an active Meta channel. `ready` only when the
 *                         shared app secret is saved and the page's access token is stored.
 *                         A page monitored on two channels is listed once, under the channel
 *                         whose forms are mapped for it (else the oldest channel).
 *   · whatsapp_numbers  — the connected WhatsApp Cloud numbers; one unkeyed path takes them all.
 *
 * Paths only, never full URLs: SmartCRM builds https://<registered host><path> itself.
 * Auth: Bearer token; only its SHA-256 is stored (app_setting routing_manifest_token_sha256).
 */
@Injectable()
export class RoutingManifestService {
  constructor(
    private readonly db: DatabaseService,
    private readonly channels: ChannelService,
    private readonly hooks: WebhookService,
  ) {}

  async authorised(header: string | undefined): Promise<boolean> {
    const token = /^Bearer\s+(.+)$/i.exec(String(header ?? ''))?.[1]?.trim();
    if (!token) return false;
    const row = await this.db.one<{ value: any }>(`SELECT value FROM app_setting WHERE key = 'routing_manifest_token_sha256'`);
    const raw = row?.value;
    const want = typeof raw === 'string' ? raw : String(raw?.sha256 ?? '');
    if (!want) return false;
    return safeEqual(createHash('sha256').update(token).digest('hex'), want);
  }

  async build(destination: string) {
    const { appSecret } = await this.hooks.fbAppCreds();
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM capture_channel WHERE provider = 'meta' AND deleted_at IS NULL AND is_active ORDER BY id`);
    const mapped = await this.db.query<{ channel_id: string; page_id: string; n: string }>(
      `SELECT channel_id, page_id, count(*) AS n FROM fb_form_mapping WHERE is_enabled GROUP BY 1, 2`);
    const formsFor = (ch: number, page: string) => Number(mapped.find((m) => Number(m.channel_id) === ch && m.page_id === page)?.n ?? 0);

    const byPage = new Map<string, { page_id: string; page_name: string; webhook_path: string; ready: boolean; forms: number; ch: number }>();
    for (const r of rows) {
      const ch = await this.channels.raw(Number(r.id)) as ChannelRow;
      if (!ch) continue;
      const secrets = this.channels.secretsOf(ch);
      const pages: any[] = Array.isArray((ch.config as any)?.pages) ? (ch.config as any).pages : [];
      for (const p of pages) {
        const pageId = String(p?.page_id ?? '');
        if (!/^\d+$/.test(pageId) || p?.monitored !== true) continue;
        const entry = {
          page_id: pageId,
          page_name: String(p?.page_name ?? ''),
          webhook_path: `/api/webhooks/meta/${ch.public_key}`,
          ready: !!appSecret && !!secrets[`page_token_${pageId}`],
          forms: formsFor(Number(ch.id), pageId),
          ch: Number(ch.id),
        };
        const cur = byPage.get(pageId);
        if (!cur || entry.forms > cur.forms || (entry.forms === cur.forms && entry.ready && !cur.ready)) byPage.set(pageId, entry);
      }
    }

    const wa = await this.db.one<{ config: any }>(
      `SELECT config FROM channel_config WHERE provider = 'meta_cloud' AND deleted_at IS NULL AND is_active ORDER BY updated_at DESC LIMIT 1`);
    const numbers: any[] = Array.isArray(wa?.config?.numbers) ? wa!.config.numbers : [];
    const whatsapp_numbers = numbers
      .filter((n) => /^\d+$/.test(String(n?.phone_number_id ?? '')))
      .map((n) => ({
        phone_number_id: String(n.phone_number_id),
        display_name: String(n.verified_name ?? n.label ?? n.display_phone_number ?? ''),
        webhook_path: '/api/webhooks/whatsapp',
        ready: String(n.status ?? '').toUpperCase() === 'CONNECTED',
      }));

    return {
      destination,
      generated_at: new Date().toISOString(),
      meta_pages: [...byPage.values()].map(({ forms: _f, ch: _c, ...e }) => e),
      whatsapp_numbers,
    };
  }
}
