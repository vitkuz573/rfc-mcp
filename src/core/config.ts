/**
 * Central configuration for the RFC MCP server.
 *
 * Everything is environment driven so the same build can run as a stdio MCP
 * server, as an offline corpus reader, or as a batch ingester.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface AppConfig {
  readonly productName: string;
  readonly version: string;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly offline: boolean;
  readonly userAgent: string;
  readonly httpTimeoutMs: number;
  readonly maxHttpBytes: number;
  readonly maxConcurrency: number;
  readonly logLevel: LogLevel;
  /** Cache TTL for mutable metadata endpoints. */
  readonly indexTimeoutMs: number;
  readonly metadataCacheTtlMs: number;
  /** Cache TTL for negative (404) lookups. */
  readonly negativeCacheTtlMs: number;
  /** Hard limits applied to every model-visible operation. */
  readonly limits: Limits;
  readonly parserVersion: string;
  readonly extractorVersion: string;
}

export interface Limits {
  readonly maxSearchResults: number;
  readonly maxOutputBytes: number;
  readonly maxQuoteChars: number;
  readonly maxContextChars: number;
  readonly maxBatchOperations: number;
  readonly maxGraphDepth: number;
  readonly maxGraphNodes: number;
  readonly maxGraphEdges: number;
  readonly maxDiffChanges: number;
  readonly maxQueryChars: number;
  readonly maxRawSliceBytes: number;
  readonly maxCitationPageSize: number;
  readonly maxRelationPageSize: number;
  readonly maxCompletionValues: number;
}

export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxSearchResults: 20,
  maxOutputBytes: 16 * 1024,
  maxQuoteChars: 1_200,
  maxContextChars: 240,
  maxBatchOperations: 10,
  maxGraphDepth: 1,
  maxGraphNodes: 100,
  maxGraphEdges: 200,
  maxDiffChanges: 50,
  maxQueryChars: 2_000,
  maxRawSliceBytes: 256 * 1024,
  maxCitationPageSize: 20,
  maxRelationPageSize: 100,
  maxCompletionValues: 20,
});

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be a boolean, got ${JSON.stringify(raw)}`);
}

function logLevelEnv(name: string, fallback: LogLevel): LogLevel {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  const allowed: LogLevel[] = ["debug", "info", "warn", "error", "silent"];
  if (!allowed.includes(raw as LogLevel)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  }
  return raw as LogLevel;
}

export function defaultDataDir(): string {
  const explicit = process.env.RFC_MCP_DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return path.join(path.resolve(xdg), "rfc-mcp");
  return path.join(os.homedir(), ".local", "share", "rfc-mcp");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = defaultDataDir();
  const version = readPackageVersion();
  return {
    productName: "ietf-rfc-mcp",
    version,
    dataDir,
    databasePath: path.join(dataDir, "corpus.sqlite"),
    offline: boolEnv("RFC_MCP_OFFLINE", false),
    userAgent: env.RFC_MCP_USER_AGENT?.trim() || `rfc-mcp/${version} (+https://opencode.ai)`,
    httpTimeoutMs: intEnv("RFC_MCP_HTTP_TIMEOUT_MS", 15_000, 500, 120_000),
    maxHttpBytes: intEnv("RFC_MCP_MAX_HTTP_BYTES", 16 * 1024 * 1024, 4 * 1024, 64 * 1024 * 1024),
    maxConcurrency: intEnv("RFC_MCP_MAX_CONCURRENCY", 4, 1, 16),
    logLevel: logLevelEnv("RFC_MCP_LOG_LEVEL", "info"),
    indexTimeoutMs: intEnv("RFC_MCP_INDEX_TIMEOUT_MS", 180_000, 5_000, 900_000),
    metadataCacheTtlMs: intEnv("RFC_MCP_METADATA_TTL_MS", 6 * 60 * 60 * 1000, 0, 7 * 24 * 60 * 60 * 1000),
    negativeCacheTtlMs: intEnv("RFC_MCP_NEGATIVE_TTL_MS", 60 * 60 * 1000, 0, 7 * 24 * 60 * 60 * 1000),
    limits: DEFAULT_LIMITS,
    parserVersion: "rfc-text-1.2.0",
    extractorVersion: "normative-2119-8174-1.0.0",
  };
}

let cachedVersion: string | undefined;

export function readPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  const candidates = ["../package.json", "../../package.json", "../../../package.json"];
  for (const relative of candidates) {
    try {
      const text = readFileSync(new URL(relative, import.meta.url), "utf8");
      const parsed = JSON.parse(text) as { name?: unknown; version?: unknown };
      if (parsed.name === "rfc-mcp" && typeof parsed.version === "string") {
        cachedVersion = parsed.version;
        return cachedVersion;
      }
    } catch {
      // Try the next candidate.
    }
  }
  cachedVersion = "0.0.0";
  return cachedVersion;
}

/** RFC identifiers are 1..5 digits with no leading zeros (RFC 9920 index model). */
export function parseRfcNumber(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || value > 99_999) {
      throw new Error(`Invalid RFC number: ${value}`);
    }
    return value;
  }
  const text = value.trim().replace(/^rfc/i, "");
  if (!/^[1-9]\d{0,4}$/.test(text)) {
    throw new Error(`Invalid RFC identifier: ${JSON.stringify(value)}`);
  }
  return Number.parseInt(text, 10);
}

export function rfcFileStem(rfc: number): string {
  return `rfc${rfc}`;
}
