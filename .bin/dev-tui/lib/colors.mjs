// shared chalk-aware color helpers for the Ink TUI.
//
// We use chalk so the colors degrade cleanly on terminals that don't
// support truecolor. chalk.level is set automatically when the Ink app
// mounts — these helpers just look up the right chalk color at render time.

import chalk from 'chalk';
import { LEVELS, LEVEL_COLOR_HEX, SOURCE_COLOR_HEX } from './format.mjs';

export function levelColor(level) {
  if (chalk.level >= 2) {
    const hex = LEVEL_COLOR_HEX[level] ?? LEVEL_COLOR_HEX[LEVELS.info];
    return chalk.hex(hex);
  }
  // 8-color fallback — map numeric level to a chalk named color.
  switch (level) {
    case LEVELS.trace: return chalk.gray;
    case LEVELS.debug: return chalk.blue;
    case LEVELS.info:  return chalk.green;
    case LEVELS.warn:  return chalk.yellow;
    case LEVELS.error: return chalk.red;
    case LEVELS.fatal: return chalk.magenta;
    default:           return chalk.white;
  }
}

export function sourceColor(source) {
  if (chalk.level >= 2) {
    const hex = SOURCE_COLOR_HEX[source] ?? '#94a3b8';
    return chalk.hex(hex);
  }
  switch (source) {
    case 'backend':  return chalk.cyan;
    case 'frontend': return chalk.magenta;
    case 'infra':    return chalk.yellow;
    default:         return chalk.gray;
  }
}

export { chalk };
