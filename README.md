# extracto-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for [Extracto](https://getextracto.dev). It gives Claude, Cursor, Claude Code, and any MCP client the ability to turn a URL plus a schema into validated, typed JSON — no prompt engineering, no HTML parsing, and no hallucinated fields (missing data comes back as `null`).

## Quick start

You need an Extracto API key. Get one at [app.getextracto.dev/keys](https://app.getextracto.dev/keys).

The server runs over stdio and is published to npm, so most clients just need this config block.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "extracto": {
      "command": "npx",
      "args": ["-y", "extracto-mcp"],
      "env": { "EXTRACTO_API_KEY": "exa_live_your_key_here" }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (or the project `.cursor/mcp.json`) with the same block.

### Claude Code

```bash
claude mcp add extracto -e EXTRACTO_API_KEY=exa_live_your_key_here -- npx -y extracto-mcp
```

Restart the client and ask it to extract something, e.g. _"Use extracto to pull the title, language and star count from github.com/facebook/react."_

## Tools

| Tool            | What it does |
| --------------- | ------------ |
| `extract`       | Synchronous extraction from a single URL (up to ~90s). Returns `{ data, meta }`. |
| `extract_async` | Submit an async job for heavy or anti-bot pages. Returns a job id immediately. |
| `get_job`       | Poll an async job for status and result. |
| `list_jobs`     | List your recent async jobs. |

### The `schema` argument

A schema is an object mapping field names to types. A type is:

- a literal: `"string"`, `"number"`, `"boolean"`, `"array"`, `"object"`
- a one-element array for a list: `["string"]`, or `[{ "title": "string" }]`
- a nested object: `{ "author": { "name": "string" } }`

```json
{
  "title": "string",
  "price": "number",
  "tags": ["string"],
  "reviews": [{ "user": "string", "stars": "number" }]
}
```

Only fields that are actually found on the page are returned; anything missing is `null` rather than guessed.

## Configuration

All configuration is via environment variables passed by your MCP client:

| Variable             | Required | Description |
| -------------------- | -------- | ----------- |
| `EXTRACTO_API_KEY`   | yes      | Your key from [app.getextracto.dev/keys](https://app.getextracto.dev/keys). |
| `EXTRACTO_BASE_URL`  | no       | Override the API host (defaults to `https://app.getextracto.dev`). |
| `EXTRACTO_TIMEOUT_MS`| no       | Per-request timeout in ms (default `90000`). |

## Development

```bash
npm install
npm run dev        # run from source with tsx
npm run typecheck
npm run build      # bundle to dist/ with tsup
```

## Related

- [`extracto`](https://www.npmjs.com/package/extracto) — the official TypeScript/JavaScript SDK.
- [getextracto.dev](https://getextracto.dev) — docs and API reference.

## License

MIT
