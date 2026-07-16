import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { FeeController } from './fee.controller';
import { FeeService } from './fee.service';

@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [FeeController],
  providers: [FeeService],
  exports: [FeeService],
})
export class FeesModule {}
