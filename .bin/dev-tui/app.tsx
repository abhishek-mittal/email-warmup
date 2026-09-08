// app.tsx — top-level state machine for the Ink TUI.
//
// Manages:
//   - which source pane is focused
//   - whether we're in "merged-all" mode
//   - search overlay state (visible + query)
//   - per-source line buffers (fed by Tail from lib/tail-file.mjs)
//   - help overlay visibility
//
// Renders:
//   Header (uptime + per-source line counts)
//   Two-column pane layout (or merged pane)
//   Footer (active mode + key hints)
//   Search overlay (modal)
//   Help overlay (modal)

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Tail } from './lib/tail-file.mjs';
import { Header } from './components/Header.tsx';
import { Pane } from './components/Pane.js';
import { MergedPane } from './components/MergedPane.js';
import { Footer } from './components/Footer.js';
import { SearchOverlay } from './components/SearchOverlay.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { chalk } from './lib/colors.mjs';

const MAX_LINES_PER_SOURCE = 5_000;

// Track terminal dimensions manually (Ink 5 dropped useWindowSize).
function getWindowSize(): { columns: number; rows: number } {
  const out = process.stdout;
  return {
    columns: out.columns ?? 80,
    rows: out.rows ?? 24,
  };
}

export function App({ sources, runtimeDir }) {
  const { exit } = useApp();
  const [windowSize, setWindowSize] = useState(getWindowSize());
  useEffect(() => {
    const onResize = () => setWindowSize(getWindowSize());
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, []);
  const { columns, rows } = windowSize;

  // Per-source buffers: { source: { lines: ParsedLine[], truncated: number } }
  const initialBuffers = useMemo(() => {
    const out = {};
    for (const source of Object.keys(sources)) {
      out[source] = { lines: [], truncated: 0 };
    }
    return out;
  }, [sources]);
  const [buffers, setBuffers] = useState(initialBuffers);

  // Source focus + mode.
  const [focused, setFocused] = useState('backend'); // 'backend' | 'frontend' | 'infra' | 'all'
  const [mergedMode, setMergedMode] = useState(false);

  // Search.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHit, setSearchHit] = useState({ source: null, index: -1 });
  const searchHitRef = useRef(searchHit);
  searchHitRef.current = searchHit;

  // Help.
  const [helpOpen, setHelpOpen] = useState(false);

  // Pause auto-follow on scroll-up; resume on 'f' or scroll-to-bottom.
  const [followEnabled, setFollowEnabled] = useState(true);

  // ----- Tail setup --------------------------------------------------------

  useEffect(() => {
    const tails = [];
    for (const [source, file] of Object.entries(sources)) {
      const tail = new Tail({ path: String(file), source: String(source), initialBytes: 200 * 1024 });
      tail.on('line', (rawLine) => {
        const parsed = parseLine(rawLine, source);
        if (!parsed) return;
        setBuffers((prev) => {
          const cur = prev[source] ?? { lines: [], truncated: 0 };
          const lines = cur.lines.concat([parsed]);
          let truncated = cur.truncated;
          if (lines.length > MAX_LINES_PER_SOURCE) {
            lines.splice(0, lines.length - MAX_LINES_PER_SOURCE);
            truncated += 1;
          }
          return { ...prev, [source]: { lines, truncated } };
        });
      });
      tail.start().catch(() => {/* missing file ok */});
      tails.push(tail);
    }
    return () => {
      for (const t of tails) t.stop();
    };
  }, [sources]);

  // ----- Keyboard ---------------------------------------------------------

  useInput((input, key) => {
    // Help overlay captures everything when open.
    if (helpOpen) {
      if (input === 'q' || key.escape) setHelpOpen(false);
      return;
    }
    // Search overlay captures typing; Enter/Esc/Ctrl+C handled inside.
    if (searchOpen) return;

    // Global keys.
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (input === '?') { setHelpOpen(true); return; }
    if (input === '/') { setSearchOpen(true); return; }
    if (input === 'c') {
      setSearchQuery('');
      setSearchHit({ source: null, index: -1 });
      return;
    }
    if (input === 'f') { setFollowEnabled((v) => !v); return; }
    if (input === '4') { setMergedMode(true); setFocused('all'); return; }
    if (input === '1') { setMergedMode(false); setFocused('backend'); return; }
    if (input === '2') { setMergedMode(false); setFocused('frontend'); return; }
    if (input === '3') { setMergedMode(false); setFocused('infra'); return; }
    if (key.tab) {
      // Cycle focus: backend → frontend → infra → backend (or include all if mergedMode).
      setMergedMode(false);
      const order = ['backend', 'frontend', 'infra'];
      const idx = order.indexOf(focused);
      setFocused(order[(idx + 1) % order.length]);
      return;
    }
  });

  // ----- Search hit navigation -------------------------------------------

  // When searchQuery changes, recompute the first hit so the cursor jumps to it.
  useEffect(() => {
    if (!searchQuery) {
      setSearchHit({ source: null, index: -1 });
      return;
    }
    const re = makeSearchRegex(searchQuery);
    if (!re) return;
    let first = null;
    outer: for (const source of Object.keys(buffers)) {
      const lines = buffers[source].lines;
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i].raw)) { first = { source, index: i }; break outer; }
      }
    }
    setSearchHit(first ?? { source: null, index: -1 });
  }, [searchQuery, buffers]);

  // ----- Layout ----------------------------------------------------------

  const usableRows = Math.max(rows - 3, 4); // minus header + footer
  const paneWidth = mergedMode ? columns : Math.floor((columns - 3) / 2);

  return (
    <Box flexDirection="column" height={rows}>
      <Header buffers={buffers} />
      {mergedMode ? (
        <MergedPane
          buffers={buffers}
          height={usableRows}
          width={columns}
          searchQuery={searchQuery}
          searchHit={searchHit}
          followEnabled={followEnabled}
        />
      ) : (
        <Box flexDirection="row" flexGrow={1} height={usableRows}>
          {['backend', 'frontend', 'infra'].map((source, idx) => {
            const buf = buffers[source];
            if (!buf) return null;
            return (
              <Pane
                key={source}
                source={source}
                lines={buf.lines}
                truncated={buf.truncated}
                width={paneWidth}
                height={usableRows}
                focused={!mergedMode && focused === source}
                searchQuery={searchQuery}
                searchHit={searchHit.source === source ? searchHit : null}
                followEnabled={followEnabled && focused === source}
              />
            );
          })}
        </Box>
      )}
      <Footer focused={focused} mergedMode={mergedMode} followEnabled={followEnabled} />
      {searchOpen && (
        <SearchOverlay
          initial={searchQuery}
          onSubmit={(q) => { setSearchQuery(q); setSearchOpen(false); }}
          onCancel={() => setSearchOpen(false)}
        />
      )}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
    </Box>
  );
}

// Parse one NDJSON line into a displayable record. Falls back to a
// pseudo-record for non-JSON lines so even pretty-printed pino output
// (from a buggy future pino version) shows up as "info" rows.
function parseLine(rawLine, source) {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      return {
        source: obj.source ?? source,
        level: obj.level ?? 30,
        time: obj.time ?? Date.now(),
        msg: obj.msg ?? '',
        name: obj.name ?? obj.context ?? obj.logger ?? '',
        raw: JSON.stringify(obj),
        obj,
      };
    } catch {
      /* fall through */
    }
  }
  return {
    source,
    level: 30,
    time: Date.now(),
    msg: trimmed,
    name: '',
    raw: trimmed,
    obj: null,
  };
}

function makeSearchRegex(query) {
  if (!query) return null;
  try {
    return new RegExp(escapeRegex(query), 'i');
  } catch {
    return null;
  }
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
