/**
 * Small, dependency-free primitives shared by every layer.
 */

import { createHash } from "node:crypto";
import { RfcMcpError } from "./errors.js";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(input: string, length = 24): string {
  return sha256Hex(input).slice(0, length);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

export function contentHash(value: unknown): string {
  return `sha256:${sha256Hex(stableJson(value))}`;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function utf8Size(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const buffer = Buffer.from(text, "utf8");
  const slice = buffer.subarray(0, maxBytes);
  // Do not split a UTF-8 sequence.
  let end = slice.length;
  while (end > 0 && (slice[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > 0 && (slice[end - 1]! & 0x80) !== 0) end -= 1;
  return { text: slice.subarray(0, end).toString("utf8"), truncated: true };
}

/** Neutralize control characters that could corrupt a transcript or log line. */
export function sanitizeSnippet(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === "\n" || char === "\t") {
      out += char;
    } else if (code < 0x20 || code === 0x7f) {
      out += " ";
    } else if (code >= 0x80 && code <= 0x9f) {
      out += " ";
    } else {
      out += char;
    }
  }
  return out.replace(/[ ]{3,}/g, "  ").trim();
}

export function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function base64UrlDecode(value: string): string {
  const buffer = Buffer.from(value, "base64url");
  if (buffer.toString("base64url") !== value.replace(/=+$/u, "")) {
    throw new RfcMcpError("INVALID_CURSOR", "Cursor is not valid base64url");
  }
  return buffer.toString("utf8");
}

/**
 * Opaque, integrity-bound cursor. The payload never leaves the server, and the
 * binding string makes a cursor unusable for a different query or corpus
 * generation.
 */
export interface CursorPayload {
  readonly o: number;
  readonly g: number;
  readonly b: string;
  readonly x?: Record<string, string | number | boolean>;
}

export function encodeCursor(payload: CursorPayload, secret: string): string {
  const body = stableJson(payload);
  const mac = sha256Hex(`${secret}\n${body}`).slice(0, 16);
  return `${base64UrlEncode(body)}.${mac}`;
}

export function decodeCursor(cursor: string, secret: string, binding: string): CursorPayload {
  const [body, mac] = cursor.split(".");
  if (!body || !mac) throw new RfcMcpError("INVALID_CURSOR", "Cursor is malformed");
  const expected = sha256Hex(`${secret}\n${base64UrlDecode(body)}`).slice(0, 16);
  if (expected !== mac) throw new RfcMcpError("INVALID_CURSOR", "Cursor failed integrity check");
  const parsed = JSON.parse(base64UrlDecode(body)) as CursorPayload;
  if (parsed.b !== binding) {
    throw new RfcMcpError("INVALID_CURSOR", "Cursor belongs to a different query or corpus generation");
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Text offsets                                                                */
/* -------------------------------------------------------------------------- */

export interface OffsetPoint {
  readonly byte: number;
  readonly codepoint: number;
}

/**
 * Maps an ordered set of UTF-16 char offsets to byte and code point offsets
 * in a single O(n) pass. Used so every quote can be located in the raw bytes
 * of the published file as well as in the decoded text.
 */
export function mapCharOffsets(text: string, charOffsets: readonly number[]): Map<number, OffsetPoint> {
  const result = new Map<number, OffsetPoint>();
  if (charOffsets.length === 0) return result;
  const sorted = [...new Set(charOffsets)].sort((a, b) => a - b);
  let cursor = 0;
  let byte = 0;
  let codepoint = 0;

  for (const target of sorted) {
    if (target < 0 || target > text.length) {
      throw new RfcMcpError("PARSE_FAILED", `Char offset ${target} is outside the source text`);
    }
    while (cursor < target) {
      const code = text.codePointAt(cursor)!;
      const size = code > 0xffff ? 2 : 1;
      cursor += size;
      byte += code > 0x7f ? (code > 0xffff ? 4 : utf8Size(String.fromCodePoint(code))) : 1;
      codepoint += 1;
    }
    result.set(target, { byte, codepoint });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Async helpers                                                               */
/* -------------------------------------------------------------------------- */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RfcMcpError("CANCELLED", "Request cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RfcMcpError("CANCELLED", "Request cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}
