// components/HelpOverlay.tsx — full-screen help shown when user hits `?`.
// Covers all keybindings + NDJSON / MCP pointers for AI-agent usage.

import React from 'react';
import { Box, Text } from 'ink';

export function HelpOverlay({ onClose }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="yellow">EmailWarm dev TUI — help</Text>
      <Text> </Text>
      <Text bold>Navigation</Text>
      <Text>  Tab          cycle pane focus (backend → frontend → infra)</Text>
      <Text>  1 / 2 / 3    focus backend / frontend / infra</Text>
      <Text>  4            merged view (all sources interleaved)</Text>
      <Text bold>Search</Text>
      <Text>  /            open search box (regex or substring)</Text>
      <Text>  Enter        commit filter</Text>
      <Text>  c            clear current filter</Text>
      <Text bold>Scrolling</Text>
      <Text>  g / G        jump to top / bottom</Text>
      <Text>  f            toggle follow-tail (default on)</Text>
      <Text bold>Other</Text>
      <Text>  ?            toggle this help</Text>
      <Text>  q / Ctrl+C   quit (TUI window only — backend/frontend keep running)</Text>
      <Text> </Text>
      <Text bold color="gray">AI-agent channel</Text>
      <Text dimColor>  .bin/.runtime/*.ndjson — one JSON record per line, jq/grep-friendly</Text>
      <Text dimColor>  .bin/dev logs --json ... — piped NDJSON with --since/--level/--inbox/--grep</Text>
      <Text dimColor>  .bin/dev mcp        — MCP server with search_logs / tail_recent / get_record</Text>
      <Text> </Text>
      <Text dimColor>Press ? or Esc to close.</Text>
    </Box>
  );
}
