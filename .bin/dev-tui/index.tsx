// index.tsx — entry point for the Ink TUI. Renders the App component.
//
// Usage:
//   node --import tsx index.tsx         # launched by .bin/dev up
//   pnpm tui                            # manual launch for development
//
// Required env (set by `.bin/dev` before exec):
//   DEV_RUNTIME_DIR   path to .bin/.runtime (default: <repo>/.bin/.runtime)

import { render } from 'ink';
import React from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Resolve runtime dir — env override first, then default.
const runtimeDir = process.env.DEV_RUNTIME_DIR
  ? path.resolve(process.env.DEV_RUNTIME_DIR)
  : path.resolve(repoRoot, '.bin/.runtime');

// Validate the runtime dir exists with at least one ndjson. If it
// doesn't, render an error screen instead of crashing silently.
const hasBackend = fs.existsSync(path.join(runtimeDir, 'backend.ndjson'));
const hasFrontend = fs.existsSync(path.join(runtimeDir, 'frontend.ndjson'));
const hasInfra = fs.existsSync(path.join(runtimeDir, 'infra.ndjson'));

if (!hasBackend && !hasFrontend && !hasInfra) {
  process.stderr.write(
    `\nNo log files found in ${runtimeDir}.\n` +
    `Run \`.bin/dev up\` first to start the dev stack.\n\n`,
  );
  process.exit(1);
}

const app = render(<App runtimeDir={runtimeDir} sources={{
  backend: path.join(runtimeDir, 'backend.ndjson'),
  frontend: path.join(runtimeDir, 'frontend.ndjson'),
  infra: path.join(runtimeDir, 'infra.ndjson'),
}} />);

// Ensure clean exit on Ctrl+C — Ink's default exitOnCtrlC=true handles
// this, but we explicitly await unmount so terminal mode is restored.
app.waitUntilExit().then(() => {
  process.exit(0);
}).catch(() => {
  process.exit(1);
});
