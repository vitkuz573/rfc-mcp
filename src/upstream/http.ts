/**
 * Guarded HTTP client.
 *
 * Policies enforced here (not in individual tools):
 *  - deny-by-default host allowlist, HTTPS only, no user-supplied URLs;
 *  - conditional requests with ETag / Last-Modified and a local HTTP cache;
 *  - stale-while-error semantics: a stale copy is returned with a warning when
 *    the upstream is unreachable, never silently as "current";
 *  - bounded response size, bounded time, bounded per-host concurrency;
 *  - retry with exponential backoff and Retry-After for 429/5xx only;
 *  - cancellation propagates from the MCP request.
 */

import { RfcMcpError, cancelled } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { isoNow, Semaphore, sleep } from "../core/util.js";

export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "www.rfc-editor.org",
  "errata.rfc-editor.org",
  "datatracker.ietf.org",
]);

export interface HttpCacheEntry {
  readonly url: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Uint8Array;
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

export interface HttpCachePort {
  read(url: string): HttpCacheEntry | undefined;
  write(entry: HttpCacheEntry): void;
  remove(url: string): void;
}

export interface HttpClientOptions {
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxConcurrency: number;
  readonly defaultTtlMs: number;
  readonly negativeTtlMs: number;
  readonly logger: Logger;
  readonly cache: HttpCachePort;
  readonly fetchImpl?: typeof fetch;
  readonly offline?: boolean;
}

export interface HttpRequest {
  readonly url: string;
  readonly accept: readonly string[];
  readonly label: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly ttlMs?: number;
  readonly signal?: AbortSignal;
  readonly allowNotFound?: boolean;
  readonly revalidate?: boolean;
}

export interface HttpResult {
  readonly url: string;
  readonly status: number;
  readonly body: Buffer;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly retrievedAt: string;
  readonly fromCache: boolean;
  readonly revalidated: boolean;
  readonly notModified: boolean;
  readonly warnings: readonly string[];
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export class HttpClient {
  private readonly options: HttpClientOptions;
  private readonly limiters = new Map<string, Semaphore>();
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private limiterFor(host: string): Semaphore {
    let limiter = this.limiters.get(host);
    if (!limiter) {
      limiter = new Semaphore(this.options.maxConcurrency);
      this.limiters.set(host, limiter);
    }
    return limiter;
  }

  async get(request: HttpRequest): Promise<HttpResult> {
    const url = assertAllowedUrl(request.url).toString();
    const ttl = request.ttlMs ?? this.options.defaultTtlMs;
    const cached = this.options.cache.read(url);

    if (cached) {
      const fresh = Date.parse(cached.expiresAt) > Date.now();
      if (fresh && request.revalidate !== true) {
        return resultFromCache(cached, { warnings: [] });
      }
    }

    if (this.options.offline) {
      if (cached) {
        return resultFromCache(cached, { warnings: ["offline_served_from_cache"] });
      }
      throw new RfcMcpError("UPSTREAM_BLOCKED", "Offline mode: no cached copy is available", {
        details: { url, label: request.label },
        retryable: false,
      });
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (request.signal?.aborted) throw cancelled();
      try {
        const response = await this.limiterFor(new URL(url).host).run(() =>
          this.fetchOnce(new URL(url), request, cached),
        );
        if (response.kind === "not-modified") {
          const refreshed: HttpCacheEntry = {
            ...cached!,
            fetchedAt: isoNow(),
            expiresAt: new Date(Date.now() + ttl).toISOString(),
          };
          this.options.cache.write(refreshed);
          return resultFromCache(refreshed, { warnings: ["served_after_conditional_revalidation"] });
        }
        if (response.kind === "body") {
          const entry: HttpCacheEntry = {
            url,
            etag: response.etag,
            lastModified: response.lastModified,
            status: response.status,
            contentType: response.contentType,
            body: response.body,
            fetchedAt: isoNow(),
            expiresAt: new Date(Date.now() + ttl).toISOString(),
          };
          if (response.status === 404) {
            if (!request.allowNotFound) {
              this.options.cache.write(entry);
              throw new RfcMcpError("NOT_FOUND", "Upstream document not found", {
                details: { url, label: request.label },
                retryable: false,
              });
            }
            this.options.cache.write(entry);
            return {
              url,
              status: 404,
              body: Buffer.alloc(0),
              contentType: null,
              etag: null,
              lastModified: null,
              retrievedAt: entry.fetchedAt,
              fromCache: false,
              revalidated: false,
              notModified: false,
              warnings: ["upstream_not_found"],
            };
          }
          this.options.cache.write(entry);
          return {
            url,
            status: response.status,
            body: response.body,
            contentType: response.contentType,
            etag: response.etag,
            lastModified: response.lastModified,
            retrievedAt: entry.fetchedAt,
            fromCache: false,
            revalidated: cached !== undefined,
            notModified: false,
            warnings: [],
          };
        }
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === MAX_ATTEMPTS) break;
        const delay = retryDelay(error, attempt);
        this.options.logger.warn("http.retry", { url, label: request.label, attempt, delayMs: delay });
        await sleep(delay, request.signal);
      }
    }

    if (cached) {
      this.options.logger.warn("http.served_stale", { url, label: request.label, error: describe(lastError) });
      return resultFromCache(cached, { warnings: ["stale_cache_served_after_upstream_failure"] });
    }
    throw normalizeError(lastError, url, request.label);
  }

