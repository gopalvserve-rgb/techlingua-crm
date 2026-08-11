import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { PdfAssetService } from './pdf-asset.service';
import { ChannelConfigService } from '../messaging/channel-config.service';

/**
 * THE R2 STORAGE LAYER (docs/dev/57) — used by everything that stores a file/asset.
 *
 * Global so any feature module (admissions, learning, invoices, quotations, fees, refunds,
 * operations) can inject StorageService / PdfAssetService without re-importing. It brings its
 * own ChannelConfigService provider so it can read the encrypted `storage`/`cloudflare`
 * credential row (same class MessagingModule exports; a fresh provider instance is stateless).
 */
@Global()
@Module({
  providers: [StorageService, PdfAssetService, ChannelConfigService],
  exports: [StorageService, PdfAssetService],
})
export class StorageModule {}
