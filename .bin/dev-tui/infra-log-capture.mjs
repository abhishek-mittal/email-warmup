#!/usr/bin/env node
// infra-log-capture.mjs — tails `docker compose logs -f --no-color
// --no-log-prefix` and writes both:
//   - .bin/.runtime/infra.log     (raw line, one per record)
//   - .bin/.runtime/infra.ndjson (one JSON object per line)
//
// Docker Compose's `--json` flag isn't available in v2/v5/stable, so we
// parse the prefixed plain-text output and inject a uniform record shape:
//
//   { source: "infra", level: 30|40|50, time: <epoch-ms>,
//     msg: <text>, service: <container-name> }
//
// Level inference:
//   - "ERROR", "FATAL", "panic:", "fatal error"            → 50 (error)
//   - "WARN", "WARNING"                                    → 40 (warn)
//   - everything else                                      → 30 (info)
//
// Service extraction: docker compose prefixes lines with "<service>-N  | "
// or "container-name  | ". We capture the first whitespace-delimited
// token before the " | " separator.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const rawLogPath = path.resolve(repoRoot, '.bin/.runtime/infra.log');
const ndjsonPath = path.resolve(repoRoot, '.bin/.runtime/infra.ndjson');

fs.mkdirSync(path.dirname(rawLogPath), { recursive: true });
const rawStream = fs.createWriteStream(rawLogPath, { flags: 'w' });
const ndjsonStream = fs.createWriteStream(ndjsonPath, { flags: 'w' });

const child = spawn('docker', ['compose', 'logs', '-f', '--no-color', '--no-log-prefix', '--tail=0'], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let carry = '';
child.stdout.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  rawStream.write(text);
  carry += text;
  let idx;
  while ((idx = carry.indexOf('\n')) !== -1) {
    const line = carry.slice(0, idx).replace(/\r$/, '');
    carry = carry.slice(idx + 1);
    if (!line) continue;
    ndjsonStream.write(JSON.stringify(parseInfraLine(line)) + '\n');
  }
});

// stderr from docker compose (e.g. "Container not found") — pipe to log too.
child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  rawStream.write(text);
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const record = parseInfraLine(line);
    record.level = record.level === 30 ? 40 : record.level; // treat stderr as warn
    ndjsonStream.write(JSON.stringify(record) + '\n');
  }
});

function parseInfraLine(line) {
  // docker compose v2 prefix: "<service>-1  | <message>"
  let service = 'unknown';
  let msg = line;
  const m = line.match(/^([a-zA-Z0-9_.-]+)-\d+\s*\|\s?(.*)$/);
  if (m) { service = m[1]; msg = m[2]; }

  let level = 30; // info default
  const lower = msg.toLowerCase();
  if (/\b(error|fatal|panic|exception|fatal error)\b/.test(lower)) level = 50;
  else if (/\b(warn|warning)\b/.test(lower)) level = 40;

  return {
    source: 'infra',
    service,
    level,
    time: Date.now(),
    msg: msg.trim(),
  };
}

function shutdown() {
  if (carry.length > 0) {
    ndjsonStream.write(JSON.stringify(parseInfraLine(carry)) + '\n');
    carry = '';
  }
  ndjsonStream.end();
  rawStream.end();
  setImmediate(() => process.exit(0));
}

child.on('exit', shutdown);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { child.kill(sig); } catch { /* noop */ }
  });
}
