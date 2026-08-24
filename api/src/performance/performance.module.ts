import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';
import { TargetService } from './target.service';
import { TargetDefService } from './target-def.service';
import { IncentiveService } from './incentive.service';

@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [PerformanceController],
  providers: [PerformanceService, TargetService, TargetDefService, IncentiveService],
  exports: [PerformanceService, TargetService, TargetDefService, IncentiveService],
})
export class PerformanceModule {}
