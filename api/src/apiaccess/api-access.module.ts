import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from './api-key.guard';
import { ApiRequestLogInterceptor } from './api-request-log.interceptor';
import { ApiKeysController } from './api-keys.controller';
import { PublicApiController } from './public-api.controller';

/**
 * ADMINISTRATION › API — the Developer / API module.
 *   · ApiKeysController  (JWT + api.read/api.manage): generate/enable/disable/
 *     revoke keys, the docs, the request log.
 *   · PublicApiController (@Public + ApiKeyGuard): the key-authenticated public
 *     surface — create-lead (through IngestionModule's LeadIngestionService) and
 *     list-leads.
 *
 * The guard and interceptor are controller-scoped (declared with @UseGuards /
 * @UseInterceptors on PublicApiController), so they are ordinary providers here.
 */
@Module({
  imports: [IngestionModule],
  controllers: [ApiKeysController, PublicApiController],
  providers: [ApiKeyService, ApiKeyGuard, ApiRequestLogInterceptor],
  exports: [ApiKeyService],
})
export class ApiAccessModule {}
