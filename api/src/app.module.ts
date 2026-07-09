import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { RbacModule } from './rbac/rbac.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TeamsModule } from './teams/teams.module';
import { RolesModule } from './roles/roles.module';
import { AssignmentsModule } from './assignments/assignments.module';
import { HierarchyModule } from './hierarchy/hierarchy.module';
import { MastersModule } from './masters/masters.module';
import { AuditModule } from './audit/audit.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PermissionsGuard } from './rbac/permissions.guard';
import { RecordScopeGuard } from './rbac/record-scope.guard';
import { AuditInterceptor } from './common/audit.interceptor';
import { PgExceptionFilter } from './common/pg-exception.filter';

@Module({
  imports: [
    DatabaseModule,
    RbacModule,
    AuthModule,
    UsersModule,
    TeamsModule,
    RolesModule,
    AssignmentsModule,
    HierarchyModule,
    MastersModule,
    AuditModule,
  ],
  providers: [
    // guard order matters: authenticate, authorise (permission), then record scope
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // by-ID record-scope enforcement on @ScopedEntity routes (out-of-scope -> 404)
    { provide: APP_GUARD, useClass: RecordScopeGuard },
    // every successful mutation lands in audit_log
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // Postgres constraint violations -> readable 409/400 instead of 500
    { provide: APP_FILTER, useClass: PgExceptionFilter },
  ],
})
export class AppModule {}
