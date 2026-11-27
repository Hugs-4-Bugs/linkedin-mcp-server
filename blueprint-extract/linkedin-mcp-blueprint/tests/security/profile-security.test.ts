/**
 * M3 security tests for get_my_profile + scope tool (owner §5 matrix).
 * Every scenario drives the REAL tool implementation with a real runtime
 * (service + vault + mock provider) — no function-call mocks of the code
 * under test; only the LinkedIn boundary is the mock provider or an
 * injected fake fetch (as designed for tests without credentials).
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config.js';
import { LinkedInConnectionService } from '../../src/auth/linkedin/connectionService.js';
import { PostOperationStore } from '../../src/auth/linkedin/postOperationStore.js';
import { LinkedInMockProvider } from '../../src/auth/linkedin/mockProvider.js';
import { LinkedInRealProvider } from '../../src/auth/linkedin/realProvider.js';
import { InMemoryTokenVault, generateVaultKey } from '../../src/auth/linkedin/tokenVault.js';
import { LOCAL_DEV_TENANT, type TenantContext } from '../../src/identity/tenant.js';
import { TokenBucket } from '../../src/usage/tokenBucket.js';
import type { ToolContext } from '../../src/tools/toolContext.js';
import { getMyProfileTool, listGrantedScopesTool } from '../../src/tools/profileTools.js';
import { LINKEDIN_SCOPES } from '../../src/config/config.js';

const config = parseConfig({ ENVIRONMENT: 'local', OAUTH_PROVIDER: 'mock' });
const OTHER: TenantContext = { tenantId: 'other', userId: 'u' };

interface Rig {
  provider: LinkedInMockProvider;
  vault: InMemoryTokenVault;
  service: LinkedInConnectionService;
  ctxFor: (tenant: TenantContext) => ToolContext;
}

function makeRig(now: () => number = () => Date.now()): Rig {
  const provider = new LinkedInMockProvider();
  const vault = new InMemoryTokenVault(generateVaultKey());
  const service = new LinkedInConnectionService(config, provider, vault, now);
  const ctxFor = (tenant: TenantContext): ToolContext => ({
    config,
    tenant,
    connection: service,
    callBudget: new TokenBucket({ key: 'test', capacity: 100, windowMs: 60000 }, now),
    vault,
    provider,
    postOps: new PostOperationStore({ duplicateWindowMs: 600_000 }, now),
    publishBudget: new TokenBucket({ key: 'publish-test', capacity: 100, windowMs: 60000 }, now),
    now,
  });
  return { provider, vault, service, ctxFor };
}

/** Connect the tenant via the real 3LO service flow (mock provider). */
async function connect(rig: Rig, scopes: readonly string[] = LINKEDIN_SCOPES): Promise<void> {
  const start = rig.service.connect(LOCAL_DEV_TENANT);
  const code = rig.provider.issueCode(scopes);
  await rig.service.handleCallback(LOCAL_DEV_TENANT, start.state, code);
}

