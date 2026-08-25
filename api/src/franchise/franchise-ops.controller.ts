import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { RoyaltyInvoiceService } from './royalty-invoice.service';
import { AgreementService } from './agreement.service';
import { OnboardingService, TerritoryService } from './franchise-lifecycle.service';
import { FranchiseAccessService } from './franchise-access.service';

type Me = { id: number };
const str = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);
const int = (v?: string | string[]) => { const n = Number(str(v)); return Number.isFinite(n) ? n : 0; };

/**
 * FRANCHISE OPS & LIFECYCLE (Phase 4 Batch 2). Royalty invoices + collection +
 * outstanding ageing + reports (royalty.*), franchise agreements & renewals,
 * onboarding checklist and territory mapping (franchise.*). Admin-only in this batch.
 */
@Controller()
export class FranchiseOpsController {
  constructor(
    private readonly invoices: RoyaltyInvoiceService,
    private readonly agreements: AgreementService,
    private readonly onboarding: OnboardingService,
    private readonly territory: TerritoryService,
    private readonly access: FranchiseAccessService,
  ) {}

  /** Filter a list of {franchise_id} rows to an owner's own franchises (admins: unchanged). */
  private async ownerFilter<T extends { franchise_id?: number }>(userId: number, rows: T[]): Promise<T[]> {
    const c = await this.access.listConstraint(userId);
    return c ? rows.filter((r) => r.franchise_id != null && c.includes(Number(r.franchise_id))) : rows;
  }

  // ------------------------------------------------------- royalty invoices
  @Get('royalty-invoices')
  @RequirePermission('royalty.read')
  async invList(@Query() q: Record<string, string | string[]>, @CurrentUser() me: Me) {
    if (q.franchise_id) await this.access.assertCanAccess(me.id, int(q.franchise_id));
    return this.ownerFilter(me.id, await this.invoices.list(q.franchise_id ? int(q.franchise_id) : undefined, str(q.status)));
  }

  @Get('royalty-invoices/outstanding')
  @RequirePermission('royalty.read')
  async invOutstanding(@Query() q: Record<string, string | string[]>, @CurrentUser() me: Me) {
    if (q.franchise_id) await this.access.assertCanAccess(me.id, int(q.franchise_id));
    const res: any = await this.invoices.outstanding(q.franchise_id ? int(q.franchise_id) : undefined);
    if (Array.isArray(res)) return this.ownerFilter(me.id, res);
    if (res && Array.isArray(res.rows)) return { ...res, rows: await this.ownerFilter(me.id, res.rows) };
    return res;
  }

  @Get('royalty-invoices/:id')
  @RequirePermission('royalty.read')
  async invGet(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    const inv: any = await this.invoices.get(id);
    if (inv?.franchise_id != null) await this.access.assertCanAccess(me.id, Number(inv.franchise_id));
    return inv;
  }

  @Post('royalty-invoices/from-statement')
  @RequirePermission('royalty.manage')
  invCreate(@Body() dto: any, @CurrentUser() me: Me) { return this.invoices.createFromStatement(dto, me); }

  @Post('royalty-invoices/:id/status')
  @RequirePermission('royalty.manage')
  invStatus(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) {
    return this.invoices.setStatus(id, String(dto?.status), me);
  }

  @Post('royalty-invoices/:id/payments')
  @RequirePermission('royalty.manage')
  invPay(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) {
    return this.invoices.addPayment(id, dto, me);
  }

  @Delete('royalty-invoices/:id/payments/:paymentId')
  @RequirePermission('royalty.manage')
  invPayDel(@Param('id', ParseIntPipe) id: number, @Param('paymentId', ParseIntPipe) pid: number, @CurrentUser() me: Me) {
    return this.invoices.removePayment(id, pid, me);
  }

