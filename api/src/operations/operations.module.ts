import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { NumberingModule } from '../numbering/numbering.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { VendorController } from './vendor.controller';
import { VendorService } from './vendor.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { AssetController } from './asset.controller';
import { AssetService } from './asset.service';
import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';

/** Phase 2 ERP Batch 5 — Operations: catalog, inventory, assets, vendors, procurement.
 *  Catalog + vendor are org-wide masters; inventory / asset / purchase_order are branch-scoped.
 *  Receiving a PO increments inventory (ProcurementService uses InventoryService). */
@Module({
  imports: [DatabaseModule, RbacModule, NumberingModule],
  controllers: [CatalogController, VendorController, InventoryController, AssetController, ProcurementController],
  providers: [CatalogService, VendorService, InventoryService, AssetService, ProcurementService],
  exports: [CatalogService, InventoryService],
})
export class OperationsModule {}
