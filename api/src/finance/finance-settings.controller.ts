import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { FinanceSettingsService } from './finance-settings.service';

interface Me { id: number; name: string; email?: string }

/**
 * ADMINISTRATION › SETTINGS › FINANCE — discount / scholarship / capping-limit config.
 *
 *   GET  /finance/settings            (finance.read)   — every scope's caps + verticals.
 *   GET  /finance/settings/effective  (finance.read)   — the resolved caps for a scope.
 *   POST /finance/settings            (finance.manage) — CHANGE a scope's caps. Only the
 *                                                        permitted user reaches this.
 *
 * Applying a discount within the cap is guarded elsewhere (quotation.create / enrolment.
 * create call FinanceSettingsService.guardFor); exceeding it needs `finance.override`.
 */
@Controller('finance/settings')
export class FinanceSettingsController {
  constructor(private readonly svc: FinanceSettingsService) {}

  @Get()
  @RequirePermission('finance.read')
  all() {
    return this.svc.list();
  }

  @Get('effective')
  @RequirePermission('finance.read')
  effective(@Query('vertical_id') verticalId?: string) {
    return this.svc.effectiveForApi(verticalId ? Number(verticalId) : null);
  }

  @Post()
  @RequirePermission('finance.manage')
  save(@Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.save(dto, Number(me.id));
  }
}
