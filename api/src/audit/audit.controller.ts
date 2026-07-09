import { Controller, Get, Query } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RequirePermission } from '../rbac/rbac.decorators';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @RequirePermission('audit.read')
  list(
    @Query('entity_type') entityType?: string,
    @Query('entity_id') entityId?: string,
    @Query('limit') limit?: string,
  ) {
    const params: unknown[] = [];
    const where: string[] = ['1=1'];
    if (entityType) { params.push(entityType); where.push(`a.entity_type = $${params.length}`); }
    if (entityId) { params.push(Number(entityId)); where.push(`a.entity_id = $${params.length}`); }
    params.push(Math.min(Number(limit) || 100, 500));
    return this.db.query(
      `SELECT a.*, u.name AS actor_name
         FROM audit_log a LEFT JOIN "user" u ON u.id = a.actor_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.occurred_at DESC
        LIMIT $${params.length}`,
      params,
    );
  }
}
