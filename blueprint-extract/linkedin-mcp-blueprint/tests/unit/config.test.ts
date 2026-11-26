import { describe, expect, it } from 'vitest';
import { parseConfig, ConfigError, LINKEDIN_SCOPES } from '../../src/config/config.js';

describe('config validation', () => {
  it('accepts a minimal local env with defaults', () => {
    const cfg = parseConfig({ ENVIRONMENT: 'local' });
    expect(cfg.SERVER_NAME).toBe('linkedin-mcp-server');
    expect(cfg.SERVER_VERSION).toBe('0.1.0');
    expect(cfg.HTTP_HOST).toBe('127.0.0.1');
    expect(cfg.HTTP_PORT).toBe(3333);
  });

  it('rejects an unknown environment', () => {
    expect(() => parseConfig({ ENVIRONMENT: 'production' })).toThrow(ConfigError);
    expect(() => parseConfig({ ENVIRONMENT: 'production' })).toThrow(/ENVIRONMENT/);
  });

  it('rejects non-loopback bind in local environment', () => {
    expect(() => parseConfig({ ENVIRONMENT: 'local', HTTP_HOST: '0.0.0.0' })).toThrow(ConfigError);
  });

  it('allows non-loopback bind only in staging', () => {
    const cfg = parseConfig({ ENVIRONMENT: 'staging', HTTP_HOST: '0.0.0.0' });
    expect(cfg.HTTP_HOST).toBe('0.0.0.0');
  });

  it('rejects malformed semver and bad ports', () => {
    expect(() => parseConfig({ ENVIRONMENT: 'local', SERVER_VERSION: 'x.y' })).toThrow(ConfigError);
    expect(() => parseConfig({ ENVIRONMENT: 'local', HTTP_PORT: '99999' })).toThrow(ConfigError);
  });

  it('rejects a bad redirect URI when present', () => {
    expect(() =>
      parseConfig({ ENVIRONMENT: 'local', LINKEDIN_REDIRECT_URI: 'not-a-url' }),
    ).toThrow(ConfigError);
  });

  it('pins the self-serve LinkedIn scope set (ADR-012)', () => {
    expect([...LINKEDIN_SCOPES]).toEqual(['openid', 'profile', 'email', 'w_member_social']);
  });
});
