import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from '../common/settings.service';
import { MessagingModule } from '../messaging/messaging.module';
import { ConnectionTestService } from './connection-test.service';
import { WhatsAppSignupService } from './whatsapp-signup.service';
import { ChannelConfigService } from '../messaging/channel-config.service';

/**
 * The two new services take an injectable HttpFn so the unit tests can mock Meta /
 * Razorpay / Cloudflare without a network. Nest cannot resolve a bare function
 * parameter, so they are constructed explicitly here with the real `fetch`.
 */
@Module({
  imports: [MessagingModule],
  controllers: [SettingsController],
  providers: [
    SettingsService,
    { provide: ConnectionTestService, inject: [ChannelConfigService], useFactory: (c: ChannelConfigService) => new ConnectionTestService(c) },
    { provide: WhatsAppSignupService, inject: [ChannelConfigService], useFactory: (c: ChannelConfigService) => new WhatsAppSignupService(c) },
  ],
})
export class SettingsModule {}
