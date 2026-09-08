# `emailwarm-dev-mcp`

MCP server that exposes EmailWarm dev logs to Claude Code / GitHub Copilot
CLI / Gemini CLI / any MCP-compatible agent.

## Tools

| Tool | Inputs | Returns |
|---|---|---|
| `dev.search_logs` | `query`, `sources?`, `level?`, `since?`, `inboxId?`, `limit?` | NDJSON array of matching records newest-first, each with a `{source, offset}` pointer |
| `dev.tail_recent` | `n?`, `sources?`, `level?` | last N records across requested sources |
| `dev.get_record` | `source`, `offset` | single record at the given byte offset |

The pointer-following pattern is the key bit: `search_logs` returns hits
with byte offsets, and the agent walks neighbors via `get_record` to
assemble context without re-scanning the whole file. Same trick used by
`git blame`, `log`, and `tail -c +offset` — scales to multi-GB logs
without slurping them into the agent's context window.

## Run

```bash
.bin/dev mcp
# logs to stderr; communicates over stdio
```

Or directly:

```bash
cd .bin/dev-mcp
npm install   # or pnpm install
npm start
```

## Register with Claude Code

Add to `~/.config/claude_desktop_config.json` (or the MCP-equivalent
config for your client):

```jsonc
{
  "mcpServers": {
    "emailwarm-dev": {
      "command": "/absolute/path/to/.bin/dev",
      "args": ["mcp"]
    }
  }
}
```

Restart the client. You should see `emailwarm-dev` listed as a server
with three tools.

## Limits

- `search_logs.limit` defaults to 50, hard cap 500
- `tail_recent.n` defaults to 20, hard cap 200
- `get_record` reads a 64 KB window per call (small records only — fine
  for pino/next dev output which is typically < 4 KB per line)

These defaults exist so an agent never accidentally slurps a 2 GB log
file into context.
