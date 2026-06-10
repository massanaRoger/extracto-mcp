#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ExtractoClient } from './extracto.js';
import { buildServer } from './server.js';

// Configuration comes from the environment, which is how MCP clients (Claude
// Desktop, Cursor, Claude Code, etc.) pass per-server config.
//   EXTRACTO_API_KEY   (required) your key from https://app.getextracto.dev/keys
//   EXTRACTO_BASE_URL  (optional) override the API host
//   EXTRACTO_TIMEOUT_MS(optional) per-request timeout in ms
async function main(): Promise<void> {
  const apiKey = process.env.EXTRACTO_API_KEY?.trim();
  if (!apiKey) {
    process.stderr.write(
      'extracto-mcp: missing EXTRACTO_API_KEY. Get a key at https://app.getextracto.dev/keys ' +
        'and set it in your MCP client config.\n',
    );
    process.exit(1);
  }

  const timeoutEnv = process.env.EXTRACTO_TIMEOUT_MS;
  const timeoutMs = timeoutEnv ? Number(timeoutEnv) : undefined;

  const client = new ExtractoClient({
    apiKey,
    baseUrl: process.env.EXTRACTO_BASE_URL?.trim() || undefined,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  });

  const server = buildServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The server now runs until the client closes the stdio stream.
  process.stderr.write('extracto-mcp: ready (stdio).\n');
}

main().catch((err) => {
  process.stderr.write(`extracto-mcp: fatal: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
