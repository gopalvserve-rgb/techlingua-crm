import { Global, Module } from '@nestjs/common';
import { ClientErrorsController, ErrorLogController } from './error-log.controller';
import { ErrorLogService } from './error-log.service';

/**
 * Global so the APP_FILTER exception filter (common/pg-exception.filter.ts)
 * can inject ErrorLogService to persist every captured 5xx / validation issue.
 */
@Global()
@Module({
  controllers: [ErrorLogController, ClientErrorsController],
  providers: [ErrorLogService],
  exports: [ErrorLogService],
})
export class ErrorLogModule {}
