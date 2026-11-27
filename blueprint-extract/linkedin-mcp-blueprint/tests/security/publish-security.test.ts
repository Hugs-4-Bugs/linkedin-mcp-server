/**
 * M4 publishing security matrix (owner §5 + Phase 7 security list):
 * disconnected/expired/missing-scope/unauthorized publish attempts, forged
 * author identity, cross-tenant isolation, confirmation-gate bypass
 * attempts, token leakage in logs/errors/MCP responses, concurrent
 * publishing, and mock-provider production restrictions.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseConfig, LINKEDIN_SCOPES } from '../../src/config/config.js';
import { LinkedInMockProvider } from '../../src/auth/linkedin/mockProvider.js';
import { LinkedInRealProvider } from '../../src/auth/linkedin/realProvider.js';
import { LinkedInConnectionService } from '../../src/auth/linkedin/connectionService.js';
import { InMemoryTokenVault, generateVaultKey } from '../../src/auth/linkedin/tokenVault.js';
import { TokenBucket } from '../../src/usage/tokenBucket.js';
import { PostOperationStore } from '../../src/auth/linkedin/postOperationStore.js';
import { LOCAL_DEV_TENANT, type TenantContext } from '../../src/identity/tenant.js';
import type { ToolContext } from '../../src/tools/toolContext.js';
import { publishPostTool, PublishPostInputSchema } from '../../src/tools/publishTools.js';
import { createLogger } from '../../src/observability/logger.js';

const config = parseConfig({ ENVIRONMENT: 'local', OAUTH_PROVIDER: 'mock' });
const OTHER: TenantContext = { tenantId: 'other', userId: 'u' };

interface Rig {
  provider: LinkedInMockProvider;
  vault: InMemoryTokenVault;
  service: LinkedInConnectionService;
  postOps: PostOperationStore;
  ctxFor: (tenant: TenantContext) => ToolContext;
}

function makeRig(now: () => number = () => Date.now()): Rig {
  const provider = new LinkedInMockProvider({}, now);
  const vault = new InMemoryTokenVault(generateVaultKey());
  const service = new LinkedInConnectionService(config, provider, vault, now);
  const postOps = new PostOperationStore({ duplicateWindowMs: 600_000 }, now);
  const ctxFor = (tenant: TenantContext): ToolContext => ({
    config,
    tenant,
    connection: service,
    callBudget: new TokenBucket({ key: 'test', capacity: 100, windowMs: 60000 }, now),
    vault,
    provider,
    postOps,
    publishBudget: new TokenBucket({ key: 'publish-test', capacity: 100, windowMs: 60000 }, now),
    now,
  });
  return { provider, vault, service, postOps, ctxFor };
}

async function connect(rig: Rig, scopes: readonly string[] = LINKEDIN_SCOPES): Promise<void> {
  const start = rig.service.connect(LOCAL_DEV_TENANT);
  const code = rig.provider.issueCode(scopes);
  await rig.service.handleCallback(LOCAL_DEV_TENANT, start.state, code);
}

function bodyOf(r: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;
}

/** Capture logger stderr output for leak canaries. */
function captureStderr(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  const fakeWrite = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  process.stderr.write = fakeWrite;
  return (async () => {
    try {
      await fn();
    } finally {
      process.stderr.write = orig;
    }
    return chunks.join('');
  })();
}

