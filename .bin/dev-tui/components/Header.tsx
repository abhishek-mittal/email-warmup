// components/Header.tsx — top status bar. Shows per-source line counts
// and the current time so the user can see at a glance whether logs are
// still flowing.

import React from 'react';
import { Box, Text } from 'ink';
import { chalk } from '../lib/colors.mjs';

export function Header({ buffers }) {
  const counts = ['backend', 'frontend', 'infra'].map((s) => ({
    s, n: buffers[s]?.lines.length ?? 0, t: buffers[s]?.truncated ?? 0,
  }));
  const now = new Date().toLocaleTimeString();
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text>
        <Text color="cyan" bold>EmailWarm dev</Text>
        <Text> · </Text>
        <Text>{now}</Text>
      </Text>
      <Text>
        {counts.map(({ s, n, t }, i) => (
          <Text key={s}>
            {i > 0 ? <Text> · </Text> : null}
            <Text>{s}</Text>
            <Text> ↑ </Text>
            <Text color="green">{n}</Text>
            {t > 0 ? <Text dimColor> (+{t} truncated)</Text> : null}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
