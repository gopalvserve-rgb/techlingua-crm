import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { QuotationService } from './quotation.service';

/**
 * THE EXPIRY SWEEP.
 *
 * A quotation whose validity date has passed is expired whether or not anyone opens the
 * screen — the Sprint-3 lesson that a status nothing sweeps is a status that lies. The
 * sweep is set-based and idempotent, so several API replicas running it concurrently is
 * harmless: the UPDATE's own WHERE is the guard, and a row already `expired` matches
 * nothing.
 *
 * Hourly is enough: validity is a DATE, so the worst case is that a quote stays "sent"
 * for up to an hour into the day it expired. A minute-level tick would be pure cost.
 */
@Injectable()
export class QuotationExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('QuotationExpiry');
  private timer?: NodeJS.Timeout;
  static readonly INTERVAL_MS = 60 * 60 * 1000;

  constructor(private readonly quotations: QuotationService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.DISABLE_WORKERS === '1') return;
    // a boot pass, so a redeploy after a weekend does not wait an hour to tell the truth
    setTimeout(() => void this.tick(), 20_000).unref?.();
    this.timer = setInterval(() => void this.tick(), QuotationExpiryWorker.INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    try { await this.quotations.sweepExpired(); }
    catch (e) { this.log.warn(`expiry sweep failed: ${(e as Error).message}`); }
  }
}
