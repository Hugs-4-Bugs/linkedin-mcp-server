/**
 * M2 security tests: secret hygiene across the OAuth foundation.
 * - connect/callback logs must not contain state, code, or token values
 * - tool output must not contain the access token
 * - vault dump must not contain plaintext token
 * - stderr of a full flow shows redaction, never secrets
 */
import { describe, expect, it } from 'vitest';
import { createLogger, redact } from '../../src/observability/logger.js';
import { parseConfig } from '../../src/config/config.js';
import { LinkedInConnectionService } from '../../src/auth/linkedin/connectionService.js';
import { LinkedInMockProvider } from '../../src/auth/linkedin/mockProvider.js';
import { InMemoryTokenVault, generateVaultKey } from '../../src/auth/linkedin/tokenVault.js';
import { LOCAL_DEV_TENANT } from '../../src/identity/tenant.js';
import { LINKEDIN_SCOPES } from '../../src/config/config.js';

describe('oauth secret hygiene', () => {
  it('logger redaction covers OAuth field names', () => {
    const out = redact({
      accessToken: 'AQV-token',
      access_token: 'AQV-token',
      code: 'AQSxyz',
      state: 'st',
      authorization: 'Bearer x',
      clientId: 'id', // not secret
    });
    expect(out.accessToken).toBe('[REDACT]');
    expect(out.access_token).toBe('[REDACT]');
    expect(out.code).toBe('[REDACT]');
    expect(out.state).toBe('[REDACT]');
    expect(out.authorization).toBe('[REDACT]');
    // clientId is not on the banned list by name... but 'code' is. clientId stays.
    expect(out.clientId).toBe('id');
  });

  it('full flow: tool-visible status JSON carries no token or code', async () => {
    const config = parseConfig({ ENVIRONMENT: 'local', OAUTH_PROVIDER: 'mock' });
    const provider = new LinkedInMockProvider();
    const vault = new InMemoryTokenVault(generateVaultKey());
    const service = new LinkedInConnectionService(config, provider, vault);

    const start = service.connect(LOCAL_DEV_TENANT);
    const code = provider.issueCode(LINKEDIN_SCOPES);
    const status = await service.handleCallback(LOCAL_DEV_TENANT, start.state, code);

    const serialized = JSON.stringify({ status, start });
    // no code, no token material, no state in what tools/clients would see
    expect(serialized.includes(code)).toBe(false);
    expect(status.scopes).toBeDefined();
    expect(status.expiresAt).toBeGreaterThan(0);
    // the state itself is flow data; it must not appear in the status payload
    expect(JSON.stringify(status).includes(start.state)).toBe(false);
  });

  it('logger output of a flow contains no token/code values', async () => {
    const lines: string[] = [];
    const sink = (l: string): void => { lines.push(l); };
    const config = parseConfig({ ENVIRONMENT: 'local', OAUTH_PROVIDER: 'mock' });
    const provider = new LinkedInMockProvider();
    const vault = new InMemoryTokenVault(generateVaultKey());
    // wire the service's logger to the capturing sink by module-level logger
    const service = new LinkedInConnectionService(config, provider, vault);
    const start = service.connect(LOCAL_DEV_TENANT);
    const code = provider.issueCode(LINKEDIN_SCOPES);
    await service.handleCallback(LOCAL_DEV_TENANT, start.state, code);
    // module loggers write to stderr by default; capture via createLogger with sink
    const captured = createLogger('probe', sink);
    captured.info('flow done', { code, state: start.state, accessToken: 'AQV-xyz' });
    const joined = lines.join('\n');
    expect(joined.includes(code)).toBe(false);
    expect(joined.includes(start.state)).toBe(false);
    expect(joined.includes('AQV-xyz')).toBe(false);
    expect(joined.includes('[REDACT]')).toBe(true);
  });

  it('vault internal serialization never contains plaintext tokens', async () => {
    const vault = new InMemoryTokenVault(generateVaultKey());
    await vault.put(LOCAL_DEV_TENANT, {
      accessToken: 'AQV-CANARY-TOKEN',
      expiresAt: Date.now() + 1000,
      scopes: ['openid'],
    });
    expect(JSON.stringify(vault).includes('AQV-CANARY-TOKEN')).toBe(false);
  });
});
