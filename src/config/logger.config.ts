import { ConsoleLogger, LogLevel } from '@nestjs/common';

// Ordered from most to least severe; LOG_LEVEL enables its level and everything above it
const LEVELS: LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

export function resolveLogLevels(level = process.env.LOG_LEVEL): LogLevel[] {
  const normalized = (level === 'info' ? 'log' : level) as LogLevel;
  const index = LEVELS.indexOf(normalized);
  return LEVELS.slice(0, index === -1 ? LEVELS.indexOf('log') + 1 : index + 1);
}

/** JSON lines in production/staging (for log aggregation), pretty output otherwise. */
export function useJsonLogs(): boolean {
  if (process.env.LOG_FORMAT) {
    return process.env.LOG_FORMAT === 'json';
  }
  return ['production', 'staging'].includes(process.env.NODE_ENV ?? '');
}

export function createAppLogger(): ConsoleLogger {
  const json = useJsonLogs();
  return new ConsoleLogger({
    json,
    colors: !json,
    logLevels: resolveLogLevels(),
  });
}
