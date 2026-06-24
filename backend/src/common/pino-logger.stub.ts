import { PinoLogger } from 'nestjs-pino';

/**
 * Test-only stub of `PinoLogger`. Every method is a `jest.fn()` so
 * individual specs can assert on log calls (e.g. "verifies the warmup-send
 * job emitted 'warmup-send job started' with these fields"). The methods
 * also return `undefined`/`Promise<undefined>` to match the real
 * `PinoLogger` interface — the real logger returns its arguments piped
 * through pino, which the test doesn't care about.
 *
 * Usage:
 *   const logger = makePinoLoggerStub();
 *   const service = new MyService(logger, ...otherDeps);
 *   // ... call service ...
 *   expect(logger.info).toHaveBeenCalledWith({ inboxId: 'x' }, 'precheck passed');
 */
export function makePinoLoggerStub(): jest.Mocked<PinoLogger> {
  const anyMock: any = jest.fn();
  return {
    info: anyMock,
    warn: anyMock,
    error: anyMock,
    debug: anyMock,
    trace: anyMock,
    fatal: anyMock,
    silent: anyMock,
    level: anyMock,
    // PinoLogger extends Logger (mixin) — provide the standard NestJS
    // LoggerService shape so type checks pass.
    log: anyMock,
    setLogLevels: anyMock,
  } as unknown as jest.Mocked<PinoLogger>;
}
