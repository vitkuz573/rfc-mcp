/**
 * Typed error hierarchy. Every failure that can reach the model is expressed
 * as a stable machine code plus a short, redaction-safe message.
 */

export type ErrorCode =
  | "INVALID_SELECTOR"
  | "INVALID_ARGUMENT"
  | "INVALID_CURSOR"
  | "NOT_FOUND"
  | "NOT_CACHED"
  | "AMBIGUOUS_VERSION"
  | "CORPUS_UNAVAILABLE"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_CONTRACT"
  | "UPSTREAM_TOO_LARGE"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_BLOCKED"
  | "RATE_LIMITED"
  | "PARSE_FAILED"
  | "PARSE_DEGRADED"
  | "SNAPSHOT_STALE"
  | "CITATION_INVALID"
  | "LIMIT_EXCEEDED"
  | "CANCELLED"
  | "CONFLICT"
  | "INTERNAL";

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
  "RATE_LIMITED",
  "INTERNAL",
]);

export interface RfcMcpErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
  readonly retryable?: boolean;
  readonly warnings?: readonly string[];
}

export class RfcMcpError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;
  readonly warnings: readonly string[];

  constructor(code: ErrorCode, message: string, options: RfcMcpErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RfcMcpError";
    this.code = code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.warnings = options.warnings ?? [];
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(Object.keys(this.details).length > 0 ? { details: this.details } : {}),
      ...(this.warnings.length > 0 ? { warnings: [...this.warnings] } : {}),
    };
  }
}

export function isRfcMcpError(value: unknown): value is RfcMcpError {
  return value instanceof RfcMcpError;
}

export function errorCodeOf(value: unknown): ErrorCode {
  if (isRfcMcpError(value)) return value.code;
  return "INTERNAL";
}

export function invalidArgument(message: string, details?: Record<string, unknown>): RfcMcpError {
  return new RfcMcpError("INVALID_ARGUMENT", message, { details });
}

export function notFound(message: string, details?: Record<string, unknown>): RfcMcpError {
  return new RfcMcpError("NOT_FOUND", message, { details });
}

export function cancelled(reason = "Request cancelled"): RfcMcpError {
  return new RfcMcpError("CANCELLED", reason, { retryable: false });
}
