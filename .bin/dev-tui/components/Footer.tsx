// components/Footer.tsx — action bar at the bottom. Two lines: active
// mode summary on top, key bindings below. Heavy separator between
// panes and footer for clean visual separation.

import React from 'react';
import { Box, Text } from 'ink';

export function Footer({ focused, mergedMode, followEnabled }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Key n="1" label="backend" active={!mergedMode && focused === 'backend'} />
          <Key n="2" label="frontend" active={!mergedMode && focused === 'frontend'} />
          <Key n="3" label="infra" active={!mergedMode && focused === 'infra'} />
          <Key n="4" label="all" active={mergedMode} />
          <Text> · </Text>
          <Text>Tab focus · </Text>
          <Text>/ search</Text>
        </Box>
        <Box>
          <Text dimColor>focus: </Text>
          <Text bold color="cyan">{mergedMode ? 'all' : focused}</Text>
          <Text> · </Text>
          <Text dimColor>follow: </Text>
          <Text color={followEnabled ? 'green' : 'gray'}>{followEnabled ? 'on' : 'off'}</Text>
        </Box>
      </Box>
      <Box>
        <Text dimColor>/ search · n/N next/prev · g/G top/bottom · f follow · c clear · ? help · q quit</Text>
      </Box>
    </Box>
  );
}

function Key({ n, label, active }) {
  return (
    <Text>
      <Text color={active ? 'cyan' : 'gray'}>[{n}]</Text>
      <Text color={active ? 'cyan' : undefined}>{label}</Text>
      <Text> </Text>
    </Text>
  );
}
