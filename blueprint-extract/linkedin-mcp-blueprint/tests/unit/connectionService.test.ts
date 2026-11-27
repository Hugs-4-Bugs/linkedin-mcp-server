/**
 * M2 unit tests: LinkedInConnectionService lifecycle with the mock provider
 * (owner directive: mock OAuth, no credentials needed), plus real-provider
 * URL/token behaviors against an injected fake fetch (no network).
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config.js';
import { LinkedInConnectionService, CallbackError, RateLimitError } from '../../src/auth/linkedin/connectionService.js';
import { LinkedInMockProvider } from '../../src/auth/linkedin/mockProvider.js';
import { LinkedInRealProvider } from '../../src/auth/linkedin/realProvider.js';
import { ProviderError } from '../../src/auth/linkedin/provider.js';
import { InMemoryTokenVault, generateVaultKey } from '../../src/auth/linkedin/tokenVault.js';
import { LOCAL_DEV_TENANT } from '../../src/identity/tenant.js';
import { LINKEDIN_SCOPES } from '../../src/config/config.js';

const config = parseConfig({ ENVIRONMENT: 'local', OAUTH_PROVIDER: 'mock' });

function makeService(): { service: LinkedInConnectionService; provider: LinkedInMockProvider } {
  const provider = new LinkedInMockProvider();
  const vault = new InMemoryTokenVault(generateVaultKey());
  const service = new LinkedInConnectionService(config, provider, vault);
  return { service, provider };
}

describe('connection service (mock provider)', () => {
  it('connect() returns a LinkedIn-shaped authorization URL with state+scopes', async () => {
    const { service } = makeService();
    const start = await service.connect(LOCAL_DEV_TENANT);
    const url = new URL(start.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('state')).toBe(start.state);
    expect(url.searchParams.get('scope')).toBe(LINKEDIN_SCOPES.join(' '));
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('full happy path: callback seals tokens; status shows connected', async () => {
    const { service, provider } = makeService();
    const start = await service.connect(LOCAL_DEV_TENANT);
    const code = provider.issueCode(LINKEDIN_SCOPES);
    const status = await service.handleCallback(LOCAL_DEV_TENANT, start.state, code);
    expect(status.connected).toBe(true);
    expect(status.scopes).toEqual([...LINKEDIN_SCOPES]);
    expect(status.expiresAt).toBeGreaterThan(Date.now());

    const after = await service.status(LOCAL_DEV_TENANT);
    expect(after.connected).toBe(true);
    expect(after.scopes).toEqual([...LINKEDIN_SCOPES]);
    expect(after.expiresAt).toBe(status.expiresAt);
  });

  it('callback with wrong state is rejected and leaves no tokens', async () => {
    const { service, provider } = makeService();
    await service.connect(LOCAL_DEV_TENANT);
    const code = provider.issueCode(LINKEDIN_SCOPES);
    await expect(
      service.handleCallback(LOCAL_DEV_TENANT, 'forged-state', code),
    ).rejects.toThrow(CallbackError);
    expect((await service.status(LOCAL_DEV_TENANT)).connected).toBe(false);
  });

  it('callback state is single-use: replay fails even with a fresh code', async () => {
    const { service, provider } = makeService();
    const start = await service.connect(LOCAL_DEV_TENANT);
    const code = provider.issueCode(LINKEDIN_SCOPES);
    await service.handleCallback(LOCAL_DEV_TENANT, start.state, code);
    const code2 = provider.issueCode(LINKEDIN_SCOPES);
    await expect(
      service.handleCallback(LOCAL_DEV_TENANT, start.state, code2),
    ).rejects.toThrow(/unknown state/);
  });

  it('mock codes are single-use: exchanging twice fails', async () => {
    const { service, provider } = makeService();
    const start = await service.connect(LOCAL_DEV_TENANT);
    const code = provider.issueCode(LINKEDIN_SCOPES);
    await service.handleCallback(LOCAL_DEV_TENANT, start.state, code);
    const start2 = await service.connect(LOCAL_DEV_TENANT);
    await expect(
      service.handleCallback(LOCAL_DEV_TENANT, start2.state, code),
    ).rejects.toThrow(/invalid-grant|unknown or already-used/);
  });

  it('disconnect deletes tokens; status then disconnected', async () => {
    const { service, provider } = makeService();
    const start = await service.connect(LOCAL_DEV_TENANT);
    const code = provider.issueCode(LINKEDIN_SCOPES);
    await service.handleCallback(LOCAL_DEV_TENANT, start.state, code);
    expect(await service.disconnect(LOCAL_DEV_TENANT)).toBe(true);
    expect((await service.status(LOCAL_DEV_TENANT)).connected).toBe(false);
  });

  it('expired tokens report disconnected', async () => {
    const provider = new LinkedInMockProvider();
    const vault = new InMemoryTokenVault(generateVaultKey());
    let clock = Date.now();
    const service = new LinkedInConnectionService(
      config,
      provider,
      vault,
      () => clock,
    );
    const start = await service.connect(LOCAL_DEV_TENANT);
    const code = provider.issueCode(LINKEDIN_SCOPES);
    await service.handleCallback(LOCAL_DEV_TENANT, start.state, code);
    clock = Date.now() + 61 * 24 * 3600 * 1000; // 61 days later
    expect((await service.status(LOCAL_DEV_TENANT)).connected).toBe(false);
    expect((await service.status(LOCAL_DEV_TENANT)).expiresAt).toBeNull();
  });

  it('connect is rate-limited (6 per 10 minutes per tenant)', async () => {
    const { service } = makeService();
    for (let i = 0; i < 6; i++) await service.connect(LOCAL_DEV_TENANT);
    await expect(service.connect(LOCAL_DEV_TENANT)).rejects.toThrow(RateLimitError);
  });

  it('rate limit is per tenant, not global', async () => {
    const { service } = makeService();
    const other = { tenantId: 'other', userId: 'u' };
    for (let i = 0; i < 6; i++) await service.connect(LOCAL_DEV_TENANT);
    await expect(service.connect(other)).resolves.toBeTruthy();
  });
});

describe('real provider (injected fetch, no network)', () => {
  const creds = {
    clientId: 'cli',
    clientSecret: 'sec',
    redirectUri: 'https://app.example.com/cb',
  };

  it('builds the official authorization URL', () => {
    const p = new LinkedInRealProvider();
    const url = new URL(p.buildAuthorizeUrl({ ...creds, state: 's', scopes: ['openid'] }));
    expect(url.toString().startsWith('https://www.linkedin.com/oauth/v2/authorization?')).toBe(true);
    expect(url.searchParams.get('client_id')).toBe('cli');
    expect(url.searchParams.get('state')).toBe('s');
  });

  it('exchanges a code for tokens on a 200 response', async () => {
    const fetchImpl = (): Promise<Response> =>
      new Response(
        JSON.stringify({ access_token: 'AQV-real', expires_in: 5184000, scope: 'openid profile' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const p = new LinkedInRealProvider(fetchImpl);
    const res = await p.exchangeCode({ ...creds, code: 'c' });
    expect(res.accessToken).toBe('AQV-real');
    expect(res.scopes).toEqual(['openid', 'profile']);
    expect(res.expiresAt).toBeGreaterThan(Date.now());
  });

  it('maps non-200 to ProviderError http-status without leaking body', async () => {
    const fetchImpl = (): Promise<Response> =>
      new Response('{"error":"invalid_grant","error_description":"SECRETS"}', { status: 400 });
    const p = new LinkedInRealProvider(fetchImpl);
    const err = await p.exchangeCode({ ...creds, code: 'bad' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('http-status');
    expect((err as Error).message).not.toContain('SECRETS');
  });

  it('maps network failure to ProviderError network', async () => {
    const fetchImpl = (): Promise<Response> => {
      throw new Error('boom');
    };
    const p = new LinkedInRealProvider(fetchImpl);
    await expect(p.exchangeCode({ ...creds, code: 'c' })).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('rejects malformed token responses', async () => {
    const fetchImpl = (): Promise<Response> =>
      new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } });
    const p = new LinkedInRealProvider(fetchImpl);
    await expect(p.exchangeCode({ ...creds, code: 'c' })).rejects.toMatchObject({
      code: 'invalid-response',
    });
    const noToken = (): Promise<Response> =>
      new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    const p2 = new LinkedInRealProvider(noToken);
    await expect(p2.exchangeCode({ ...creds, code: 'c' })).rejects.toMatchObject({
      code: 'invalid-response',
    });
  });
});
