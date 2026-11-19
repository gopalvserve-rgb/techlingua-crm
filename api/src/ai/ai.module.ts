import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { MessagingModule } from '../messaging/messaging.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { LlmAdapterService } from './llm-adapter.service';
import { SttAdapterService } from './stt-adapter.service';
import { CallIntelService } from './call-intel.service';
import { CallIntelController } from './call-intel.controller';

/**
 * ERP Batch 4 — AI Communication Intelligence (DeepSeek / Gemini).
 *
 * Depends on MessagingModule for ChannelConfigService (the encrypted ai key store) and on
 * RbacModule for the ScopeResolver. The LLM adapter is the single provider-facing seam;
 * everything degrades via NotConfiguredException when no key is set.
 */
@Module({
  imports: [DatabaseModule, RbacModule, MessagingModule],
  controllers: [AiController, CallIntelController],
  // 12 Nov 2026 — speech-to-text + the call intelligence pipeline (transcripts → insights)
  providers: [AiService, LlmAdapterService, SttAdapterService, CallIntelService],
  exports: [AiService, LlmAdapterService, SttAdapterService, CallIntelService],
})
export class AiModule {}
