// dev-mcp server — exposes EmailWarm dev logs to MCP-compatible agents
// (Claude Code, GitHub Copilot CLI, Gemini CLI, etc.).
//
// Tools:
//   dev.search_logs { query, sources?, level?, since?, limit? }
//     → array of matching NDJSON records (newest first), each with a
//       {source, offset} pointer so the agent can call dev.get_record
//       to read neighbors for context.
//
//   dev.tail_recent { sources?, level?, n? }
//     → last N records from each requested source.
//
//   dev.get_record { source, offset }
//     → single record at the given byte offset in source's NDJSON file.
//       `offset` is the byte position right before the `{` of the
//       record — same shape returned by dev.search_logs.
//
// Transport: stdio. Launched by `.bin/dev mcp`. Point your MCP client
// at the spawned process — see docs/05-agent-skills/11-skill-logging.md.
//
// Design notes:
//   - All file reads are bounded (limit param). We never slurp a full
//     NDJSON file into context — that's the agent's bug, but we make
//     the safe default small.
//   - Files are opened lazily on first tool call and cached. They are
//     re-opened on ENOENT (e.g. after `.bin/dev restart` truncated them).
//   - "since" accepts the same formats as `.bin/dev logs --json`:
//     compact ("5m", "30s"), ms-since-epoch, or ISO date.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_DIR = process.env.DEV_RUNTIME_DIR
  ? path.resolve(process.env.DEV_RUNTIME_DIR)
  : path.resolve(REPO_ROOT, '.bin/.runtime');

const SOURCES = {
  backend: path.join(RUNTIME_DIR, 'backend.ndjson'),
  frontend: path.join(RUNTIME_DIR, 'frontend.ndjson'),
  infra: path.join(RUNTIME_DIR, 'infra.ndjson'),
};

const LEVEL_NUM = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

// ----- helpers -------------------------------------------------------------

/** Parse a `--since` value into epoch-ms. Accepts "5m", "30s", "1h",
 *  raw epoch-ms, raw epoch-seconds, or ISO date string. */
function parseSince(raw: any) {
  if (!raw) return 0;
  const m = String(raw).match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2] ?? 's';
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
    return Date.now() - n * mult;
  }
  if (/^\d+$/.test(String(raw))) {
    const n = Number(raw);
    if (n > 1e12) return n;
    return Date.now() - n * 1000;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function parseLevel(raw: any) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const key = String(raw).toLowerCase() as keyof typeof LEVEL_NUM;
  return LEVEL_NUM[key] ?? 0;
}

/** Read NDJSON from `path` backwards (newest first) and yield parsed records.
 *  Tracks byte offsets so the agent can `get_record` neighbors. */
function* readRecordsNewestFirst(path: string, opts: {
  since: number;
  minLevel: number;
  inbox?: string;
  grep?: RegExp;
  limit: number;
}) {
  if (!fs.existsSync(path)) return;
  // Read whole file then walk backwards. For multi-GB NDJSON this is
  // expensive — production deployments should swap in a tail-and-skip
  // strategy. For local dev (lines < a few hundred thousand) this is
  // fine and gives correct offsets.
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split('\n');
  let offset = Buffer.byteLength(text, 'utf8');

  // Walk backwards. Track offset of next line (start position).
  let yielded = 0;
  for (let i = lines.length - 1; i >= 0 && yielded < opts.limit; i--) {
    const line = lines[i];
    if (!line) continue;
    // Compute the start offset of this line. We walk from `offset`
    // backwards; line length + 1 (newline) gets us to the previous line.
    const lineByteLen = Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
    offset = offset - lineByteLen;
    const startOffset = offset;
    if (startOffset < 0) continue;

    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }

    if (opts.since && (rec.time ?? 0) < opts.since) continue;
    if (opts.minLevel && (rec.level ?? 0) < opts.minLevel) continue;
    if (opts.inbox && rec.inboxId !== opts.inbox) continue;
    if (opts.grep && !opts.grep.test(JSON.stringify(rec))) continue;

    rec.__source = pathBasename(path);
    rec.__offset = startOffset;
    yield rec;
    yielded++;
  }
}

function pathBasename(p: string): string {
  const base = path.basename(p);
  return base.replace(/\.ndjson$/, '');
}

function makeRegex(q?: string): RegExp | undefined {
  if (!q) return undefined;
  try {
    return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  } catch {
    return undefined;
  }
}

// ----- tool implementations ------------------------------------------------

function searchLogs(args: any) {
  const query = args.query as string | undefined;
  const since = parseSince(args.since);
  const minLevel = parseLevel(args.level);
  const inbox = args.inboxId as string | undefined;
  const grep = makeRegex(query);
  const limit = Math.max(1, Math.min(Number(args.limit ?? 50), 500));
  const sources = pickSources(args.sources);

  const matches: any[] = [];
  for (const src of sources) {
    for (const rec of readRecordsNewestFirst(SOURCES[src], { since, minLevel, inbox, grep, limit })) {
      matches.push(rec);
      if (matches.length >= limit) break;
    }
    if (matches.length >= limit) break;
  }
  // Sort newest-first overall.
  matches.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  return matches.slice(0, limit);
}

