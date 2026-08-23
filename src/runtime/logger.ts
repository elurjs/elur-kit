// --- Structured logger with request ID and Server-Timing (plan §12.3) ---
//
// Provides a structured logger that:
//   - Generates a unique request ID per request.
//   - Attaches the request ID to all log entries.
//   - Supports structured fields (not just string messages).
//   - Redacts sensitive data (cookies, auth headers, tokens).
//   - Supports Server-Timing header accumulation.
//
// OpenTelemetry/analytics are external integrations — no automatic telemetry.

import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_HEADERS = new Set([
  "cookie",
  "authorization",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);

export interface LogEntry {
  level: LogLevel;
  message: string;
  requestId?: string;
  timestamp: string;
  fields?: Record<string, unknown>;
}

export interface ServerTimingMetric {
  name: string;
  description?: string;
  durationMs: number;
}

export class StructuredLogger {
  private minLevel: LogLevel;
  private requestId: string;
  private timings: ServerTimingMetric[] = [];
  private entries: LogEntry[] = [];

  constructor(options: { minLevel?: LogLevel; requestId?: string } = {}) {
    this.minLevel = options.minLevel ?? (process.env.NODE_ENV === "production" ? "info" : "debug");
    this.requestId = options.requestId ?? randomUUID();
  }

  /** Returns the request ID for this logger instance. */
  getRequestId(): string {
    return this.requestId;
  }

  /** Logs a debug message. */
  debug(message: string, fields?: Record<string, unknown>): void {
    this.log("debug", message, fields);
  }

  /** Logs an info message. */
  info(message: string, fields?: Record<string, unknown>): void {
    this.log("info", message, fields);
  }

  /** Logs a warning. */
  warn(message: string, fields?: Record<string, unknown>): void {
    this.log("warn", message, fields);
  }

  /** Logs an error. */
  error(message: string, fields?: Record<string, unknown>): void {
    this.log("error", message, fields);
  }

  /** Records a Server-Timing metric. */
  timing(name: string, durationMs: number, description?: string): void {
    this.timings.push({ name, durationMs, description });
  }

  /** Starts a timer and returns a function to stop it and record the timing. */
  startTimer(name: string, description?: string): () => void {
    const start = performance.now();
    return () => {
      this.timing(name, performance.now() - start, description);
    };
  }

  /** Returns the Server-Timing header value. */
  getServerTimingHeader(): string {
    return this.timings
      .map((t) => {
        const desc = t.description ? `;desc="${t.description}"` : "";
        return `${t.name};dur=${t.durationMs.toFixed(1)}${desc}`;
      })
      .join(", ");
  }

  /** Returns all log entries collected so far. */
  getEntries(): readonly LogEntry[] {
    return this.entries;
  }

  private log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;

    const entry: LogEntry = {
      level,
      message,
      requestId: this.requestId,
      timestamp: new Date().toISOString(),
      fields: fields ? redactSensitive(fields) : undefined,
    };

    this.entries.push(entry);

    // Output to console in development, structured JSON in production.
    if (process.env.NODE_ENV === "production") {
      const output = JSON.stringify(entry);
      if (level === "error") console.error(output);
      else if (level === "warn") console.warn(output);
      else console.log(output);
    } else {
      const prefix = `[${level.toUpperCase()}]`;
      const fieldsStr = entry.fields ? " " + JSON.stringify(entry.fields) : "";
      const output = `${prefix} ${message}${fieldsStr}`;
      if (level === "error") console.error(output);
      else if (level === "warn") console.warn(output);
      else console.log(output);
    }
  }
}

/**
 * Redacts sensitive fields from a log fields object.
 * Recursively redacts keys that match sensitive header names.
 */
function redactSensitive(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lowerKey)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = redactSensitive(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Creates a logger for a request, optionally using the request's
 * X-Request-ID header if present.
 */
export function createRequestLogger(request?: Request, minLevel?: LogLevel): StructuredLogger {
  const requestId = request?.headers.get("X-Request-ID") ?? undefined;
  return new StructuredLogger({ minLevel, requestId });
}
