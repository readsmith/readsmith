import { redactForLog } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * A minimal structured logger. Every field object is run through redaction
 * before emission, so a connection string, bearer token, or password can never
 * reach the log sink. Deterministic (no embedded timestamp) for testability;
 * the host's log collector adds time.
 */
export function createLogger(level: LogLevel = "info"): Logger {
  const min = RANK[level];
  const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (RANK[lvl] < min) return;
    const record = {
      level: lvl,
      msg: message,
      ...(fields ? { fields: redactForLog(fields) } : {}),
    };
    const line = JSON.stringify(record);
    if (lvl === "error") console.error(line);
    else if (lvl === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
