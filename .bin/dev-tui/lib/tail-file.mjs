// tail-file: follow a file by name (handles truncation/rotation) and emit
// new lines. Used by both .bin/dev logs --follow and the Ink TUI.
//
// Strategy:
//   - On first read, read the last N bytes (so we don't dump a 2GB log).
//   - On subsequent ticks, fs.watch + read-from-offset.
//   - If fs.watch is not available (some volumes / containers), fall back
//     to a 200ms poll loop.
//   - If the file shrinks (truncated by `> file` or rotation), re-anchor
//     to the new EOF and emit a synthetic notice line.

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as readline from 'node:readline';

const DEFAULT_INITIAL_BYTES = 200 * 1024; // 200 KB
const POLL_INTERVAL_MS = 200;

export class Tail extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.path
   * @param {number} [opts.initialBytes]
   * @param {boolean} [opts.fromStart]  if true, read from byte 0
   * @param {string} [opts.source]      label emitted on synthetic events
   */
  constructor({ path, initialBytes = DEFAULT_INITIAL_BYTES, fromStart = false, source = 'tail' }) {
    super();
    this.path = path;
    this.initialBytes = initialBytes;
    this.fromStart = fromStart;
    this.source = source;
    this.offset = 0;
    this.buffer = '';
    this.closed = false;
    this.pollTimer = null;
    this.watcher = null;
    this._tickBound = this._tick.bind(this);
  }

  async start() {
    try {
      const stat = await fs.promises.stat(this.path);
      const startFrom = this.fromStart
        ? 0
        : Math.max(0, stat.size - this.initialBytes);
      this.offset = startFrom;
      this.emit('ready', { path: this.path, source: this.source, size: stat.size });
    } catch (err) {
      // File doesn't exist yet — start at 0, wait for it.
      this.offset = 0;
      this.emit('ready', { path: this.path, source: this.source, size: 0, missing: true });
    }

    // Try fs.watch; fall back to polling.
    try {
      this.watcher = fs.watch(this.path, { persistent: true }, () => this._tick());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
        this._startPolling();
      });
    } catch {
      this._startPolling();
    }

    // Always do an immediate tick to push any pre-existing buffered tail.
    queueMicrotask(this._tickBound);
  }

  _startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(this._tickBound, POLL_INTERVAL_MS);
  }

  async _tick() {
    if (this.closed) return;
    let stat;
    try {
      stat = await fs.promises.stat(this.path);
    } catch {
      return; // file doesn't exist yet, wait
    }

    if (stat.size < this.offset) {
      // Truncated or rotated.
      this.emit('reset', { path: this.path, source: this.source });
      this.offset = 0;
      this.buffer = '';
    }

    if (stat.size === this.offset) return;

    const stream = fs.createReadStream(this.path, {
      start: this.offset,
      end: stat.size - 1,
      encoding: 'utf8',
    });

    let bytesRead = 0;
    for await (const chunk of stream) {
      bytesRead += Buffer.byteLength(chunk, 'utf8');
      this.buffer += chunk;
      let idx;
      // Drain complete lines (newline-delimited).
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length > 0) this.emit('line', line);
      }
    }

    if (bytesRead > 0) {
      this.offset += bytesRead;
    }
  }

  async stop() {
    this.closed = true;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* noop */ }
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Flush trailing buffer if it looks like a complete line.
    if (this.buffer.length > 0) {
      this.emit('line', this.buffer);
      this.buffer = '';
    }
  }
}

/**
 * Convenience: read the last N lines of a file synchronously.
 * Used by the `dev logs --json` wrapper to backfill on startup.
 */
export function tailSync(path, maxLines = 200) {
  if (!fs.existsSync(path)) return [];
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  return lines.slice(-maxLines);
}

/**
 * Convenience: stream lines from a file with readline. Used when a
 * caller wants simple `for await (const line of linesOf(path))` semantics.
 */
export async function* linesOf(path) {
  if (!fs.existsSync(path)) return;
  const rl = readline.createInterface({
    input: fs.createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    yield line;
  }
}
