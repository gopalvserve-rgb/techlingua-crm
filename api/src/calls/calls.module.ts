import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { StorageModule } from '../storage/storage.module';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';

@Module({
  imports: [DatabaseModule, RbacModule, StorageModule],
  controllers: [CallsController],
  providers: [CallsService],
})
export class CallsModule {}
