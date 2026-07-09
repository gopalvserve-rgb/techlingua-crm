import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';

/**
 * Global exception filter (QA DEF-3): translates Postgres constraint violations
 * into readable 4xx responses instead of opaque 500s.
 *
 *   23505 unique_violation      -> 409 Conflict   ("Duplicate value: code 'PUN' already exists")
 *   23503 foreign_key_violation -> 400 Bad Request ("Invalid reference: parent_id '999' does not exist")
 *   23514 check_violation       -> 400 Bad Request ("Invalid value: violates <constraint>")
 *   23502 not_null_violation    -> 400 Bad Request
 *   22P02 invalid_text_repr     -> 400 Bad Request
 *
 * HttpExceptions pass through unchanged; anything else stays a logged 500.
 */

interface PgError {
  code?: string;
  detail?: string;
  constraint?: string;
  column?: string;
  table?: string;
  message?: string;
  stack?: string;
}

@Catch()
export class PgExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      return res.status(status).json(
        typeof body === 'string' ? { statusCode: status, message: body } : body,
      );
    }

    const pg = exception as PgError;
    const mapped = pg?.code ? this.mapPg(pg) : null;
    if (mapped) {
      return res.status(mapped.status).json({
        statusCode: mapped.status, error: mapped.error, message: mapped.message,
      });
    }

    this.logger.error(
      `Unhandled exception: ${(exception as Error)?.message ?? exception}`,
      (exception as Error)?.stack,
    );
    return res.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }

  private mapPg(e: PgError): { status: number; error: string; message: string } | null {
    // Postgres details look like: Key (code)=(PUN) already exists. / ... is not present in table "state".
    const kv = /Key \((.+?)\)=\((.+?)\)/.exec(e.detail ?? '');
    switch (e.code) {
      case '23505':
        return {
          status: 409, error: 'Conflict',
          message: kv
            ? `Duplicate value: ${kv[1]} '${kv[2]}' already exists`
            : `Duplicate value violates unique constraint${e.constraint ? ` (${e.constraint})` : ''}`,
        };
      case '23503':
        return {
          status: 400, error: 'Bad Request',
          message: kv
            ? `Invalid reference: ${kv[1]} '${kv[2]}' does not exist${e.table ? ` (table ${e.table})` : ''}`
            : 'Invalid reference: related record does not exist',
        };
      case '23514':
        return {
          status: 400, error: 'Bad Request',
          message: `Invalid value${e.constraint ? `: violates ${e.constraint}` : ' (check constraint violated)'}`,
        };
      case '23502':
        return {
          status: 400, error: 'Bad Request',
          message: `Missing required value${e.column ? ` for '${e.column}'` : ''}`,
        };
      case '22P02':
        return { status: 400, error: 'Bad Request', message: 'Invalid value format' };
      default:
        return null;
    }
  }
}
