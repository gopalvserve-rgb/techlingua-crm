import { Controller, Get, Query } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RequirePermission } from '../rbac/rbac.decorators';
import { assertDateRange } from '../common/date.util';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @RequirePermission('audit.read')
  list(
    @Query('entity_type') entityType?: string,
    @Query('entity_id') entityId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const params: unknown[] = [];
    const where: string[] = ['1=1'];
    if (entityType) { params.push(entityType); where.push(`a.entity_type = $${params.length}`); }
    if (entityId) { params.push(Number(entityId)); where.push(`a.entity_id = $${params.length}`); }
    // Shared date range on when the action OCCURRED. Bad date -> 400; either bound optional.
    const dr = assertDateRange(from, to);
    if (dr.from) { params.push(dr.from); where.push(`a.occurred_at::date >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`a.occurred_at::date <= $${params.length}::date`); }
    params.push(Math.min(Number(limit) || 100, 500));
    return this.db.query(
      `SELECT a.*
         FROM audit_log a
        WHERE ${where.join(' AND ')}
        ORDER BY a.occurred_at DESC
        LIMIT $${params.length}`,
      params,
    );
  }
}
