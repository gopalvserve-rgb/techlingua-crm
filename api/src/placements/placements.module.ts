import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { JobOpeningService } from './job-opening.service';
import { JobOpeningController, PlacementApplicationController, StudentPlacementsController } from './job-opening.controller';

/**
 * PLACEMENT SUPPORT (client feedback #14). Staff post job openings + track applications;
 * eligible students view + apply via the student-facing controller. StorageModule is @Global so
 * StorageService (R2, JD attachment) injects without importing it here.
 */
@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [JobOpeningController, PlacementApplicationController, StudentPlacementsController],
  providers: [JobOpeningService],
  exports: [JobOpeningService],
})
export class PlacementsModule {}
