import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { DiscountMasterService } from './discount-master.service';

interface Me { id: number; name: string }

/**
 * DISCOUNT MASTER (migration 093) — CRUD for the manageable discount caps, plus the
 * `effective` resolver the enrolment discount control calls to show the applicable cap.
 * The over-cap APPROVE / REJECT + the pending queue live on the EnrolmentController (they
 * act on an enrolment), so this controller stays a clean master.
 */
@Controller('discounts')
export class DiscountMasterController {
  constructor(private readonly svc: DiscountMasterService) {}

  @Get()
  @RequirePermission('discount.read')
  list() { return this.svc.list(); }

  /** The cap that applies for a (branch, vertical, course) — the form's hint. enrolment.read
   *  so a counsellor filling the enrolment form can see the ceiling before they exceed it. */
  @Get('effective')
  @RequirePermission('enrolment.read')
  effective(@Query() q: any) {
    const num = (v: any) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    return this.svc.effectiveForApi(
      { branch_id: num(q?.branch_id), vertical_id: num(q?.vertical_id), course_id: num(q?.course_id) },
      num(q?.base),
    );
  }

  @Post()
  @RequirePermission('discount.create')
  create(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.create(dto, Number(me.id)); }

  @Post('bulk-delete/impact')
  @RequirePermission('discount.delete')
  bulkImpact(@Body() dto: any) { return this.svc.bulkDeleteImpact(dto?.ids ?? []); }

  @Post('bulk-delete')
  @RequirePermission('discount.delete')
  bulkDelete(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.bulkDelete(dto?.ids ?? [], Number(me.id)); }

  @Patch(':id')
  @RequirePermission('discount.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.update(id, dto, Number(me.id));
  }

  @Delete(':id')
  @RequirePermission('discount.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    return this.svc.remove(id, Number(me.id));
  }
}
