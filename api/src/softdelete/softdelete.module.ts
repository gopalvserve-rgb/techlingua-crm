import { Module } from '@nestjs/common';
import { SoftDeleteController } from './softdelete.controller';
import { SoftDeleteService } from './softdelete.service';

/** Soft delete with impact preview — central registry, uniform per-module routes. */
@Module({
  controllers: [SoftDeleteController],
  providers: [SoftDeleteService],
  exports: [SoftDeleteService],
})
export class SoftDeleteModule {}
