export type LogLevel = "debug" | "info" | "log" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
}

const MAX_LOGS = 300;

let buffer: LogEntry[] = [];
let initialized = false;

function serialize(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function push(level: LogLevel, args: unknown[]) {
  buffer.push({
    level,
    message: serialize(args),
    timestamp: new Date().toISOString(),
  });
  if (buffer.length > MAX_LOGS) {
    buffer = buffer.slice(buffer.length - MAX_LOGS);
  }
}

/** Start capturing global console output into an in-memory ring buffer. */
export function initLogCapture() {
  if (initialized) return;
  if (typeof window === "undefined") return;
  initialized = true;

  const originals = {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.debug = (...args: unknown[]) => {
    push("debug", args);
    originals.debug(...args);
  };
  console.info = (...args: unknown[]) => {
    push("info", args);
    originals.info(...args);
  };
  console.log = (...args: unknown[]) => {
    push("log", args);
    originals.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    push("warn", args);
    originals.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    push("error", args);
    originals.error(...args);
  };
}

/** Return the most recent captured log entries (oldest first). */
export function getRecentLogs(limit = MAX_LOGS): LogEntry[] {
  if (limit >= buffer.length) return [...buffer];
  return buffer.slice(buffer.length - limit);
}

/** For tests: reset the capture buffer and allow re-initialization. */
export function _resetCapture() {
  buffer = [];
  initialized = false;
}
