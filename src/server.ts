import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ExtractoApiError,
  ExtractoClient,
  type ExtractoSchema,
  type ExtractExample,
} from './extracto.js';

const SCHEMA_HELP =
  'An object mapping each field name to a type. A type is one of the literals ' +
  '"string", "number", "boolean", "array", "object"; OR a one-element array for a list ' +
  '(e.g. ["string"] for a list of strings, or [{ "title": "string", "price": "number" }] ' +
  'for a list of objects); OR a nested object (e.g. { "author": { "name": "string" } }). ' +
  'Use the most specific shape you can. Example: ' +
  '{ "title": "string", "price": "number", "tags": ["string"], ' +
  '"reviews": [{ "user": "string", "stars": "number" }] }.';

// The schema field is a recursive shorthand; we accept it as an arbitrary record
// and let the API validate it (returning a clear `schema_invalid` message). A tight
// zod type here would fight the MCP client more than it would help.
const schemaShape = z
  .record(z.string(), z.any())
  .describe(SCHEMA_HELP);

const exampleShape = z
  .object({
    url: z.string().optional().describe('Optional source URL for context (never fetched).'),
    output: z
      .record(z.string(), z.any())
      .describe('A correctly shaped output matching your schema, used as few-shot guidance.'),
  });

/** Render a successful extraction as pretty JSON text for the model. */
function okText(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** Render an Extracto error as an MCP tool error the model can reason about. */
function errText(err: unknown): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  if (err instanceof ExtractoApiError) {
    const lines = [`Extracto error [${err.code}]: ${err.message}`];
    if (err.retryAfterSeconds != null) lines.push(`Retry after ${err.retryAfterSeconds}s.`);
    if (err.code === 'quota_exceeded' && err.upgrade) {
      lines.push(`Upgrade options: ${JSON.stringify(err.upgrade)}`);
    }
    if (err.code === 'unauthorized') {
      lines.push('Check that EXTRACTO_API_KEY is set to a valid key from https://app.getextracto.dev/keys.');
    }
    return { content: [{ type: 'text', text: lines.join(' ') }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Unexpected error: ${message}` }], isError: true };
}

export function buildServer(client: ExtractoClient): McpServer {
  const server = new McpServer({
    name: 'extracto',
    version: '0.1.0',
  });

  server.registerTool(
    'extract',
    {
      title: 'Extract structured data from a URL',
      description:
        'Extract structured data from a public web page and return it as validated, typed JSON. ' +
        'Extracto renders the page (JavaScript included), runs a schema-constrained extraction, and ' +
        'returns ONLY fields that match the schema. Missing data comes back as null rather than a ' +
        'hallucinated guess. Best for a single known URL. This call is synchronous (up to ~90s); for ' +
        'heavy or anti-bot pages prefer `extract_async`.',
      inputSchema: {
        url: z.string().url().describe('The public HTTPS URL to extract from.'),
        schema: schemaShape,
        examples: z
          .array(exampleShape)
          .max(3)
          .optional()
          .describe('Up to 3 few-shot examples to anchor the output format.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, schema, examples }) => {
      try {
        const result = await client.extract({
          url,
          schema: schema as ExtractoSchema,
          examples: examples as ExtractExample[] | undefined,
        });
        return okText(result);
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.registerTool(
    'extract_async',
    {
      title: 'Submit an async extraction job',
      description:
        'Submit an asynchronous extraction job for a heavy, slow, or anti-bot-protected page. ' +
        'Returns a job id immediately; poll it with `get_job` until status is "success" or "failed". ' +
        'Use this instead of `extract` when a page is large or likely to need stealth rendering.',
      inputSchema: {
        url: z.string().url().describe('The public HTTPS URL to extract from.'),
        schema: schemaShape,
        examples: z.array(exampleShape).max(3).optional().describe('Up to 3 few-shot examples.'),
        webhookUrl: z
          .string()
          .url()
          .optional()
          .describe('Optional URL to receive a signed callback when the job completes.'),
        idempotencyKey: z
          .string()
          .optional()
          .describe('Optional key; a retry with the same key replays the original job.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, schema, examples, webhookUrl, idempotencyKey }) => {
      try {
        const job = await client.createJob({
          url,
          schema: schema as ExtractoSchema,
          examples: examples as ExtractExample[] | undefined,
          webhookUrl,
          idempotencyKey,
        });
        return okText(job);
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.registerTool(
    'get_job',
    {
      title: 'Get an extraction job',
      description:
        'Fetch the current status and (once complete) the result of an async extraction job ' +
        'created with `extract_async`. Status is one of pending, processing, success, failed.',
      inputSchema: {
        id: z.string().describe('The job id returned by `extract_async`.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        return okText(await client.getJob(id));
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List recent extraction jobs',
      description: 'List your recent async extraction jobs, newest first.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return okText(await client.listJobs());
      } catch (err) {
        return errText(err);
      }
    },
  );

  return server;
}
