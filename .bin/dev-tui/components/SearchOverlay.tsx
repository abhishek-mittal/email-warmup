// components/SearchOverlay.tsx — modal text input shown when user hits `/`.
// Enter commits (filters in both panes), Esc cancels.

import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

export function SearchOverlay({ initial, onSubmit, onCancel }) {
  const [value, setValue] = useState(initial ?? '');

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      marginTop={1}
    >
      <Box>
        <Text color="cyan" bold>/</Text>
        <Text> </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(v) => onSubmit(v.trim())}
          placeholder="regex or substring (e.g. ECONNREFUSED, inboxId:abc, errCode:EAUTH)"
        />
      </Box>
      <Box>
        <Text dimColor>Enter to filter · Esc to cancel</Text>
      </Box>
    </Box>
  );
}
