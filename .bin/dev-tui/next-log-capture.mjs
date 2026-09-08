#!/usr/bin/env node
// next-log-capture.mjs — wraps `next dev` and mirrors its stdout to a
// newline-delimited JSON stream alongside the raw text. Used by
// `.bin/dev up` (Phase 1) to produce both:
//   - .bin/.runtime/frontend.log  (raw Next dev output, what humans see)
//   - .bin/.runtime/frontend.ndjson  (one parsed JSON record per line)
//
// Each NDJSON record has shape:
//   { source: "frontend", level: <pino-num>, time: <epoch-ms>, msg: <string>,
//     method?, path?, status?, durationMs?, ... }
//
// Usage:
//   node .bin/dev-tui/next-log-capture.mjs [next-args...]
//   # defaults to `next dev` if no args provided
//
// Env:
//   NEXT_LOG_FILE      override the raw log path (default .bin/.runtime/frontend.log)
//   NEXT_NDJSON_FILE   override the NDJSON path (default .bin/.runtime/frontend.ndjson)
//   NEXT_NDJSON=0      disable NDJSON output (raw log only)
//   NEXT_CAPTURE_DEBUG=1  echo every record to stderr for debugging

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNextLine } from './lib/format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const rawLogPath = process.env.NEXT_LOG_FILE
  ? path.resolve(process.cwd(), process.env.NEXT_LOG_FILE)
  : path.resolve(repoRoot, '.bin/.runtime/frontend.log');
const ndjsonPath = process.env.NEXT_NDJSON_FILE
  ? path.resolve(process.cwd(), process.env.NEXT_NDJSON_FILE)
  : path.resolve(repoRoot, '.bin/.runtime/frontend.ndjson');

fs.mkdirSync(path.dirname(rawLogPath), { recursive: true });
fs.mkdirSync(path.dirname(ndjsonPath), { recursive: true });

// Truncate on each spawn so the log file matches the lifetime of `next dev`.
const rawStream = fs.createWriteStream(rawLogPath, { flags: 'w' });
const ndjsonEnabled = process.env.NEXT_NDJSON !== '0';
const ndjsonStream = ndjsonEnabled
  ? fs.createWriteStream(ndjsonPath, { flags: 'w' })
  : null;

// Resolve `next` relative to the frontend dir so the wrapper works
// without a global `next` install. Falls back to PATH for safety.
const frontendDir = process.env.NEXT_CWD
  ? path.resolve(process.cwd(), process.env.NEXT_CWD)
  : path.resolve(repoRoot, 'frontend');
const localNext = path.join(frontendDir, 'node_modules', '.bin', 'next');
const useLocalNext = fs.existsSync(localNext);

// Pass through everything after `--`, otherwise default to `next dev`.
const args = process.argv.slice(2);
const childArgs = args.length > 0 ? args : ['dev'];
const childCmd = useLocalNext ? localNext : 'next';
const child = spawn(childCmd, childArgs, {
  cwd: frontendDir,
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env, PATH: `${path.join(frontendDir, 'node_modules', '.bin')}:${process.env.PATH ?? ''}` },
});

// Pipe stdout to both raw log and (if recognised) NDJSON parser.
let stdoutCarry = '';
child.stdout.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  rawStream.write(text);

  if (!ndjsonEnabled) return;

  stdoutCarry += text;
  let idx;
  while ((idx = stdoutCarry.indexOf('\n')) !== -1) {
    const line = stdoutCarry.slice(0, idx).replace(/\r$/, '');
    stdoutCarry = stdoutCarry.slice(idx + 1);
    if (!line) continue;
    const record = parseNextLine(line, 'frontend');
    ndjsonStream.write(JSON.stringify(record) + '\n');
    if (process.env.NEXT_CAPTURE_DEBUG === '1') {
      process.stderr.write(`[ndjson] ${JSON.stringify(record)}\n`);
    }
  }
});

// stderr goes to the raw log too (Next writes compile errors here).
child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  rawStream.write(text);

  if (!ndjsonEnabled) return;

  // Treat each stderr line as a frontend record too — Next dev puts its
  // most interesting diagnostics on stderr.
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const record = parseNextLine(line, 'frontend');
    ndjsonStream.write(JSON.stringify(record) + '\n');
    if (process.env.NEXT_CAPTURE_DEBUG === '1') {
      process.stderr.write(`[ndjson] ${JSON.stringify(record)}\n`);
    }
  }
});

// On exit, flush pending carry (in case the last line had no newline).
function flush() {
  if (!ndjsonEnabled) return;
  if (stdoutCarry.length > 0) {
    const record = parseNextLine(stdoutCarry, 'frontend');
    ndjsonStream.write(JSON.stringify(record) + '\n');
    stdoutCarry = '';
  }
  ndjsonStream.end();
  rawStream.end();
}

child.on('exit', (code, signal) => {
  flush();
  // Give the streams a tick to flush before we exit.
  setImmediate(() => process.exit(code ?? (signal ? 1 : 0)));
});

// Mirror Ctrl+C / SIGTERM from parent to child.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { child.kill(sig); } catch { /* noop */ }
  });
}
