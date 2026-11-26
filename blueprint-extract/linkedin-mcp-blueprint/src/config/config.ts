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
  // M2 credentials: absent in M1; validated only when present.
  LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
  LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
  LINKEDIN_REDIRECT_URI: z.url().optional(),
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
  return cfg;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return parseConfig(env);
}
