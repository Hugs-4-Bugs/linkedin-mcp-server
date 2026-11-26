/**
 * Redacting structured logger (SECURITY_CHECKLIST: "Tokens encrypted and
 * redacted"; LOGGING.md: no tokens/headers/bodies in logs).
 *
 * Hard rules:
 * - Writes ONLY to stderr. In stdio mode stdout is the MCP protocol channel
 *   and must never carry diagnostics (MCP_PROTOCOL_DESIGN.md).
 * - Known secret-looking values are replaced with `[REDACT]` before
 *   serialization, defense-in-depth against accidental leakage.
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SECRET_KEY_RE =
  /(token|secret|password|authorization|cookie|api[-_]?key|client[-_]?secret|refresh|credential|state|code)/i;

/**
 * Keys whose values must never be logged verbatim. `state`/`code` are OAuth
 * flow credentials (CSRF token / one-time grant); `code` matching is exact-key
 * only, since generic "code" fields elsewhere are often non-secret.
 */
const BANNED_KEYS = new Set([
  'authorization', 'access_token', 'client_secret', 'password', 'cookie',
  'code', 'state', 'authorizationcode', 'authorization_code', 'authcode',
]);

function redactValue(key: string, value: unknown): unknown {
  const k = key.toLowerCase();
  if (BANNED_KEYS.has(k) || SECRET_KEY_RE.test(k)) return '[REDACT]';
  if (typeof value === 'string') {
    // Bearer-looking strings get masked regardless of key.
    if (/^Bearer\s+/i.test(value)) return '[REDACT]';
  }
  return value;
}

export function redact(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>);
    } else {
      out[k] = redactValue(k, v);
    }
  }
  return out;
}

export interface Logger {
  debug(msg: string, payload?: Record<string, unknown>): void;
  info(msg: string, payload?: Record<string, unknown>): void;
  warn(msg: string, payload?: Record<string, unknown>): void;
  error(msg: string, payload?: Record<string, unknown>): void;
}

export function createLogger(scope: string, sink: (line: string) => void = defaultSink): Logger {
  const emit = (level: LogLevel, msg: string, payload?: Record<string, unknown>): void => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
      ...(payload ? { data: redact(payload) } : {}),
    };
    sink(JSON.stringify(entry));
  };
  return {
    debug: (m, p) => { emit('debug', m, p); },
    info: (m, p) => { emit('info', m, p); },
    warn: (m, p) => { emit('warn', m, p); },
    error: (m, p) => { emit('error', m, p); },
  };
}

/** Default sink: stderr only. */
function defaultSink(line: string): void {
  process.stderr.write(line + '\n');
}
