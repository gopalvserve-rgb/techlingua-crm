import { Module } from '@nestjs/common';
import { HierarchyController } from './hierarchy.controller';
import { HierarchyService } from './hierarchy.service';
import { StorageService } from '../storage/storage.service';

@Module({
  controllers: [HierarchyController],
  providers: [HierarchyService],
})
export class HierarchyModule {}
