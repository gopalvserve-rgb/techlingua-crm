import { Controller, Get, Header, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../rbac/rbac.decorators';
import { PaymentService } from './payment.service';

/**
 * THE PUBLIC RAZORPAY WEBHOOK. Like the capture-channel webhooks, this sits OUTSIDE auth
 * (a gateway cannot carry a JWT). What replaces auth: the HMAC-SHA256 over the RAW body,
 * verified with the vertical's stored webhook secret (PaymentService resolves the vertical
 * from the payment row the link/order was minted against). A bad or missing signature never
 * changes state; a replay of a captured payment is idempotent.
 *
 * ONE URL for every vertical — the client pastes it once per Razorpay account in
 * Razorpay › Settings › Webhooks, subscribing payment.captured / payment.failed /
 * payment_link.paid, and copies that webhook's secret into the vertical's Settings.
 */
@Controller('webhooks')
export class RazorpayWebhookController {
  constructor(private readonly svc: PaymentService) {}

  @Public() @Post('razorpay')
  async receive(@Req() req: Request, @Res() res: Response) {
    const signature = (req.headers['x-razorpay-signature'] as string) || undefined;
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const out = await this.svc.handleWebhook(raw, signature);
    res.status(out.http).json(out.body);
  }

  @Public() @Get('razorpay') @Header('Cache-Control', 'no-store')
  health() { return { ok: true, gateway: 'razorpay', events: ['payment.captured', 'payment.failed', 'payment_link.paid'] }; }
}
