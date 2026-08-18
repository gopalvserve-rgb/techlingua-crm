import { Module } from '@nestjs/common';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { CourseLevelsService } from './course-levels.service';

@Module({
  controllers: [CoursesController],
  providers: [CoursesService, CourseLevelsService],
  exports: [CourseLevelsService],
})
export class CoursesModule {}
