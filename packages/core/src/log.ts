// One JSON object per line on stdout/stderr: greppable in `docker logs`, parseable by
// any log shipper, and secret-safe because every field goes through redact().

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  readonly level: LogLevel;
}

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
  /** Defaults to console.log / console.error. */
  write?: (line: string, level: LogLevel) => void;
  now?: () => Date;
}

/** Keys whose values never reach the log, whatever their shape. */
const SECRET_KEY_RE =
  /(token|secret|password|passwd|credential|authorization|auth|cookie|signature|api[-_]?key|access[-_]?key|private[-_]?key|verifier|session)/i;
const REDACTED = '[redacted]';
const MAX_STRING = 2000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactValue(value.message, depth + 1, seen),
      ...(value.stack ? { stack: value.stack.split('\n').slice(0, 5).join('\n') } : {}),
      ...(value.cause ? { cause: redactValue(value.cause, depth + 1, seen) } : {}),
    };
  }
  if (value instanceof Uint8Array) return `[bytes ${value.byteLength}]`;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => redactValue(item, depth + 1, seen));
    return value.length > MAX_ARRAY ? [...items, `[+${value.length - MAX_ARRAY} more]`] : items;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key)) {
        out[key] = REDACTED;
        continue;
      }
      const redacted = redactValue(item, depth + 1, seen);
      if (redacted !== undefined) out[key] = redacted;
    }
    return out;
  }
  return String(value);
}

/** Deep copy with secret-looking keys replaced and long values truncated. */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const now = options.now ?? (() => new Date());
  const write =
    options.write ??
    ((line: string, lineLevel: LogLevel) => {
      if (lineLevel === 'error' || lineLevel === 'warn') console.error(line);
      else console.log(line);
    });

  const emit = (lineLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[lineLevel] < LEVEL_ORDER[level]) return;
    const payload = {
      time: now().toISOString(),
      level: lineLevel,
      msg: message,
      ...(redact({ ...base, ...(fields ?? {}) }) as LogFields),
    };
    let line: string;
    try {
      line = JSON.stringify(payload);
    } catch {
      line = JSON.stringify({ time: payload.time, level: lineLevel, msg: message, error: 'unserializable log fields' });
    }
    write(line, lineLevel);
  };

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger({ ...options, level, base: { ...base, ...fields } }),
  };
}