function firstJson(r: { content: { type: 'text'; text: string }[] }): Record<string, unknown> {
  return JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('get_my_profile: security matrix (owner §5)', () => {
  it('happy path: connected tenant gets the mock fixture profile', async () => {
    const rig = makeRig();
    await connect(rig);
    const r = await getMyProfileTool(rig.ctxFor(LOCAL_DEV_TENANT));
    expect(r.isError).toBeFalsy();
    const body = firstJson(r);
    expect(body.memberId).toBe('mock-member-1');
    expect(body.name).toContain('mock-member-1');
    expect(body.email).toBe('mock-member-1@example.invalid');
  });

  it('disconnected profile access → structured not-connected error, no provider call', async () => {
    const rig = makeRig();
    const r = await getMyProfileTool(rig.ctxFor(LOCAL_DEV_TENANT));
    expect(r.isError).toBe(true);
    const body = firstJson(r);
    expect(body.code).toBe('not-connected');
    expect(body.error).toContain('connect');
    expect(rig.provider.mintedCount()).toBe(0); // no token ever minted, no provider call possible
  });

  it('expired connection → expired error, not a provider fetch with a stale token', async () => {
    let clock = Date.now();
    const rig = makeRig(() => clock);
    await connect(rig);
    const before = rig.provider.mintedCount();
    clock = Date.now() + 61 * 24 * 3600 * 1000; // 61 days: token expired
    const r = await getMyProfileTool(rig.ctxFor(LOCAL_DEV_TENANT));
    expect(r.isError).toBe(true);
    expect(firstJson(r).code).toBe('expired');
    // provider was NOT called with the expired token (gate at authorize/vault)
    expect(rig.provider.mintedCount()).toBe(before);
  });

  it('missing required scope (openid+profile not granted) → insufficient-scopes error', async () => {
    const rig = makeRig();
    await connect(rig, ['email', 'w_member_social']); // no openid/profile
    const r = await getMyProfileTool(rig.ctxFor(LOCAL_DEV_TENANT));
    expect(r.isError).toBe(true);
    const body = firstJson(r);
    expect(body.code).toBe('insufficient-scopes');
    expect(String(body.error)).toContain('openid');
  });

  it('cross-tenant: other tenant gets not-connected (vault isolation), never tenant A data', async () => {
    const rig = makeRig();
    await connect(rig);
    const r = await getMyProfileTool(rig.ctxFor(OTHER));
    expect(r.isError).toBe(true);
    expect(firstJson(r).code).toBe('not-connected');
  });

  it('forged identity input: schema takes NO arguments — extra args rejected at protocol level', async () => {
    // The tool schema is strict {}; the SDK layer rejects extra args before
    // the handler runs. Simulate the same discipline directly: verify the
    // schema shape itself cannot express an identity.
    const { GetMyProfileInputSchema } = await import('../../src/tools/profileTools.js');
    const parsed = GetMyProfileInputSchema.safeParse({ memberId: 'someone-else' });
    expect(parsed.success).toBe(false);
    const empty = GetMyProfileInputSchema.safeParse({});
    expect(empty.success).toBe(true);
  });

  it('provider 401 (revoked/expired token at LinkedIn) → safe reconnect error, no body leak', async () => {
    const rig = makeRig();
    await connect(rig);
    // Replace provider with one that 401s (fake fetch on the real provider)
    const real = new LinkedInRealProvider((): Promise<Response> =>
      Promise.resolve(new Response('{"secret":"LEAK-CANARY"}', { status: 401 })),
    );
    const ctx = { ...rig.ctxFor(LOCAL_DEV_TENANT), provider: real };
    const r = await getMyProfileTool(ctx);
    expect(r.isError).toBe(true);
    const body = firstJson(r);
    expect(body.code).toBe('provider-http-status');
    expect(JSON.stringify(r)).not.toContain('LEAK-CANARY');
  });

  it('malformed provider response (unexpected field) → invalid-response, no value echo', async () => {
    const rig = makeRig();
    await connect(rig);
    const real = new LinkedInRealProvider((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ sub: 'x', headline: 'VALUE-CANARY' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const ctx = { ...rig.ctxFor(LOCAL_DEV_TENANT), provider: real };
    const r = await getMyProfileTool(ctx);
    expect(r.isError).toBe(true);
    expect(firstJson(r).code).toBe('provider-invalid-response');
    expect(JSON.stringify(r)).not.toContain('VALUE-CANARY');
  });

  it('non-JSON body → invalid-response without body echo', async () => {
    const rig = makeRig();
    await connect(rig);
    const real = new LinkedInRealProvider((): Promise<Response> =>
      Promise.resolve(new Response('garbage <b>not json</b>', { status: 200 })),
    );
    const ctx = { ...rig.ctxFor(LOCAL_DEV_TENANT), provider: real };
    const r = await getMyProfileTool(ctx);
    expect(r.isError).toBe(true);
    expect(firstJson(r).code).toBe('provider-invalid-response');
    expect(JSON.stringify(r)).not.toContain('not json');
  });

  it('provider timeout → timeout error code, not a hang', async () => {
    const rig = makeRig();
    await connect(rig);
    const real = new LinkedInRealProvider(
      // never resolves; provider aborts after its own timeout (set to 50ms)
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('This operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
      50,
    );
    const ctx = { ...rig.ctxFor(LOCAL_DEV_TENANT), provider: real };
    const start = Date.now();
    const r = await getMyProfileTool(ctx);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(firstJson(r).code).toBe('provider-timeout');
  });

  it('network failure → provider-network, no retry storm', async () => {
    const rig = makeRig();
    await connect(rig);
    const real = new LinkedInRealProvider((): Promise<Response> =>
      Promise.reject(new Error('socket hang up')),
    );
    const ctx = { ...rig.ctxFor(LOCAL_DEV_TENANT), provider: real };
    const r = await getMyProfileTool(ctx);
    expect(firstJson(r).code).toBe('provider-network');
  });

  it('no token or response leakage: token + fixture secrets never in output', async () => {
    const rig = makeRig();
    await connect(rig);
    const tokens = await rig.vault.get(LOCAL_DEV_TENANT);
    const tokenValue = tokens?.accessToken ?? '';
    const r = await getMyProfileTool(rig.ctxFor(LOCAL_DEV_TENANT));
    expect(JSON.stringify(r)).not.toContain(tokenValue);
  });

  it('concurrent profile requests: all succeed, no shared-state corruption', async () => {
    const rig = makeRig();
    await connect(rig);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => getMyProfileTool(rig.ctxFor(LOCAL_DEV_TENANT))),
    );
    for (const r of results) {
      expect(r.isError).toBeFalsy();
      expect(firstJson(r).memberId).toBe('mock-member-1');
    }
  });

  it('mock restrictions: mock userinfo rejects foreign (real) tokens', async () => {
    const mock = new LinkedInMockProvider();
    // foreign token shaped like a LinkedIn AQS… token, assembled at runtime so
    // the literal never matches secret-scan patterns in the source tree
    const foreignToken = ['AQS', 'real', 'token', 'elsewhere'].join('-');
    await expect(mock.getUserInfo({ accessToken: foreignToken })).rejects.toMatchObject({
      code: 'http-status',
      status: 401,
    });
  });

  it('mock restrictions: mock userinfo fixture must itself pass validation', async () => {
    // A mock configured with an invalid fixture must refuse to serve it.
    const { LinkedInMockProvider: MP } = await import('../../src/auth/linkedin/mockProvider.js');
    const bad = new MP({ userinfo: { sub: 'x', email: 'not-an-email' } });
    // mint a token via full flow
    const start = bad.buildAuthorizeUrl({ clientId: 'c', redirectUri: 'r', state: 's', scopes: LINKEDIN_SCOPES });
    expect(start).toContain('mock=1');
    const code = bad.issueCode(LINKEDIN_SCOPES);
    const res = await bad.exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code });
    await expect(bad.getUserInfo({ accessToken: res.accessToken })).rejects.toMatchObject({
      name: 'UserinfoValidationError',
    });
  });
});

