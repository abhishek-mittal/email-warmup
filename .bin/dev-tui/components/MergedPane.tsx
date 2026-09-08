// components/MergedPane.tsx — when the user hits `4`, all sources
// interleave into one chronological column. Same search/follow rules
// as Pane but no separate focus border.

import React, { useEffect, useRef, useMemo } from 'react';
import { Box, Text } from 'ink';
import { ScrollView } from 'ink-scroll-view';
import { formatTime, LEVEL_NAME } from '../lib/format.mjs';
import { levelColor, sourceColor } from '../lib/colors.mjs';

export function MergedPane({ buffers, height, width, searchQuery, searchHit, followEnabled }) {
  // Merge all sources by time, newest at the bottom (chronological order).
  const merged = useMemo(() => {
    const all = [];
    for (const source of Object.keys(buffers)) {
      for (const line of buffers[source].lines) {
        all.push(line);
      }
    }
    all.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    return all;
  }, [buffers]);

  const re = searchQuery ? makeRegex(searchQuery) : null;
  const scrollRef = useRef(null);
  useEffect(() => {
    if (!followEnabled || !scrollRef.current) return;
    if (searchHit && re) {
      scrollRef.current.scrollTo(searchHit.index);
    } else {
      scrollRef.current.scrollTo(merged.length);
    }
  }, [followEnabled, searchHit, merged.length, re]);

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor="white"
      width={width}
      height={height}
    >
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color="white">merged</Text>
        <Text dimColor>{merged.length} records across all sources</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <ScrollView ref={scrollRef} height={height - 3}>
          {merged.length === 0 ? (
            <Text dimColor>  waiting for logs…</Text>
          ) : merged.map((l, i) => {
            const isHit = re && re.test(l.raw);
            const isActiveHit = isHit && searchHit && searchHit.index === i;
            return (
              <MergedLine key={i} line={l} width={width - 4} hit={isHit} activeHit={isActiveHit} />
            );
          })}
        </ScrollView>
      </Box>
    </Box>
  );
}

function MergedLine({ line, width, hit, activeHit }) {
  const t = formatTime(line.time);
  const lvl = LEVEL_NAME[line.level] ?? 'INFO';
  const lvlStr = levelColor(line.level)(lvl);
  const stripe = sourceColor(line.source);
  const msg = (line.msg || '').slice(0, Math.max(width - 40, 10));
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{t} </Text>
      <Text>{stripe(`[${line.source.slice(0, 3)}]`)}</Text>
      <Text> </Text>
      <Text>{lvlStr}</Text>
      <Text> </Text>
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
