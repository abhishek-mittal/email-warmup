import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Global exception filter. Nest's default handler logs the *outer* error
 * (which for Drizzle is `DrizzleQueryError` with `message: 'Failed query: ...'`
 * and the real PG error stuffed into `error.cause`). Without unwrapping
 * `cause`, the log only shows the Drizzle wrapper, which makes every
 * DB failure look identical and impossible to debug. This filter:
 *
 *   1. Unwraps `cause` recursively (Drizzle may wrap a node-postgres
 *      error which wraps the actual `DatabaseError`).
 *   2. Logs the original PG error with code/message/detail/hint so the
 *      real reason surfaces in the log.
 *   3. Returns a stable JSON shape to the client (unchanged from Nest's
 *      default for HttpException; generic 500 for everything else).
 */
@Catch()
export class UnwrapCauseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(UnwrapCauseExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const { status, body } = this.toResponse(exception);
    if (status >= 500) {
      this.logger.error(
        `[${req.method} ${req.url}] -> ${status}`,
        this.formatChain(exception),
      );
    }
    res.status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: unknown } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse();
      return {
        status,
        body: typeof resp === 'string' ? { statusCode: status, message: resp } : resp,
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      },
    };
  }

  /**
   * Walk the `cause` chain and produce a single string with each level's
   * `name` + `code` (for PG errors) + `message` on its own line. The
   * innermost error is the one the database actually returned.
   */
  private formatChain(err: unknown): string {
    const lines: string[] = [];
    let cur: unknown = err;
    let i = 0;
    while (cur && i < 10) {
      const e = cur as { name?: string; code?: string; message?: string };
      const prefix = '  '.repeat(i);
      const code = e.code ? ` [code=${e.code}]` : '';
      lines.push(`${prefix}${e.name ?? 'Error'}${code}: ${e.message ?? String(cur)}`);
      const cause = (cur as { cause?: unknown }).cause;
      if (!cause || cause === cur) break;
      cur = cause;
      i++;
    }
    return lines.join('\n');
  }
}
