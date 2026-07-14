import { Module } from '@nestjs/common';
import { LeadIngestionService } from './lead-ingestion.service';
import { LeadMergeService } from './merge.service';
import { ImportService } from './import.service';
import { ImportController } from './import.controller';
import { ImportWorker } from './import.worker';
import { ChannelService } from './channels/channel.service';
import { ChannelController } from './channels/channel.controller';
import { WebhookController } from './channels/webhook.controller';
import { WebhookService } from './channels/webhook.service';
import { SheetWorker } from './channels/sheet.worker';

/**
 * The shared lead-ingestion pipeline and EVERY capture channel that feeds it:
 *   · bulk CSV import            (ImportController + ImportWorker)
 *   · Meta Lead Ads webhook      \
 *   · Google Ads lead form       |  WebhookController (public, signature-verified)
 *   · website form endpoint      /
 *   · Google Sheet pull          (SheetWorker, scheduled)
 *
 * They all call LeadIngestionService.ingest() and therefore inherit idempotency,
 * the NeoDove duplicate rules, campaign distribution and audit for free. Adding
 * JustDial / IndiaMART later = one entry in channels/providers.ts.
 */
@Module({
  controllers: [ImportController, ChannelController, WebhookController],
  providers: [
    LeadIngestionService, LeadMergeService, ImportService, ImportWorker,
    ChannelService, WebhookService, SheetWorker,
  ],
  exports: [LeadIngestionService, LeadMergeService, ChannelService],
})
export class IngestionModule {}
