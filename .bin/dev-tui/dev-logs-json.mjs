#!/usr/bin/env node
// dev-logs-json.mjs — implements `.bin/dev logs --json`.
//
// Emits newline-delimited JSON to stdout. Designed to be piped into
// `jq`, `fzf`, or directly into an LLM context window. Same parser
// shared with the Ink TUI and the MCP server in Phase 4.
//
// Usage (called by .bin/dev — see `cmd_logs_json`):
//   dev-logs-json.mjs --source all --level error --since 5m --follow
//   dev-logs-json.mjs --source backend --inbox abc-123 --grep EAUTH
//
// Flags:
//   --source backend|frontend|infra|all   default backend
//   --since 5m|1h|30s|epoch-ms             default: all records
//   --level warn|error|info|debug|trace   default: all (use named value or pino number)
//   --inbox ID                            matches records with inboxId=ID
//   --grep PAT                            regex over msg (and other stringified fields)
//   --context N                           include N records before each grep match
//   --limit N                             max records (default 200; --follow ignores)
//   --follow                              tail after initial dump; Ctrl+C to stop

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tail } from './lib/tail-file.mjs';
import { parsePinoLine, LEVELS } from './lib/format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const RUNTIME = path.resolve(repoRoot, '.bin/.runtime');

const SOURCES = {
  backend: path.join(RUNTIME, 'backend.ndjson'),
  frontend: path.join(RUNTIME, 'frontend.ndjson'),
  infra: path.join(RUNTIME, 'infra.ndjson'),
};

// ----- flag parsing ---------------------------------------------------------

const argv = process.argv.slice(2);
function getFlag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return argv[i + 1];
}
function hasFlag(name) {
  return argv.includes(`--${name}`);
}

const sourceFilter = (getFlag('source') ?? 'backend').toLowerCase();
const sinceRaw = getFlag('since');
const levelRaw = getFlag('level');
const inboxFilter = getFlag('inbox');
const grepFilter = getFlag('grep');
const contextLines = Number(getFlag('context') ?? 0);
const limit = Number(getFlag('limit') ?? 200);
const follow = hasFlag('follow');

const levelThreshold = levelRaw
  ? (Number.isFinite(Number(levelRaw))
      ? Number(levelRaw)
      : LEVELS[levelRaw.toLowerCase()] ?? 0)
  : 0;

const sinceMs = parseSince(sinceRaw);
const grepRe = grepFilter ? new RegExp(grepFilter, 'i') : null;

function parseSince(raw) {
  if (!raw) return 0;
  // Compact form: 5m, 1h, 30s, 500ms
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2] ?? 's';
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
    return Date.now() - n * mult;
  }
  // Numeric form: treat as ms-since-epoch if huge, else seconds-ago.
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 1e12) return n;       // already epoch-ms
    return Date.now() - n * 1000; // seconds
  }
  // ISO date string.
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d.getTime();
  warn(`could not parse --since "${raw}"; ignoring`);
  return 0;
}

// ----- sources to read -------------------------------------------------------

const sourcesToRead = sourceFilter === 'all'
  ? Object.keys(SOURCES)
  : [sourceFilter];

const existingSources = sourcesToRead.filter((s) => fs.existsSync(SOURCES[s]));
if (existingSources.length === 0) {
  err(`no NDJSON files exist yet for source(s): ${sourcesToRead.join(', ')}`);
  err(`start the dev stack first: .bin/dev up`);
  process.exit(1);
}

// ----- record filtering ------------------------------------------------------

function passes(record) {
  if (!record) return false;
  if (levelThreshold && (record.level ?? 0) < levelThreshold) return false;
  const ts = record.time ?? 0;
  if (sinceMs && ts && ts < sinceMs) return false;
  if (inboxFilter && record.inboxId !== inboxFilter) return false;
  if (grepRe) {
    // Match against msg + other common stringified fields.
    const blob = JSON.stringify(record);
    if (!grepRe.test(blob)) return false;
  }
  return true;
}

// ----- streaming -------------------------------------------------------------

let emitted = 0;
const ringBuffer = []; // for --context
function emit(record) {
  // Output as one JSON line on stdout.
  process.stdout.write(JSON.stringify(record) + '\n');
}

function ingestRecord(record, source) {
  // Normalize: tag with source if not already (frontend/infra records have
  // it; pino records don't, so infer from filename).
  if (!record.source) record.source = source;
  if (!record.time) record.time = Date.now();
  return record;
}

function dumpBacklog(source, path_) {
  if (!fs.existsSync(path_)) return;
  const lines = fs.readFileSync(path_, 'utf8').split('\n');
  for (const line of lines) {
    const record = parsePinoLine(line);
    if (!record) continue;
    const tagged = ingestRecord(record, source);
    if (grepRe) {
      // For grep, retain recent records even if they don't match, so we
      // can emit --context lines BEFORE a match.
      ringBuffer.push(tagged);
      if (ringBuffer.length > contextLines) ringBuffer.shift();
      if (passes(tagged)) {
        for (const ctx of ringBuffer.slice(0, -1)) emit(ctx);
        ringBuffer.length = 0;
        emit(tagged);
        emitted++;
      }
    } else if (passes(tagged)) {
      emit(tagged);
      emitted++;
      if (!follow && emitted >= limit) return true;
    }
  }
  return false;
}

let stopped = false;
const limitReached = {};

for (const source of existingSources) {
  if (stopped) break;
  limitReached[source] = dumpBacklog(source, SOURCES[source]);
  if (limitReached[source]) break;
}

if (!follow || stopped) {
  process.exit(0);
}

// ----- follow mode -----------------------------------------------------------

const tails = [];
for (const source of existingSources) {
  const tail = new Tail({ path: SOURCES[source], source });
  tail.on('line', (line) => {
    const record = parsePinoLine(line);
    if (!record) return;
    const tagged = ingestRecord(record, source);
    if (grepRe) {
      ringBuffer.push(tagged);
      if (ringBuffer.length > contextLines) ringBuffer.shift();
      if (passes(tagged)) {
        for (const ctx of ringBuffer.slice(0, -1)) emit(ctx);
        ringBuffer.length = 0;
        emit(tagged);
      }
    } else if (passes(tagged)) {
      emit(tagged);
    }
  });
  tail.on('reset', () => {
    // File rotated/truncated — clear context ring so we don't emit stale
    // records across the boundary.
    ringBuffer.length = 0;
  });
  tails.push(tail);
}

for (const tail of tails) {
  tail.start().catch((e) => err(`tail error: ${e.message}`));
}

function shutdown() {
  stopped = true;
  for (const tail of tails) tail.stop();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, shutdown);
}

// ----- helpers ---------------------------------------------------------------

function warn(msg) {
  process.stderr.write(`[dev-logs-json] ${msg}\n`);
}
function err(msg) {
  process.stderr.write(`[dev-logs-json] error: ${msg}\n`);
}
