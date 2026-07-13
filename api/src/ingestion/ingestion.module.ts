import { Module } from '@nestjs/common';
import { LeadIngestionService } from './lead-ingestion.service';
import { LeadMergeService } from './merge.service';
import { ImportService } from './import.service';
import { ImportController } from './import.controller';
import { ImportWorker } from './import.worker';

/**
 * The shared lead-ingestion pipeline + the bulk CSV import channel.
 * Webhooks (Meta/Google/JustDial/IndiaMART), the website form and the
 * Google-Sheet pull are added as further controllers in this module — they all
 * call LeadIngestionService.ingest() and inherit idempotency, duplicate rules,
 * distribution and audit for free.
 */
@Module({
  controllers: [ImportController],
  providers: [LeadIngestionService, LeadMergeService, ImportService, ImportWorker],
  exports: [LeadIngestionService, LeadMergeService],
})
export class IngestionModule {}
