/**
 * Validated application configuration.
 *
 * Boundary rule (CODING_STANDARDS): all env input is parsed here with zod and
 * nothing else in the codebase reads process.env directly. Invalid config
 * fails fast at startup instead of failing mid-request.
 */
import * as z from 'zod/v4';

export const ENVIRONMENTS = ['local', 'staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Fixed self-serve scope set (ADR-012, owner decision D-A1). */
export const LINKEDIN_SCOPES = ['openid', 'profile', 'email', 'w_member_social'] as const;

const ConfigSchema = z.object({
  ENVIRONMENT: z.enum(ENVIRONMENTS),
  SERVER_NAME: z.string().min(1).default('linkedin-mcp-server'),
  SERVER_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'SERVER_VERSION must be semver')
    .default('0.1.0'),
  HTTP_HOST: z.string().default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  // M2 OAuth provider selection: 'mock' (default in local) or 'linkedin' (real 3LO).
  OAUTH_PROVIDER: z.enum(['mock', 'linkedin']).default('mock'),
  // Real 3LO credentials (linkedin provider): all-or-none.
  LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
  LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
  LINKEDIN_REDIRECT_URI: z.url().optional(),
  // Token vault master key (base64, 32 bytes). Optional in local; required
  // whenever a token vault is constructed (ADR-008). Dev fallback: derived
  // ephemeral key generated at startup when unset — tokens then survive only
  // the process lifetime, which is acceptable for local dev only.
  TOKEN_VAULT_KEY: z.base64().optional(),
  // State store TTL for OAuth 'state' (seconds), default 600 (10 min).
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  // --- M4 publishing safety limits (application-level, NOT LinkedIn quotas) ---
  // LinkedIn publishes no numeric per-member/day quota in documentation
  // (Phase 2 finding, ADR-015). These are OUR conservative safety limits:
  // a per-tenant daily publication budget and a duplicate-content window.
  // They can tighten safety; they can NEVER widen authorization, scope or
  // confirmation requirements — those are code-enforced, not configurable.
  PUBLISH_DAILY_LIMIT: z.coerce.number().int().min(1).max(100).default(12),
  PUBLISH_DUPLICATE_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  // --- M5 persistence + remote authentication (ADR-018/019) ---
  // DATABASE_URL: postgres://... (staging/prod persistence) or
  // sqlite:file (local dev persistence). Unset = in-memory (M2–M4 behavior).
  DATABASE_URL: z.string().min(1).optional(),
  // Auth mode for the remote HTTP surface: 'session' (real, SQL-backed) or
  // 'mock' (deterministic tests only — REJECTED in staging/production).
  AUTH_MODE: z.enum(['session', 'mock']).default('session'),
  // Session lifetime (seconds), default 8h.
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(28800),
  // HTTP request body cap in MiB (default 1; MCP JSON-RPC is small).
  MAX_BODY_MIB: z.coerce.number().min(1).max(16).default(1),
  // Per-IP request rate limit (requests per minute, default 120).
  HTTP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(6000).default(120),
  // UI cookie name (session).
  SESSION_COOKIE_NAME: z.string().min(1).default('lkm_session'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: z.core.$ZodIssue[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  ${String(i.path)}: ${i.message}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parse configuration from a raw env-like mapping (default: process.env).
 * Exported for tests; `loadConfig()` is the production entry.
 */
export function parseConfig(raw: Record<string, string | undefined>): AppConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(result.error.issues);
  }
  const cfg = result.data;
  // Cross-field rule: local must not bind beyond loopback; staging and
  // production may bind 0.0.0.0 (behind a TLS-terminating proxy).
  if (cfg.ENVIRONMENT === 'local' && !['127.0.0.1', 'localhost', '::1'].includes(cfg.HTTP_HOST)) {
    throw new ConfigError([
      { path: ['HTTP_HOST'], message: `local environment must bind loopback, got ${cfg.HTTP_HOST}` },
    ] as never);
  }
  // --- M5 production fail-fast rules (ADR-019) ---
  // Production: no mock anything (auth or OAuth provider), persistence REQUIRED.
  if (cfg.ENVIRONMENT === 'production') {
    if (cfg.AUTH_MODE === 'mock') {
      throw new ConfigError([
        { path: ['AUTH_MODE'], message: 'production rejects mock authentication (fail-fast)' },
      ] as never);
    }
    if (cfg.OAUTH_PROVIDER === 'mock') {
      throw new ConfigError([
        { path: ['OAUTH_PROVIDER'], message: 'production rejects the mock OAuth provider (fail-fast)' },
      ] as never);
    }
    if (cfg.DATABASE_URL === undefined) {
      throw new ConfigError([
        { path: ['DATABASE_URL'], message: 'production requires persistent storage (fail-fast)' },
      ] as never);
    }
    if (cfg.TOKEN_VAULT_KEY === undefined) {
      throw new ConfigError([
        { path: ['TOKEN_VAULT_KEY'], message: 'production requires TOKEN_VAULT_KEY (fail-fast)' },
      ] as never);
    }
  }
  // Mock auth is tolerated ONLY in local (tests/local HTTP dev).
  if (cfg.AUTH_MODE === 'mock' && cfg.ENVIRONMENT !== 'local') {
    throw new ConfigError([
      { path: ['AUTH_MODE'], message: 'mock authentication is local-only (fail-fast)' },
    ] as never);
  }
  // Real LinkedIn provider requires the full credential triple.
  if (cfg.OAUTH_PROVIDER === 'linkedin') {
    const missing = [
      ['LINKEDIN_CLIENT_ID', cfg.LINKEDIN_CLIENT_ID],
      ['LINKEDIN_CLIENT_SECRET', cfg.LINKEDIN_CLIENT_SECRET],
      ['LINKEDIN_REDIRECT_URI', cfg.LINKEDIN_REDIRECT_URI],
    ]
      .filter(([, v]) => v === undefined)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new ConfigError([
        { path: ['OAUTH_PROVIDER'], message: `linkedin provider requires ${missing.join(', ')}` },
      ] as never);
    }
  }
  return cfg;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return parseConfig(env);
}
