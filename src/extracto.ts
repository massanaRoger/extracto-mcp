// A small, dependency-free HTTP client for the Extracto API. It mirrors the
// behavior of the official `extracto` SDK (transient-error retries, stable error
// codes, request timeout) but is self-contained so this MCP server can ship and
// be versioned independently. The wire contract: POST /v1/extract with
// { url, schema, examples? }; async jobs under /v1/jobs.

const DEFAULT_BASE_URL = 'https://app.getextracto.dev';
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RETRIES = 2;

/** Error codes worth retrying: transient capacity, rate limits, and the network. */
const RETRYABLE = new Set([
  'timeout',
  'browser_unavailable',
  'model_error',
  'rate_limited',
  'ip_rate_limited',
  'network_error',
  'client_timeout',
]);

export interface ExtractoClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ExtractMeta {
  extractedInMs: number;
  cached: boolean;
  creditsUsed: number;
}

export interface ExtractResult {
  data: unknown;
  meta: ExtractMeta;
}

export type JobStatus = 'pending' | 'processing' | 'success' | 'failed';

export interface JobAccepted {
  id: string;
  status: 'pending';
  statusUrl: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  url: string;
  result: Record<string, unknown> | null;
  error: string | null;
  creditsUsed: number | null;
  createdAt: number;
  completedAt: number | null;
}

export interface ExtractExample {
  url?: string;
  output: Record<string, unknown>;
}

/** A schema descriptor is a type literal, a one-item array, or a nested object. */
export type SchemaDescriptor =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | SchemaDescriptor[]
  | { [k: string]: SchemaDescriptor };

export type ExtractoSchema = Record<string, SchemaDescriptor>;

/** The single error type this client throws. Branch on `.code` (stable). */
export class ExtractoApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly upgrade?: unknown;

  constructor(init: {
    code: string;
    message: string;
    status?: number;
    retryAfterSeconds?: number;
    upgrade?: unknown;
    cause?: unknown;
  }) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'ExtractoApiError';
    this.code = init.code;
    this.status = init.status;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.upgrade = init.upgrade;
    Object.setPrototypeOf(this, ExtractoApiError.prototype);
  }

  get isRetryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

interface RawJob {
  id: string;
  status: JobStatus;
  url: string;
  result?: Record<string, unknown> | null;
  error?: string | null;
  credits_used?: number | null;
  created_at?: number;
  completed_at?: number | null;
}

function toJob(raw: RawJob): Job {
  return {
    id: raw.id,
    status: raw.status,
    url: raw.url,
    result: raw.result ?? null,
    error: raw.error ?? null,
    creditsUsed: raw.credits_used ?? null,
    createdAt: raw.created_at ?? 0,
    completedAt: raw.completed_at ?? null,
  };
}

function codeFromStatus(status: number): string {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 402:
      return 'quota_exceeded';
    case 429:
      return 'rate_limited';
    case 503:
      return 'browser_unavailable';
    default:
      return 'internal_error';
  }
}

function errorFromBody(status: number, body: unknown): ExtractoApiError {
  const b = (body ?? {}) as Record<string, unknown>;
  const err = (b.error ?? {}) as Record<string, unknown>;
  const code = typeof err.code === 'string' ? err.code : codeFromStatus(status);
  const message =
    typeof err.message === 'string' && err.message
      ? err.message
      : `Request failed with status ${status}.`;
  return new ExtractoApiError({
    code,
    message,
    status,
    retryAfterSeconds:
      typeof b.retry_after_seconds === 'number' ? b.retry_after_seconds : undefined,
    upgrade: b.upgrade ?? undefined,
  });
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ExtractoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: ExtractoClientOptions) {
    if (!options?.apiKey) {
      throw new ExtractoApiError({
        code: 'unauthorized',
        message: 'An apiKey is required. Get one at https://app.getextracto.dev/keys.',
      });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /** Synchronous extraction. Returns the typed-shape data plus call metadata. */
  async extract(params: {
    url: string;
    schema: ExtractoSchema;
    examples?: ExtractExample[];
  }): Promise<ExtractResult> {
    const body = JSON.stringify({
      url: params.url,
      schema: params.schema,
      ...(params.examples ? { examples: params.examples } : {}),
    });
    const ok = await this.requestWithRetries<{
      data: unknown;
      extracted_in_ms?: number;
      cached?: boolean;
      credits_used?: number;
    }>('POST', '/v1/extract', body);
    return {
      data: ok.data,
      meta: {
        extractedInMs: typeof ok.extracted_in_ms === 'number' ? ok.extracted_in_ms : 0,
        cached: ok.cached === true,
        creditsUsed: typeof ok.credits_used === 'number' ? ok.credits_used : 1,
      },
    };
  }

  /** Submit an async job for a heavy or anti-bot page. Returns immediately. */
  async createJob(params: {
    url: string;
    schema: ExtractoSchema;
    examples?: ExtractExample[];
    webhookUrl?: string;
    idempotencyKey?: string;
  }): Promise<JobAccepted> {
    const body = JSON.stringify({
      url: params.url,
      schema: params.schema,
      ...(params.examples ? { examples: params.examples } : {}),
      ...(params.webhookUrl ? { webhook_url: params.webhookUrl } : {}),
    });
    const raw = await this.requestWithRetries<{
      id: string;
      status: 'pending';
      status_url: string;
    }>('POST', '/v1/jobs', body, params.idempotencyKey ? { 'Idempotency-Key': params.idempotencyKey } : undefined);
    return { id: raw.id, status: raw.status, statusUrl: raw.status_url };
  }

  /** Fetch a job's current status and (once done) its result. */
  async getJob(id: string): Promise<Job> {
    const raw = await this.requestWithRetries<RawJob>(
      'GET',
      `/v1/jobs/${encodeURIComponent(id)}`,
    );
    return toJob(raw);
  }

  /** List your recent jobs, newest first. */
  async listJobs(): Promise<Job[]> {
    const raw = await this.requestWithRetries<{ jobs: RawJob[] }>('GET', '/v1/jobs');
    return (raw.jobs ?? []).map(toJob);
  }

  private async requestWithRetries<T>(
    method: string,
    path: string,
    body?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.requestOnce<T>(method, path, body, extraHeaders);
      } catch (err) {
        const retryable = err instanceof ExtractoApiError && err.isRetryable;
        if (!retryable || attempt >= this.maxRetries) throw err;
        const wait =
          (err as ExtractoApiError).retryAfterSeconds != null
            ? (err as ExtractoApiError).retryAfterSeconds! * 1000
            : backoffMs(attempt);
        await sleep(wait);
        attempt++;
      }
    }
  }

  private async requestOnce<T>(
    method: string,
    path: string,
    body?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...extraHeaders,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError' || controller.signal.aborted;
      throw new ExtractoApiError({
        code: aborted ? 'client_timeout' : 'network_error',
        message: aborted
          ? `Request timed out after ${this.timeoutMs}ms.`
          : `Network request failed: ${(err as Error)?.message ?? String(err)}`,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ExtractoApiError({
        code: 'internal_error',
        message: `Unexpected non-JSON response (HTTP ${res.status}).`,
        status: res.status,
      });
    }
    if (!res.ok) throw errorFromBody(res.status, parsed);
    return parsed as T;
  }
}