  async getJson<T>(request: HttpRequest): Promise<{ value: T; result: HttpResult }> {
    const result = await this.get(request);
    let value: T;
    try {
      value = JSON.parse(result.body.toString("utf8")) as T;
    } catch (error) {
      throw new RfcMcpError("UPSTREAM_CONTRACT", "Upstream response is not valid JSON", {
        details: { url: result.url, label: request.label, bytes: result.body.byteLength },
        cause: error,
      });
    }
    return { value, result };
  }

  private async fetchOnce(
    url: URL,
    request: HttpRequest,
    cached: HttpCacheEntry | undefined,
  ): Promise<
    | { kind: "not-modified" }
    | {
        kind: "body";
        status: number;
        body: Buffer;
        etag: string | null;
        lastModified: string | null;
        contentType: string | null;
      }
  > {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs;
    const timer = setTimeout(
      () => controller.abort(new RfcMcpError("UPSTREAM_TIMEOUT", "Upstream request timed out")),
      timeoutMs,
    );
    const signals: AbortSignal[] = [controller.signal];
    if (request.signal) signals.push(request.signal);

    try {
      const headers: Record<string, string> = {
        accept: request.accept.join(", "),
        "user-agent": this.options.userAgent,
        "accept-encoding": "identity",
      };
      if (cached?.etag) headers["if-none-match"] = cached.etag;
      if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;

      const response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: AbortSignal.any(signals),
      });

      if (response.status === 304 && cached) return { kind: "not-modified" };
      if (RETRY_STATUS.has(response.status)) {
        throw new RfcMcpError(
          response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
          `Upstream returned ${response.status}`,
          { details: { url: request.url, retryAfter: response.headers.get("retry-after") } },
        );
      }
      if (response.status !== 200 && response.status !== 404) {
        throw new RfcMcpError("UPSTREAM_UNAVAILABLE", `Upstream returned ${response.status}`, {
          details: { url: request.url, status: response.status },
          retryable: response.status >= 500,
        });
      }

      const maxBytes = request.maxBytes ?? this.options.maxBytes;
      const declared = response.headers.get("content-length");
      if (declared && Number.parseInt(declared, 10) > maxBytes) {
        throw new RfcMcpError("UPSTREAM_TOO_LARGE", "Upstream response exceeds the configured size limit", {
          details: { url: request.url, declared, maxBytes },
          retryable: false,
        });
      }

      const body = await readBounded(response, maxBytes, request.url);
      return {
        kind: "body",
        status: response.status,
        body,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        contentType: response.headers.get("content-type"),
      };
    } catch (error) {
      if (request.signal?.aborted) throw cancelled();
      if (error instanceof RfcMcpError) throw error;
      if (isAbortError(error)) {
        throw new RfcMcpError("UPSTREAM_TIMEOUT", "Upstream request timed out", { details: { url: request.url } });
      }
      throw new RfcMcpError("UPSTREAM_UNAVAILABLE", "Upstream request failed", {
        details: { url: request.url, reason: describe(error) },
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/* -------------------------------------------------------------------------- */

export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RfcMcpError("UPSTREAM_BLOCKED", "Malformed upstream URL", {
      details: { url: raw.slice(0, 200) },
      retryable: false,
    });
  }
  if (url.protocol !== "https:") {
    throw new RfcMcpError("UPSTREAM_BLOCKED", "Only https upstream URLs are allowed", {
      details: { url: raw.slice(0, 200) },
      retryable: false,
    });
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new RfcMcpError("UPSTREAM_BLOCKED", `Host is not on the allowlist: ${url.hostname}`, {
      details: { url: raw.slice(0, 200) },
      retryable: false,
    });
  }
  return url;
}

async function readBounded(response: Response, maxBytes: number, url: string): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RfcMcpError("UPSTREAM_TOO_LARGE", "Upstream response exceeds the configured size limit", {
        details: { url, maxBytes },
        retryable: false,
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function resultFromCache(entry: HttpCacheEntry, options: { warnings: readonly string[] }): HttpResult {
  return {
    url: entry.url,
    status: entry.status,
    body: Buffer.from(entry.body),
    contentType: entry.contentType,
    etag: entry.etag,
    lastModified: entry.lastModified,
    retrievedAt: entry.fetchedAt,
    fromCache: true,
    revalidated: false,
    notModified: false,
    warnings: options.warnings,
  };
}

function isRetryable(error: unknown): boolean {
  return error instanceof RfcMcpError && error.retryable;
}

function retryDelay(error: unknown, attempt: number): number {
  if (error instanceof RfcMcpError) {
    const retryAfter = error.details.retryAfter;
    if (typeof retryAfter === "string") {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(250, seconds * 1000));
    }
  }
  const base = 400 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 250);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function normalizeError(error: unknown, url: string, label: string): RfcMcpError {
  if (error instanceof RfcMcpError) {
    if (error.details.url === undefined) {
      return new RfcMcpError(error.code, error.message, {
        details: { ...error.details, url },
        retryable: error.retryable,
        cause: error,
      });
    }
    return error;
  }
  return new RfcMcpError("UPSTREAM_UNAVAILABLE", "Upstream request failed", {
    details: { url, label, reason: describe(error) },
    cause: error,
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return String(error).slice(0, 300);
}
