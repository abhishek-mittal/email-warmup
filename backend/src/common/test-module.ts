import { makePinoLoggerStub } from './pino-logger.stub';

// Built-in JS classes that are commonly referenced in test fixtures
// (`new Map()`, `new Date()`) but are obviously not services. Filter
// them out of the stub list to avoid spurious `'PinoLogger:Map'`
// providers.
const BUILT_INS = new Set([
  'Map', 'Set', 'Date', 'Error', 'Promise', 'Array', 'Object', 'String',
  'Number', 'Boolean', 'RegExp', 'Function', 'Symbol', 'WeakMap', 'WeakSet',
  'Buffer', 'URL', 'URLSearchParams', 'Headers', 'Request', 'Response',
  'Test', 'TestingModule', 'jest',
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pinoLoggerStubsFor(...names: any[]) {
  return names
    .map((c) => {
      // Resolve to a class name string. Accept either a class
      // constructor, a string identifier, or anything else (the
      // script that patches specs passes all three kinds — class refs
      // for the local service under test, the names of types/functions
      // it picked up from imports, and `db`/enums/etc. that aren't
      // actually services but the static analyser didn't filter).
      // We `.name`-extract whatever we can; if it has no name or is a
      // built-in, we skip.
      const name = typeof c === 'string' ? c : c?.name;
      if (!name || BUILT_INS.has(name)) return null;
      return { provide: `PinoLogger:${name}`, useValue: makePinoLoggerStub() };
    })
    .filter((x): x is { provide: string; useValue: any } => x !== null)
    // Always include the BetterAuthGuard logger stub. Any controller
    // that uses `@UseGuards(BetterAuthGuard)` will fail to wire up
    // otherwise, and BetterAuthGuard isn't always visible in the
    // spec's import list (the patcher script picks it up from array
    // literals like `controllers: [FooController]`, but FooController
    // is in the array, not BetterAuthGuard).
    .concat([{ provide: 'PinoLogger:BetterAuthGuard', useValue: makePinoLoggerStub() }]);
}
