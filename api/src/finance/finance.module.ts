import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FinanceSettingsController } from './finance-settings.controller';
import { FinanceSettingsService } from './finance-settings.service';
import { FinanceDashboardController } from './finance-dashboard.controller';
import { FinanceDashboardService } from './finance-dashboard.service';

/**
 * FINANCE — the discount/scholarship/capping-limit settings and the enforcer. The service
 * is EXPORTED so QuotationsModule and EnrolmentsModule can run a discount through the cap
 * at the point it is applied. RbacDataService is @Global (RbacModule), so the override
 * check needs no extra import here.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [FinanceSettingsController, FinanceDashboardController],
  providers: [FinanceSettingsService, FinanceDashboardService],
  exports: [FinanceSettingsService, FinanceDashboardService],
})
export class FinanceModule {}
