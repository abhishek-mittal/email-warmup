// Shared level/color/severity helpers used by both the bash side
// (.bin/dev open-tui command) and the Ink TUI (.bin/dev-tui/*).
//
// Single source of truth for:
//   - pino level numbers → text + hex
//   - hex → chalk colorization
//   - timestamp formatting
//   - Next.js stdout → best-effort NDJSON record inference
//
// Kept dependency-light (no ink, no chalk-pino) so the bash side and any
// Node script that just wants to format one line can import this too.

export const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export const LEVEL_COLOR_HEX = {
  10: '#6b7280', // trace gray
  20: '#60a5fa', // debug blue
  30: '#34d399', // info green
  40: '#fbbf24', // warn yellow
  50: '#f87171', // error red
  60: '#f0abfc', // fatal magenta
};

export const LEVEL_NAME = Object.fromEntries(
  Object.entries(LEVELS).map(([k, v]) => [v, k.toUpperCase()]),
);

export const SOURCE_COLOR_HEX = {
  backend: '#22d3ee', // cyan
  frontend: '#a78bfa', // magenta
  infra: '#fbbf24', // yellow
};

/**
 * Format a pino-style record for human display.
 * `record` may be:
 *   - a parsed pino JSON object (preferred), or
 *   - a plain text line (we wrap it as `{level:30, msg: text}`)
 */
export function formatRecordForHuman(record) {
  const level = record.level ?? LEVELS.info;
  const time = formatTime(record.time);
  const name = record.name ?? record.source ?? '';
  const levelName = LEVEL_NAME[level] ?? 'INFO';
  const msg = record.msg ?? '';

  // Prefix: HH:MM:SS.mmm LEVEL [context] msg
  const head = time ? `${time} ${levelName}` : levelName;
  const ctx = name ? ` [${name}]` : '';
  return `${head}${ctx} ${msg}`.trim();
}

export function formatTime(input) {
  if (!input) return '';
  const d = typeof input === 'number' ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Best-effort parser for Next.js dev server stdout lines.
 *
 * Recognises:
 *   - "GET /api/inboxes 200 in 42ms"        → info, with method/path/status/durationMs
 *   - "Error: <message>" or "Uncaught ..."  → error, with msg + optional stack
 *   - "Compiled in 312ms"                   → info
 *   - " ✓ Ready in 4.2s" / "○ Compiling" / "⚠ Warning:" / hot-reload lines
 *   - everything else                       → info, msg = raw line
 *
 * Returns a record shaped like a pino line, ready to append to the NDJSON
 * stream alongside backend records.
 */
export function parseNextLine(line, source = 'frontend') {
  const record = {
    source,
    level: LEVELS.info,
    time: Date.now(),
    msg: line,
  };

  // Method path status duration — e.g. "GET /inboxes 200 in 42ms"
  const m = line.match(/^([A-Z]+)\s+(\S+)\s+(\d{3})\s+in\s+(\d+(?:\.\d+)?)\s*ms/i);
  if (m) {
    return {
      ...record,
      level: Number(m[3]) >= 500 ? LEVELS.error : Number(m[3]) >= 400 ? LEVELS.warn : LEVELS.info,
      method: m[1],
      path: m[2],
      status: Number(m[3]),
      durationMs: Number(m[4]),
      msg: `${m[1]} ${m[2]} ${m[3]} ${m[4]}ms`,
    };
  }

  // Error: ...
  if (/^(Error|Uncaught|TypeError|ReferenceError|RangeError|SyntaxError):/i.test(line)) {
    return { ...record, level: LEVELS.error, msg: line };
  }

  // Warning: ...
  if (/^(\u26A0\s*)?Warning:/i.test(line) || /^\s*warn:/i.test(line)) {
    return { ...record, level: LEVELS.warn, msg: line };
  }

  return record;
}

/**
 * Parse a single line of pino NDJSON. Returns null if the line is empty or
 * unparseable so callers can silently skip it (e.g. partial trailing line).
 */
export function parsePinoLine(line) {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed[0] !== '{') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Pretty-print a level number as a colored short label for terminal use
 * (consumers should chalk the returned string in their own context).
 */
export function levelName(level) {
  return LEVEL_NAME[level] ?? 'INFO';
}