  @Delete('royalty-invoices/:id')
  @RequirePermission('royalty.manage')
  invRemove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.invoices.remove(id, me); }

  // ------------------------------------------------------- franchise reports
  @Get('franchise-reports')
  @RequirePermission('franchise.read')
  async reports(@Query() q: Record<string, string | string[]>, @CurrentUser() me: Me) {
    const res: any = await this.invoices.reports({ from: str(q.from), to: str(q.to) });
    if (Array.isArray(res)) return this.ownerFilter(me.id, res);
    if (res && Array.isArray(res.rows)) return { ...res, rows: await this.ownerFilter(me.id, res.rows) };
    return res;
  }

  // ------------------------------------------------------- agreements
  @Get('franchise-agreements')
  @RequirePermission('franchise.read')
  async agrList(@Query() q: Record<string, string | string[]>, @CurrentUser() me: Me) {
    if (q.franchise_id) await this.access.assertCanAccess(me.id, int(q.franchise_id));
    return this.ownerFilter(me.id, await this.agreements.list(q.franchise_id ? int(q.franchise_id) : undefined, str(q.status)));
  }

  @Get('franchise-agreements/expiring')
  @RequirePermission('franchise.read')
  async agrExpiring(@Query() q: Record<string, string | string[]>, @CurrentUser() me: Me) {
    return this.ownerFilter(me.id, await this.agreements.expiring(q.days ? int(q.days) : 60));
  }

  @Post('franchise-agreements/upload-url')
  @RequirePermission('franchise.update')
  agrUploadUrl(@Body() dto: any) { return this.agreements.uploadUrl(dto); }

  @Get('franchise-agreements/:id')
  @RequirePermission('franchise.read')
  async agrGet(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    const a: any = await this.agreements.get(id);
    if (a?.franchise_id != null) await this.access.assertCanAccess(me.id, Number(a.franchise_id));
    return a;
  }

  @Post('franchise-agreements')
  @RequirePermission('franchise.update')
  agrSave(@Body() dto: any, @CurrentUser() me: Me) { return this.agreements.save(dto, me); }

  @Delete('franchise-agreements/:id')
  @RequirePermission('franchise.update')
  agrRemove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.agreements.remove(id, me); }

  // ------------------------------------------------------- onboarding
  @Get('franchises/:id/onboarding')
  @RequirePermission('franchise.read')
  async obList(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    await this.access.assertCanAccess(me.id, id);
    return this.onboarding.list(id);
  }

  @Post('franchises/:id/onboarding/steps')
  @RequirePermission('franchise.update')
  obAdd(@Param('id', ParseIntPipe) id: number, @Body() dto: any) { return this.onboarding.addStep(id, String(dto?.title)); }

  @Post('franchises/:id/onboarding/:stepId/toggle')
  @RequirePermission('franchise.update')
  obToggle(@Param('id', ParseIntPipe) id: number, @Param('stepId', ParseIntPipe) stepId: number, @Body() dto: any, @CurrentUser() me: Me) {
    return this.onboarding.toggle(id, stepId, dto?.done !== false, me);
  }

  @Delete('franchises/:id/onboarding/steps/:stepId')
  @RequirePermission('franchise.update')
  obRemove(@Param('id', ParseIntPipe) id: number, @Param('stepId', ParseIntPipe) stepId: number) {
    return this.onboarding.removeStep(id, stepId);
  }

  // ------------------------------------------------------- territory
  @Get('franchises/:id/territory')
  @RequirePermission('franchise.read')
  async terList(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    await this.access.assertCanAccess(me.id, id);
    return this.territory.list(id);
  }

  @Post('franchises/:id/territory')
  @RequirePermission('franchise.update')
  terAdd(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) { return this.territory.add(id, dto, me); }

  @Delete('franchises/:id/territory/:territoryId')
  @RequirePermission('franchise.update')
  terRemove(@Param('id', ParseIntPipe) id: number, @Param('territoryId', ParseIntPipe) tid: number) {
    return this.territory.remove(id, tid);
  }
}
