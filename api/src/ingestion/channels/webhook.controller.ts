import {
  Body, Controller, Get, Header, HttpCode, Options, Param, Post, Query, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../rbac/rbac.decorators';
import { ChannelService } from './channel.service';
import { WebhookRejected, WebhookService } from './webhook.service';

/**
 * THE PUBLIC CAPTURE ENDPOINTS. These are the only routes in the product that sit
 * OUTSIDE authentication — Meta, Google and a website form cannot carry a JWT.
 *
 * What replaces auth, on every route:
 *   · an unguessable per-channel public key in the path (rotatable)
 *   · a cryptographic check: Meta X-Hub-Signature-256 (HMAC-SHA256 over the RAW
 *     body) · Google's `google_key` shared secret · the website form's origin
 *     allow-list + honeypot
 *   · a rate limit, applied before any database work
 *   · a durable `webhook_event` row for EVERY request, accepted or rejected, with
 *     the payload verbatim — so a "lost lead" is always traceable and replayable
 *
 * Status codes are chosen per provider (see WebhookService): 401 for a bad
 * signature/key (never accept unsigned), 200 once verified (so Meta/Google do not
 * retry for hours and disable the subscription — the payload is already durable).
 */
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly hooks: WebhookService, private readonly channels: ChannelService) {}

  private meta(req: Request) {
    return {
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
      origin: req.headers.origin as string | undefined,
      signature: (req.headers['x-hub-signature-256'] as string) || undefined,
      rawBody: (req as any).rawBody as Buffer | undefined,
      apiKey: (req.headers['x-webhook-key'] as string) || (req.headers['x-api-key'] as string)
        || (req.query?.key as string) || undefined,
    };
  }

  /** Meta's GET verification handshake — must echo hub.challenge as plain text. */
  @Public() @Get('meta/:key')
  async metaVerify(
    @Param('key') key: string, @Query() q: Record<string, unknown>,
    @Req() req: Request, @Res() res: Response,
  ) {
    try {
      const out = await this.hooks.metaVerify(key, q, this.meta(req));
      res.status(out.http).type('text/plain').send(String(out.body ?? ''));
    } catch (e) {
      const r = e as WebhookRejected;
      res.status(r.http ?? 403).type('text/plain').send(r.message ?? 'Verification failed');
    }
  }

  /** Meta leadgen delivery. */
  @Public() @Post('meta/:key')
  async metaReceive(@Param('key') key: string, @Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    try {
      const out = await this.hooks.metaReceive(key, body, this.meta(req));
      res.status(out.http).json(out.body);
    } catch (e) {
      const r = e as WebhookRejected;
      res.status(r.http ?? 500).json({ error: r.message ?? 'Rejected' });
    }
  }

  /** Google Ads lead form extension delivery. */
  @Public() @Post('google/:key')
  async googleReceive(@Param('key') key: string, @Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    try {
      const out = await this.hooks.googleReceive(key, body, this.meta(req));
      res.status(out.http).json(out.body);
    } catch (e) {
      const r = e as WebhookRejected;
      res.status(r.http ?? 500).json({ error: r.message ?? 'Rejected' });
    }
  }

  /**
   * CORS preflight for the website form. The global CORS middleware deliberately
   * lets /api/webhooks/form/* fall through (main.ts) so the allowed origins can be
   * read PER CHANNEL from the database, which a static config cannot do.
   */
  @Public() @Options('form/:key') @HttpCode(204)
  async formPreflight(@Param('key') key: string, @Req() req: Request, @Res() res: Response) {
    const ch = await this.channels.byPublicKey(key, 'website');
    const origin = ch ? this.hooks.allowedOrigin(ch, req.headers.origin) : null;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    res.status(204).send();
  }

  /** The website form submission endpoint (public key in the path). */
  @Public() @Post('form/:key')
  async formReceive(@Param('key') key: string, @Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    const ch = await this.channels.byPublicKey(key, 'website');
    const origin = ch ? this.hooks.allowedOrigin(ch, req.headers.origin) : null;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    try {
      const out = await this.hooks.formReceive(key, body, this.meta(req));
      res.status(out.http).json(out.body);
    } catch (e) {
      const r = e as WebhookRejected;
      res.status(r.http ?? 500).json({ ok: false, error: r.message ?? 'Rejected' });
    }
  }

  /**
   * The generic keyed inbound webhook — every marketplace (IndiaMART, JustDial,
   * TradeIndia, Housing, 99acres), Google Form and Custom/Webhook integration
   * posts here. Auth = the public key in the path (+ optional X-Webhook-Key).
   */
  @Public() @Post('push/:key')
  async pushReceive(@Param('key') key: string, @Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    try {
      const out = await this.hooks.pushReceive(key, body, this.meta(req));
      res.status(out.http).json(out.body);
    } catch (e) {
      const r = e as WebhookRejected;
      res.status(r.http ?? 500).json({ ok: false, error: r.message ?? 'Rejected' });
    }
  }

  /** A liveness probe an integrator can curl before wiring anything up. */
  @Public() @Get('health') @Header('Cache-Control', 'no-store')
  health() { return { ok: true, endpoints: ['meta/:key', 'google/:key', 'form/:key', 'push/:key'] }; }
}
