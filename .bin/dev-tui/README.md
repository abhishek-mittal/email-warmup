# `emailwarm-dev-tui`

Ink-based two-column live-log TUI for `.bin/dev up`. Companion modules:

| File | Purpose |
|---|---|
| `index.tsx` | Entry point. Mounts the App component, validates runtime dir. |
| `app.tsx` | Top-level state machine. Manages buffers, focus, search, help. |
| `components/*.tsx` | Header, Pane, MergedPane, Footer, SearchOverlay, HelpOverlay. |
| `lib/tail-file.mjs` | fs.watch + offset-based tail. Handles truncation/rotation. |
| `lib/format.mjs` | Level→color, level→name, time formatting, Next.js stdout→NDJSON parser. |
| `lib/colors.mjs` | chalk wrappers. Truecolor-aware, 8-color fallback. |
| `next-log-capture.mjs` | Wraps `next dev` — mirrors stdout/stderr to .log AND .ndjson. |
| `dev-logs-json.mjs` | Implements `.bin/dev logs --json` — used by the bash side and the MCP server can share it later. |

## Run

```bash
# via .bin/dev (preferred — auto-launched on `up`)
.bin/dev up

# manual launch (for development)
cd .bin/dev-tui
pnpm install
node --import tsx index.tsx
```

## Keybindings

See the in-app help overlay (press `?`) for the full reference. Short version:
`Tab` focus · `1`/`2`/`3`/`4` jump sources · `/` search · `n`/`N` nav ·
`g`/`G` top/bottom · `f` follow · `c` clear · `?` help · `q` quit.

## Design

Layout: Header (1 row) + body (two columns or merged) + Footer (2 rows).
Focused pane gets a heavy white border, unfocused gets a light gray border.
Source color stripes (cyan/magenta/yellow) anchor the eyes to source.
Levels: TRACE gray, DEBUG blue, INFO green, WARN yellow, ERROR red,
FATAL magenta.

Buffer is bounded to 5,000 lines per source to keep memory under control.
When truncated, the pane footer shows `(N older truncated)`.
