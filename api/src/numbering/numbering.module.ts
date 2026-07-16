import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { NumberingController } from './numbering.controller';
import { NumberingService } from './numbering.service';

/** Global: quotations, enrolments and fees all allocate from it, and Phase 3 will too. */
@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [NumberingController],
  providers: [NumberingService],
  exports: [NumberingService],
})
export class NumberingModule {}
