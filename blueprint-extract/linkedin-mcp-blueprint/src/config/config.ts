/**
 * Validated application configuration.
 *
 * Boundary rule (CODING_STANDARDS): all env input is parsed here with zod and
 * nothing else in the codebase reads process.env directly. Invalid config
 * fails fast at startup instead of failing mid-request.
 */
import * as z from 'zod/v4';

export const ENVIRONMENTS = ['local', 'staging'] as const;
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
  // Cross-field rule: local must not bind beyond loopback; staging needs 0.0.0.0 allowed.
  if (cfg.ENVIRONMENT === 'local' && !['127.0.0.1', 'localhost', '::1'].includes(cfg.HTTP_HOST)) {
    throw new ConfigError([
      { path: ['HTTP_HOST'], message: `local environment must bind loopback, got ${cfg.HTTP_HOST}` },
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