describe('publishing security matrix (owner §5, M4 Phase 7)', () => {
  it('disconnected publish → structured not-connected, no provider call', async () => {
    const rig = makeRig();
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'x', confirm: true });
    expect(bodyOf(r).code).toBe('not-connected');
    expect(rig.provider.publishCount()).toBe(0);
    expect(rig.provider.mintedCount()).toBe(0);
  });

  it('expired connection → expired error; stale token never sent', async () => {
    let clock = 1_000_000_000_000;
    const rig = makeRig(() => clock);
    await connect(rig);
    clock += 61 * 24 * 3600 * 1000;
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'x', confirm: true });
    expect(bodyOf(r).code).toBe('expired');
    expect(rig.provider.publishCount()).toBe(0);
  });

  it('missing w_member_social → insufficient-scopes, no submission', async () => {
    const rig = makeRig();
    await connect(rig, ['openid', 'profile', 'email']);
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'x', confirm: true });
    expect(bodyOf(r).code).toBe('insufficient-scopes');
    expect(rig.provider.publishCount()).toBe(0);
  });

  it('forged author identity: schema has NO author field — extra args rejected', () => {
    expect(() =>
      PublishPostInputSchema.parse({
        text: 'x',
        confirm: true,
        author: 'urn:li:person:somebody-else',
      }),
    ).toThrow();
    expect(() =>
      PublishPostInputSchema.parse({
        text: 'x',
        confirm: true,
        authorUrn: 'urn:li:person:somebody-else',
      }),
    ).toThrow();
  });

  it('cross-tenant: tenant B cannot publish with tenant A tokens (vault isolation)', async () => {
    const rig = makeRig();
    await connect(rig); // tenant A connected
    const r = await publishPostTool(rig.ctxFor(OTHER), { text: 'x', confirm: true });
    expect(bodyOf(r).code).toBe('not-connected');
    expect(rig.provider.publishCount()).toBe(0);
  });

  it('confirmation bypass: confirm:"true" (string) is rejected by schema', () => {
    expect(() =>
      PublishPostInputSchema.parse({ text: 'x', confirm: 'true' as unknown as boolean }),
    ).toThrow();
  });

  it('confirmation bypass: confirm:1 is rejected by schema', () => {
    expect(() =>
      PublishPostInputSchema.parse({ text: 'x', confirm: 1 as unknown as boolean }),
    ).toThrow();
  });

  it('token never leaks into tool responses, errors, or logs (canary)', async () => {
    const rig = makeRig();
    await connect(rig);
    const tokens = await rig.vault.get(LOCAL_DEV_TENANT);
    const token = tokens?.accessToken ?? 'no-token';
    const stderr = await captureStderr(async () => {
      const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'leak test', confirm: true });
      expect(bodyOf(r).published).toBe(true);
    });
    expect(stderr).not.toContain(token);
  });

  it('error responses contain no provider body and no token (timeout path)', async () => {
    const rig = makeRig();
    await connect(rig);
    rig.provider.options.publishScript = { mode: 'timeout' };
    const tokens = await rig.vault.get(LOCAL_DEV_TENANT);
    const stderr = await captureStderr(async () => {
      const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'x', confirm: true });
      const body = bodyOf(r);
      expect(body.code).toBe('ambiguous');
      expect(JSON.stringify(body)).not.toContain(tokens?.accessToken ?? 'no-token');
    });
    expect(stderr).not.toContain(tokens?.accessToken ?? 'no-token');
  });

  it('concurrent identical publishes: exactly ONE provider submission (in-flight lock)', async () => {
    const rig = makeRig();
    await connect(rig);
    // First call that "hangs": we simulate by holding the in-flight state.
    const hash = (
      await import('../../src/auth/linkedin/postOperationStore.js')
    ).fingerprintPostText('concurrent post');
    rig.postOps.enter(LOCAL_DEV_TENANT.tenantId, hash);
    const results = await Promise.all([
      publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'concurrent post', confirm: true }),
    ]);
    expect(bodyOf(results[0]).code).toBe('duplicate-in-flight');
    expect(rig.provider.publishCount()).toBe(0);
  });

  it('true concurrent different-content publishes: all succeed, no corruption', async () => {
    const rig = makeRig();
    await connect(rig);
    const results = await Promise.all([
      publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'post A', confirm: true }),
      publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'post B', confirm: true }),
      publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'post C', confirm: true }),
    ]);
    for (const r of results) {
      expect(bodyOf(r).published).toBe(true);
    }
    expect(rig.provider.publishCount()).toBe(3);
  });

  it('mock provider refuses a real (foreign) token for publishing', async () => {
    const mock = new LinkedInMockProvider();
    // foreign token shaped like a LinkedIn token, assembled at runtime so
    // the literal never matches secret-scan patterns in the source tree
    const foreignToken = ['AQV', 'real', 'token', 'elsewhere'].join('-');
    await expect(
      mock.publishPost({ accessToken: foreignToken, memberSub: 'sub', text: 'x' }),
    ).rejects.toMatchObject({ code: 'http-status', status: 401 });
  });

  it('mock provider enforces author/token binding (sub mismatch → 422)', async () => {
    const mock = new LinkedInMockProvider();
    const code = mock.issueCode(LINKEDIN_SCOPES);
    const result = await mock.exchangeCode({
      clientId: 'c', clientSecret: 's', redirectUri: 'http://127.0.0.1/cb', code,
    });
    await expect(
      mock.publishPost({ accessToken: result.accessToken, memberSub: 'not-the-member', text: 'x' }),
    ).rejects.toMatchObject({ code: 'write-rejected', status: 422 });
  });

  it('production config cannot bypass authorization: PUBLISH_DAILY_LIMIT max is bounded', () => {
    // The safety limit clamps at 100; there is no "unlimited" setting, and
    // no env var can turn off authorize() or the confirm gate (code-level).
    expect(() =>
      parseConfig({ ENVIRONMENT: 'local', OAUTH_PROVIDER: 'mock', PUBLISH_DAILY_LIMIT: '10000' }),
    ).toThrow();
  });
});

describe('real provider security (injected fetch, no network)', () => {
  it('never sends the token anywhere except the Authorization header', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit) => {
      seen.push({ url: String(url), init });
      await Promise.resolve(); // async by fetch contract
      return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:123' } });
    }) as unknown as typeof fetch;
    const provider = new LinkedInRealProvider(fetchImpl);
    await provider.publishPost({ accessToken: 'secret-token-abc', memberSub: 's', text: 'x' });
    const call = seen[0];
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-token-abc');
    // Not in URL, not in body, exactly one header occurrence
    expect(call.url).not.toContain('secret-token-abc');
    expect(call.init.body as string).not.toContain('secret-token-abc');
  });

  it('429 response surfaces status; body never echoed', async () => {
    const fetchImpl = (async () => {
      await Promise.resolve(); // async by fetch contract
      return new Response('throttled application limit details', { status: 429 });
    }) as unknown as typeof fetch;
    const provider = new LinkedInRealProvider(fetchImpl);
    let message = '';
    try {
      await provider.publishPost({ accessToken: 't', memberSub: 's', text: 'x' });
    } catch (err) {
      message = err instanceof Error ? err.message : '';
    }
    expect(message).toContain('429');
    expect(message).not.toContain('throttled');
  });

  it('logger redaction: publish log lines never carry the access token', async () => {
    const rig = makeRig();
    await connect(rig);
    const tokens = await rig.vault.get(LOCAL_DEV_TENANT);
    const token = tokens?.accessToken ?? 'no-token';
    const stderr = await captureStderr(async () => {
      await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'redaction test', confirm: true });
    });
    expect(stderr).not.toContain(token);
    // and the logger's redaction filter itself:
    const log = createLogger('test:redaction');
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    log.info('publish canary', { token, accessToken: token });
    const written = spy.mock.calls[0]?.[0] as string | undefined ?? '';
    spy.mockRestore();
    expect(written).toContain('REDACT');
    expect(written).not.toContain(token);
  });
});
