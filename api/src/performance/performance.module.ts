import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';
import { TargetService } from './target.service';

@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [PerformanceController],
  providers: [PerformanceService, TargetService],
  exports: [PerformanceService, TargetService],
})
export class PerformanceModule {}
