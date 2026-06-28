// ─────────────────────────────────────────────────────────────────────────────
// Logger — Pino Structured Logging
// ─────────────────────────────────────────────────────────────────────────────
// Creates and exports a singleton Pino logger instance used across the entire backend.
//
// Features:
//   - Log level configurable via LOG_LEVEL env var (default: 'info')
//   - Base context includes service name and environment on every log line
//   - ISO 8601 timestamps for consistent log parsing
//   - In non-production: uses pino-pretty for colorized, human-readable output
//   - In production: outputs newline-delimited JSON for log aggregation (Loki, etc.)
//
// Usage:
//   import logger from './lib/logger';
//   logger.info('message');
//   logger.error({ err }, 'context message');
//   logger.warn({ ip }, 'warning message');
// ─────────────────────────────────────────────────────────────────────────────

import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",               // Log level: trace/debug/info/warn/error/fatal
  base: { service: "softshape-backend", env: process.env.NODE_ENV },  // Added to every log line
  timestamp: pino.stdTimeFunctions.isoTime,             // ISO 8601 timestamp format
  // In development/staging: use pino-pretty for readable colorized output
  ...(process.env.NODE_ENV !== "production" && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true },
    },
  }),
});

export default logger;
