import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { TransferService } from './transfer.service';

interface Me { id: number; name: string }

/**
 * Students & Academics — batch transfer + waitlist. Reads need batch.read; mutations reuse
 * student.update (a transfer/waitlist moves the student's batch assignment). Every route is
 * scoped inside the service.
 */
@Controller('academics')
export class TransferController {
  constructor(private readonly svc: TransferService) {}

  @Get('batches/:id/roster')
  @RequirePermission('batch.read')
  roster(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.roster(id, scope);
  }

  @Post('transfer')
  @RequirePermission('student.update')
  transfer(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.transfer(dto, me, scope);
  }

  @Post('waitlist/:id/promote')
  @RequirePermission('student.update')
  promote(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.promote(id, me, scope);
  }

  @Delete('waitlist/:id')
  @RequirePermission('student.update')
  removeWaitlist(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.removeWaitlist(id, me, scope);
  }
}