function tailRecent(args: any) {
  const n = Math.max(1, Math.min(Number(args.n ?? 20), 200));
  const sources = pickSources(args.sources);
  const minLevel = parseLevel(args.level);
  const all: any[] = [];
  for (const src of sources) {
    const iter = readRecordsNewestFirst(SOURCES[src], { since: 0, minLevel, inbox: undefined, grep: undefined, limit: n });
    for (const rec of iter) all.push(rec);
  }
  all.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  return all.slice(0, n);
}

function getRecord(args: any) {
  const source = String(args.source ?? '').toLowerCase();
  const offset = Number(args.offset);
  const path = SOURCES[source as keyof typeof SOURCES];
  if (!path) {
    throw new Error(`unknown source: ${source} (expected backend|frontend|infra)`);
  }
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error(`invalid offset: ${args.offset}`);
  }
  if (!fs.existsSync(path)) return null;

  // Read a window around the offset to find the next newline-delimited
  // record. Cheaper than reading from offset 0 every time.
  const fd = fs.openSync(path, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (offset >= stat.size) return null;
    // Read up to 64 KB from offset, then find the next '{' and parse until '}'.
    const windowSize = Math.min(64 * 1024, stat.size - offset);
    const buf = Buffer.alloc(windowSize);
    fs.readSync(fd, buf, 0, windowSize, offset);
    const text = buf.toString('utf8');
    const braceIdx = text.indexOf('{');
    if (braceIdx === -1) return null;
    const endIdx = text.indexOf('\n', braceIdx);
    const slice = endIdx === -1 ? text.slice(braceIdx) : text.slice(braceIdx, endIdx);
    let rec: any;
    try { rec = JSON.parse(slice); } catch { return null; }
    rec.__source = source;
    return rec;
  } finally {
    fs.closeSync(fd);
  }
}

function pickSources(raw: any): Array<keyof typeof SOURCES> {
  const valid = Object.keys(SOURCES);
  if (!raw) return valid as Array<keyof typeof SOURCES>;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const filtered = list
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => valid.includes(s));
  return (filtered.length > 0 ? filtered : valid) as Array<keyof typeof SOURCES>;
}

// ----- MCP plumbing --------------------------------------------------------

const server = new Server(
  { name: 'emailwarm-dev', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'dev.search_logs',
      description:
        'Search EmailWarm dev logs (backend / frontend / infra) for records matching a query. ' +
        'Returns records newest-first with a {source, offset} pointer so the agent can call ' +
        'dev.get_record to read context neighbors. Bounded — safe to call from an LLM.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Regex or substring to match against the message and all structured fields.' },
          sources: { type: 'array', items: { type: 'string', enum: ['backend', 'frontend', 'infra'] }, description: 'Limit to these sources. Default: all.' },
          level: { type: 'string', description: 'Minimum level: trace|debug|info|warn|error|fatal (or pino number 10-60). Default: all.' },
          since: { type: 'string', description: 'Only records newer than this. Accepts "5m", "1h", "30s", epoch-ms, or ISO date.' },
          inboxId: { type: 'string', description: 'Only records with this inboxId (backend).' },
          limit: { type: 'number', description: 'Max records to return. Default 50, hard cap 500.' },
        },
      },
    },
    {
      name: 'dev.tail_recent',
      description: 'Return the N most recent records (newest first) from each requested source. Cheap — read last few hundred lines.',
      inputSchema: {
        type: 'object',
        properties: {
          n: { type: 'number', description: 'Number of records to return. Default 20, hard cap 200.' },
          sources: { type: 'array', items: { type: 'string', enum: ['backend', 'frontend', 'infra'] } },
          level: { type: 'string', description: 'Minimum level filter.' },
        },
      },
    },
    {
      name: 'dev.get_record',
      description: 'Read a single record at a specific byte offset in a source NDJSON file. ' +
        'Used to follow pointers returned by dev.search_logs to read context without re-scanning.',
      inputSchema: {
        type: 'object',
        required: ['source', 'offset'],
        properties: {
          source: { type: 'string', enum: ['backend', 'frontend', 'infra'] },
          offset: { type: 'number', description: 'Byte offset returned by dev.search_logs as __offset.' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result: unknown;
    switch (name) {
      case 'dev.search_logs': result = searchLogs(args ?? {}); break;
      case 'dev.tail_recent': result = tailRecent(args ?? {}); break;
      case 'dev.get_record':  result = getRecord(args ?? {});  break;
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
  }
});

// ----- bootstrap -----------------------------------------------------------

async function main() {
  // Log to stderr so it doesn't pollute the stdio MCP transport.
  process.stderr.write(`[emailwarm-dev-mcp] starting; runtime=${RUNTIME_DIR}\n`);
  for (const [src, p] of Object.entries(SOURCES)) {
    process.stderr.write(`[emailwarm-dev-mcp]   ${src}: ${p} ${fs.existsSync(p) ? '(exists)' : '(missing — will return empty results)'}\n`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[emailwarm-dev-mcp] ready (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`[emailwarm-dev-mcp] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
