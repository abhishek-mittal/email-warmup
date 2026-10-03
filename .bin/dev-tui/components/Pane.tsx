// components/Pane.tsx — one source's column. Shows a heavy border when
// focused, light border when not. Highlights search hits inline.

import React, { useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { ScrollView } from 'ink-scroll-view';
import { formatTime, LEVEL_NAME } from '../lib/format.mjs';
import { levelColor, sourceColor, chalk } from '../lib/colors.mjs';

export function Pane({ source, lines, truncated, width, height, focused, searchQuery, searchHit, followEnabled }) {
  const borderStyle = focused ? 'bold' : 'single';
  const borderColor = focused ? 'white' : 'gray';
  const stripe = sourceColor(source);
  const re = searchQuery ? makeRegex(searchQuery) : null;

  // Scroll to follow: when followEnabled and we have a hit, jump to it;
  // otherwise jump to bottom (the latest line).
  const scrollRef = useRef(null);
  useEffect(() => {
    if (!followEnabled || !scrollRef.current) return;
    if (searchHit && re) {
      scrollRef.current.scrollTo(searchHit.index);
    } else {
      scrollRef.current.scrollTo(lines.length);
    }
  }, [followEnabled, searchHit, lines.length, re]);

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={borderColor}
      width={width}
      height={height}
      flexShrink={0}
    >
      <Box paddingX={1} justifyContent="space-between">
        <Text>
          <Text bold>{stripe(source)}</Text>
          <Text dimColor> · port {source === 'backend' ? 4611 : source === 'frontend' ? 3000 : '—'}</Text>
        </Text>
        {truncated > 0 ? <Text dimColor>({truncated} older truncated)</Text> : <Text dimColor>{lines.length}</Text>}
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <ScrollView ref={scrollRef} height={height - 3}>
          {lines.length === 0 ? (
            <Text dimColor>  waiting for logs…</Text>
          ) : lines.map((l, i) => {
            const isHit = re && re.test(l.raw);
            const isActiveHit = isHit && searchHit && searchHit.index === i;
            return <Line key={i} line={l} width={width - 4} hit={isHit} activeHit={isActiveHit} stripe={stripe} />;
          })}
        </ScrollView>
      </Box>
    </Box>
  );
}

function Line({ line, width, hit, activeHit, stripe }) {
  const t = formatTime(line.time);
  const lvl = LEVEL_NAME[line.level] ?? 'INFO';
  const lvlStr = levelColor(line.level)(lvl);
  const ctx = line.name ? line.name : '';
  const msg = (line.msg || '').slice(0, Math.max(width - 30, 10));
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{t} </Text>
      <Text>{lvlStr}</Text>
      <Text>{ctx ? ' ' : ''}</Text>
      <Text color="gray">{ctx}</Text>
      {activeHit ? (
        <Text inverse>{msg}</Text>
      ) : hit ? (
        <Text color="black" backgroundColor="yellow">{msg}</Text>
      ) : (
        <Text>{msg}</Text>
      )}
    </Text>
  );
}

function makeRegex(q) {
  try {
    return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  } catch {
    return null;
  }
}
