import {
  Body, Controller, Delete, Get, Headers, Param, ParseIntPipe, Post, Query, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentScope, CurrentUser, Public, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';
import { MessagingService } from './messaging.service';
import { ChannelConfigService } from './channel-config.service';
import { TemplateService } from '../templates/template.service';
import { verifyMetaSignature } from './transports';

interface Me { id: number; name: string }

/**
 * The send log, ad-hoc/bulk sending and the opt-out list.
 * EVERY route carries @RequirePermission — `sprint4-rbac.spec.ts` fails the build otherwise.
 */
@Controller('messages')
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly templates: TemplateService,
    private readonly configs: ChannelConfigService,
  ) {}

  /** The durable send log — who / what / when / status / provider response / failure reason. */
  @Get()
  @RequirePermission('message.read')
  list(
    @CurrentScope() scope: ResolvedScope,
    @CurrentUser() me: Me,
    @Query('channel') channel?: string,
    @Query('status') status?: string,
    @Query('lead_id') leadId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messaging.list(scope, Number(me.id), {
      channel, status, lead_id: leadId ? Number(leadId) : undefined, limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('summary')
  @RequirePermission('message.read')
  summary(@CurrentScope() scope: ResolvedScope) {
    return this.messaging.summary(scope);
  }

  /**
   * Send one message now (the lead sheet's Send button, and Settings' "Send test").
   * Degrades to a clean 503 when the channel has no credentials — never a 500, never an
   * Error-Log row.
   */
  @Post('send')
  @RequirePermission('message.send')
  async send(@Body() dto: any, @CurrentUser() me: Me) {
    const built = await this.templates.build(dto);
    return this.messaging.sendNow({ ...built, actor_id: Number(me.id), guarded: false });
  }

  /** Bulk blast: a template + an audience filter -> N queued rows. */
  @Post('bulk')
  @RequirePermission('message.send')
  async bulk(@Body() dto: any, @CurrentScope() scope: ResolvedScope, @CurrentUser() me: Me) {
    return this.templates.bulk(dto, scope, Number(me.id));
  }

  /** Re-queue one failed message (after the client pastes the missing credential). */
  @Post(':id/retry')
  @RequirePermission('message.manage')
  retry(@Param('id', ParseIntPipe) id: number) {
    return this.templates.retry(id);
  }

  @Get('opt-outs')
  @RequirePermission('message.read')
  optOuts(@Query('limit') limit?: string) {
    return this.messaging.optOuts(limit ? Number(limit) : undefined);
  }

  @Post('opt-out')
  @RequirePermission('message.manage')
  optOut(@Body() dto: any, @CurrentUser() me: Me) {
    return this.messaging.optOut(dto, Number(me.id));
  }

  @Delete('opt-out/:id')
  @RequirePermission('message.manage')
  optIn(@Param('id', ParseIntPipe) id: number) {
    return this.messaging.optIn(id);
  }
}

/**
 * THE WHATSAPP DELIVERY WEBHOOK — public by necessity (Meta calls it), and therefore
 * verified exactly like the Sprint-2 lead-ads webhook:
 *   GET  -> hub.challenge handshake against the verify token WE generated
 *   POST -> X-Hub-Signature-256 HMAC over the RAW body, using the app secret
 *
 * It does two jobs:
 *   1. delivery/read receipts   -> message_log.status = delivered | read | failed
 *   2. inbound "STOP" / "UNSUBSCRIBE" -> an opt_out row. Consent has to be honoured on the
 *      channel the customer used, not on a form he will never find.
 */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(
    private readonly db: DatabaseService,
    private readonly configs: ChannelConfigService,
    private readonly messaging: MessagingService,
  ) {}

  private static readonly STOP = /^\s*(stop|unsubscribe|opt\s*out|band karo|band kro)\s*$/i;

  @Get()
  @Public()
  async verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const cfg = await this.configs.resolve('whatsapp', null);
    const expected = cfg?.secrets?.verify_token;
    if (mode === 'subscribe' && expected && token === expected) {
      res.status(200).type('text/plain').send(String(challenge ?? ''));
      return;
    }
    res.status(403).type('text/plain').send('forbidden');
  }

  @Post()
  @Public()
  async receive(@Req() req: Request, @Headers('x-hub-signature-256') sig: string, @Body() body: any, @Res() res: Response) {
    // ALWAYS 200 to Meta — a non-200 makes Meta retry for hours and then disable the
    // subscription. We accept, then decide privately whether to trust it.
    res.status(200).json({ received: true });

    try {
      const cfg = await this.configs.resolve('whatsapp', null);
      const appSecret = cfg?.secrets?.app_secret;
      const raw = (req as Request & { rawBody?: Buffer }).rawBody;
      // If an app secret is configured we REQUIRE a valid signature; an unsigned payload
      // is an impostor, not a message.
      if (appSecret && !verifyMetaSignature(raw ?? JSON.stringify(body ?? {}), sig, appSecret)) return;

      for (const entry of body?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          const value = change?.value ?? {};

          // 1) delivery / read receipts
          for (const st of value.statuses ?? []) {
            const id = st?.id;
            const status = String(st?.status ?? '');
            if (!id) continue;
            const map: Record<string, string> = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
            const next = map[status];
            if (!next) continue;
            await this.db.query(
              `UPDATE message_log
                  SET status = $2,
                      delivered_at = CASE WHEN $2 IN ('delivered','read') THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
                      error = CASE WHEN $2 = 'failed' THEN $3 ELSE error END,
                      provider_response = provider_response || $4::jsonb,
                      updated_at = now()
                WHERE provider_message_id = $1
                  -- never walk a status BACKWARDS: receipts can arrive out of order
                  AND status NOT IN ('read')
                  AND NOT (status = 'delivered' AND $2 = 'sent')`,
              [String(id), next, st?.errors?.[0]?.title ?? null, JSON.stringify({ status: st })],
            );
          }

          // 2) inbound messages — STOP means STOP
          for (const m of value.messages ?? []) {
            const from = m?.from ? `+${String(m.from).replace(/^\+/, '')}` : null;
            const text = m?.text?.body ?? m?.button?.text ?? '';
            if (!from) continue;
            if (WhatsAppWebhookController.STOP.test(String(text))) {
              const lead = await this.db.one<{ id: string }>(
                `SELECT id FROM lead WHERE phone = $1 OR whatsapp_phone = $1 ORDER BY id LIMIT 1`, [from],
              );
              await this.messaging.optOut({
                channel: 'whatsapp', identifier: from,
                lead_id: lead ? Number(lead.id) : null,
                reason: `Replied "${String(text).slice(0, 40)}" on WhatsApp`,
                source: 'inbound',
              });
            }
          }
        }
      }
    } catch {
      // a malformed webhook must never take the API down, and Meta has already had its 200
    }
  }
}