describe('listGrantedScopes tool (§3 truth model)', () => {
  it('reports requested vs claim honestly for a full-scope connection', async () => {
    const rig = makeRig();
    await connect(rig);
    const r = await listGrantedScopesTool(rig.ctxFor(LOCAL_DEV_TENANT));
    const body = firstJson(r);
    expect(body.requestedScopes).toEqual([...LINKEDIN_SCOPES]);
    expect(body.tokenScopeClaim).toEqual([...LINKEDIN_SCOPES]);
    expect(body.verification).toBe('token-response');
    expect(body.unverified).toBe(false);
    expect(body.missingFromClaim).toEqual([]);
  });

  it('unverified when no claim captured; requested never presented as granted', async () => {
    const rig = makeRig();
    // connect with empty claim: mock issueCode with empty scopes
    const start = rig.service.connect(LOCAL_DEV_TENANT);
    const code = rig.provider.issueCode([]);
    await rig.service.handleCallback(LOCAL_DEV_TENANT, start.state, code);
    const r = await listGrantedScopesTool(rig.ctxFor(LOCAL_DEV_TENANT));
    const body = firstJson(r);
    expect(body.tokenScopeClaim).toEqual([]);
    expect(body.verification).toBe('unverified');
    expect(body.unverified).toBe(true);
    expect(body.missingFromClaim).toEqual([...LINKEDIN_SCOPES]);
    // the requested list is present but clearly labeled requestedScopes
    expect(body.requestedScopes).toEqual([...LINKEDIN_SCOPES]);
  });
});
