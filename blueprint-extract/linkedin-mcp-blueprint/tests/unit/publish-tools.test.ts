/**
 * M4 tool-behavior tests: draft / preview / publish — validation outcomes,
 * confirmation gate, provider scripts (success, refusal, timeout, ambiguity),
 * duplicate protection, and budget enforcement. Deterministic mock provider;
 * real provider request shapes verified separately (publish-request-shape
 * tests) against injected fetch.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig, LINKEDIN_SCOPES } from '../../src/config/config.js';
import { LinkedInMockProvider } from '../../src/auth/linkedin/mockProvider.js';
import { LinkedInRealProvider, LINKEDIN_API_VERSION } from '../../src/auth/linkedin/realProvider.js';
import { LinkedInConnectionService } from '../../src/auth/linkedin/connectionService.js';
import { InMemoryTokenVault, generateVaultKey } from '../../src/auth/linkedin/tokenVault.js';
import { TokenBucket } from '../../src/usage/tokenBucket.js';
import {
  PostOperationStore,
  fingerprintPostText,
} from '../../src/auth/linkedin/postOperationStore.js';
import { LOCAL_DEV_TENANT, type TenantContext } from '../../src/identity/tenant.js';
import type { ToolContext } from '../../src/tools/toolContext.js';
import {
  DraftPostInputSchema,
  PublishPostInputSchema,
  draftPostTool,
  previewPostTool,
  publishPostTool,
} from '../../src/tools/publishTools.js';
import {
  reportPostText,
  validatePostText,
  POST_TEXT_MAX_LENGTH,
} from '../../src/tools/postValidation.js';

const config = parseConfig({ ENVIRONMENT: 'local', OAUTH_PROVIDER: 'mock' });
const OTHER: TenantContext = { tenantId: 'other', userId: 'u' };

interface Rig {
  provider: LinkedInMockProvider;
  vault: InMemoryTokenVault;
  service: LinkedInConnectionService;
  postOps: PostOperationStore;
  publishBudget: TokenBucket;
  ctxFor: (tenant: TenantContext) => ToolContext;
}

function makeRig(
  publishScript?: ConstructorParameters<typeof LinkedInMockProvider>[0]['publishScript'],
  now: () => number = () => Date.now(),
): Rig {
  const provider = new LinkedInMockProvider({ publishScript }, now);
  const vault = new InMemoryTokenVault(generateVaultKey());
  const service = new LinkedInConnectionService(config, provider, vault, now);
  const postOps = new PostOperationStore({ duplicateWindowMs: 600_000 }, now);
  const publishBudget = new TokenBucket(
    { key: 'publish-test', capacity: 3, windowMs: 60000 },
    now,
  );
  const ctxFor = (tenant: TenantContext): ToolContext => ({
    config,
    tenant,
    connection: service,
    callBudget: new TokenBucket({ key: 'test', capacity: 100, windowMs: 60000 }, now),
    vault,
    provider,
    postOps,
    publishBudget,
    now,
  });
  return { provider, vault, service, postOps, publishBudget, ctxFor };
}

async function connect(rig: Rig, scopes: readonly string[] = LINKEDIN_SCOPES): Promise<void> {
  const start = rig.service.connect(LOCAL_DEV_TENANT);
  const code = rig.provider.issueCode(scopes);
  await rig.service.handleCallback(LOCAL_DEV_TENANT, start.state, code);
}

function bodyOf(r: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('post text validation (verified API constraints)', () => {
  it('accepts normal text', () => {
    expect(validatePostText('Hello LinkedIn!')).toBe('Hello LinkedIn!');
  });
  it('rejects text over 3000 characters (code too-long)', () => {
    expect(() => validatePostText('x'.repeat(POST_TEXT_MAX_LENGTH + 1))).toThrow(
      expect.objectContaining({ code: 'too-long' }),
    );
  });
  it('rejects blank/whitespace-only text (code blank)', () => {
    expect(() => validatePostText('   ')).toThrow(
      expect.objectContaining({ code: 'blank' }),
    );
  });
  it('rejects control characters (code control-chars)', () => {
    expect(() => validatePostText('bad\u0000char')).toThrow(
      expect.objectContaining({ code: 'control-chars' }),
    );
  });
  it('reportPostText aggregates every problem at once', () => {
    const r = reportPostText('x'.repeat(POST_TEXT_MAX_LENGTH + 1));
    expect(r.valid).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain('too-long');
    expect(r.remaining).toBe(0);
  });
});

describe('linkedin_draft_post', () => {
  it('returns a structured draft + preview without any provider call', () => {
    const rig = makeRig();
    const r = draftPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'Draft post text' });
    const body = bodyOf(r);
    expect(r.isError).toBeUndefined();
    expect((body.draft as Record<string, unknown>).valid).toBe(true);
    expect(body.preview).toBe('Draft post text');
    expect(body.persistence).toContain('none');
    expect(rig.provider.publishCount()).toBe(0);
    expect(rig.provider.mintedCount()).toBe(0);
  });
  it('reports validation failures without throwing', () => {
    const rig = makeRig();
    const r = draftPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: '' });
    expect(r.isError).toBe(true);
    const body = bodyOf(r);
    expect(body.valid).toBe(false);
  });
  it('works while disconnected (local-only tool)', () => {
    const rig = makeRig(); // never connected
    const r = draftPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'hi' });
    expect(r.isError).toBeUndefined();
  });
  it('schema rejects extra fields (strict)', () => {
    expect(() => DraftPostInputSchema.parse({ text: 'x', author: 'urn:li:person:1' })).toThrow();
  });
});

describe('linkedin_preview_post', () => {
  it('returns the exact submission payload with author from the connection', async () => {
    const rig = makeRig();
    await connect(rig);
    const r = await previewPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'Preview me' });
    const body = bodyOf(r);
    const sub = body.exactSubmission as Record<string, unknown>;
    expect(sub.author).toMatch(/^urn:li:person:mock-member-/);
    expect(sub.commentary).toBe('Preview me');
    expect(sub.visibility).toBe('PUBLIC');
    expect(sub.lifecycleState).toBe('PUBLISHED');
    expect((sub.distribution as Record<string, unknown>).feedDistribution).toBe('MAIN_FEED');
    expect(rig.provider.publishCount()).toBe(0);
  });
  it('marks the author unresolved when not connected (no fabricated identity)', async () => {
    const rig = makeRig();
    const r = await previewPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'x' });
    const body = bodyOf(r);
    expect(body.authorIdentity).toBe('no connection');
    expect((body.exactSubmission as Record<string, unknown>).author).toContain('not connected');
  });
});

describe('linkedin_publish_post — confirmation gate', () => {
  it('schema rejects confirm:false before any code runs', async () => {
    const rig = makeRig();
    await connect(rig);
    expect(() => PublishPostInputSchema.parse({ text: 'x', confirm: false })).toThrow();
    expect(rig.provider.publishCount()).toBe(0);
  });
  it('schema rejects a missing confirm key entirely', async () => {
    const rig = makeRig();
    await connect(rig);
    expect(() => PublishPostInputSchema.parse({ text: 'x' })).toThrow();
    expect(rig.provider.publishCount()).toBe(0);
  });
});

describe('linkedin_publish_post — outcomes', () => {
  it('successful mock publication: confirmed, URN returned, ledger success', async () => {
    const rig = makeRig({ mode: 'success' });
    await connect(rig);
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'Real post', confirm: true });
    const body = bodyOf(r);
    expect(r.isError).toBeUndefined();
    expect(body.published).toBe(true);
    expect(body.postUrn).toMatch(/^urn:li:share:[0-9]+$/);
    expect(rig.provider.publishCount()).toBe(1);
    expect(rig.postOps.stateOf(LOCAL_DEV_TENANT.tenantId, fingerprintPostText('Real post'))).toBe('success');
  });
  it('provider 4xx refusal → write-rejected, failure recorded, no URN', async () => {
    const rig = makeRig({ mode: 'reject-4xx', status: 422 });
    await connect(rig);
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'dup', confirm: true });
    const body = bodyOf(r);
    expect(r.isError).toBe(true);
    expect(body.code).toBe('provider-write-rejected');
    expect(rig.provider.publishCount()).toBe(0);
    expect(rig.postOps.stateOf(LOCAL_DEV_TENANT.tenantId, fingerprintPostText('dup'))).toBe('failure');
  });
  it('provider timeout → ambiguous outcome, never retried automatically', async () => {
    const rig = makeRig({ mode: 'timeout' });
    await connect(rig);
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'slow', confirm: true });
    const body = bodyOf(r);
    expect(r.isError).toBe(true);
    expect(body.code).toBe('ambiguous');
    expect(String(body.error)).toContain('may or may not');
    expect(rig.provider.publishCount()).toBe(0);
    expect(rig.postOps.stateOf(LOCAL_DEV_TENANT.tenantId, fingerprintPostText('slow'))).toBe('ambiguous');
  });
  it('ambiguous outcome blocks the identical content resubmit (suspect-after-ambiguous)', async () => {
    const rig = makeRig({ mode: 'timeout' });
    await connect(rig);
    await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'slow', confirm: true });
    // switch the script to success — a caller retrying blind after a timeout
    // must STILL be refused: the post may already exist.
    rig.provider.options.publishScript = { mode: 'success' };
    const r2 = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'slow', confirm: true });
    const body = bodyOf(r2);
    expect(body.code).toBe('duplicate-suspect-after-ambiguous');
    expect(rig.provider.publishCount()).toBe(0); // never re-sent
  });
  it('provider 503 → ambiguous (5xx treated as unknown outcome)', async () => {
    const rig = makeRig({ mode: 'ambiguous-5xx' });
    await connect(rig);
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'x1', confirm: true });
    expect(bodyOf(r).code).toBe('ambiguous');
  });
  it('invalid URN in 201 → invalid-response (boundary validation catches it)', async () => {
    const rig = makeRig({ mode: 'bad-urn' });
    await connect(rig);
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'bad urn', confirm: true });
    const body = bodyOf(r);
    expect(r.isError).toBe(true);
    expect(body.code).toBe('provider-invalid-response');
  });
  it('identical content within the window → duplicate-recent-identical', async () => {
    const rig = makeRig({ mode: 'success' });
    await connect(rig);
    await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'once', confirm: true });
    const r2 = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'once', confirm: true });
    expect(bodyOf(r2).code).toBe('duplicate-recent-identical');
    expect(rig.provider.publishCount()).toBe(1); // sent exactly once
  });
  it('different content after a success → publishes again (window is content-bound)', async () => {
    const rig = makeRig({ mode: 'success' });
    await connect(rig);
    await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'first', confirm: true });
    const r2 = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'second', confirm: true });
    expect(bodyOf(r2).published).toBe(true);
    expect(rig.provider.publishCount()).toBe(2);
  });
  it('daily publish budget exhaustion → rate-limited, provider untouched', async () => {
    const rig = makeRig({ mode: 'success' });
    await connect(rig);
    for (let i = 0; i < 3; i += 1) {
      await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: `post ${String(i)}`, confirm: true });
    }
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'post 3', confirm: true });
    const body = bodyOf(r);
    expect(body.code).toBe('rate-limited');
    expect(rig.provider.publishCount()).toBe(3); // budget = 3 in this rig
  });
  it('invalid content never reaches the provider', async () => {
    const rig = makeRig({ mode: 'success' });
    await connect(rig);
    const r = await publishPostTool(
      rig.ctxFor(LOCAL_DEV_TENANT),
      { text: 'x'.repeat(POST_TEXT_MAX_LENGTH + 1), confirm: true },
    );
    expect(bodyOf(r).code).toBe('invalid-content-too-long');
    expect(rig.provider.publishCount()).toBe(0);
  });
});

describe('linkedin_publish_post — authorization states', () => {
  it('disconnected → not-connected, no provider call', async () => {
    const rig = makeRig();
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'x', confirm: true });
    expect(bodyOf(r).code).toBe('not-connected');
    expect(rig.provider.publishCount()).toBe(0);
  });
  it('missing w_member_social scope → insufficient-scopes', async () => {
    const rig = makeRig();
    await connect(rig, ['openid', 'profile', 'email']); // no w_member_social
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'x', confirm: true });
    expect(bodyOf(r).code).toBe('insufficient-scopes');
    expect(rig.provider.publishCount()).toBe(0);
  });
  it('expired connection → expired, stale token never used', async () => {
    let clock = 1_000_000_000_000;
    const rig = makeRig(undefined, () => clock);
    await connect(rig);
    clock += 61 * 24 * 3600 * 1000; // past the 60-day expiry
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'x', confirm: true });
    expect(bodyOf(r).code).toBe('expired');
    expect(rig.provider.publishCount()).toBe(0);
  });
  it('cross-tenant: other tenant is not-connected — tenant A tokens never leak', async () => {
    const rig = makeRig();
    await connect(rig);
    const r = await publishPostTool(rig.ctxFor(OTHER), { text: 'x', confirm: true });
    expect(bodyOf(r).code).toBe('not-connected');
    expect(rig.provider.publishCount()).toBe(0);
  });
  it('unresolved author identity (pending sub) → identity-unresolved refusal', async () => {
    const rig = makeRig();
    await connect(rig);
    // simulate the real-provider 'pending' sub until userinfo confirms it
    await rig.vault.put(LOCAL_DEV_TENANT, {
      accessToken: 'mock-token-pending-sub',
      expiresAt: Date.now() + 3_600_000,
      scopes: LINKEDIN_SCOPES,
      memberSub: 'pending',
    });
    const r = await publishPostTool(rig.ctxFor(LOCAL_DEV_TENANT), { text: 'x', confirm: true });
    expect(bodyOf(r).code).toBe('identity-unresolved');
    expect(rig.provider.publishCount()).toBe(0);
  });
});

describe('real provider publish request shape (injected fetch)', () => {
  function fake201(urn: string) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      await Promise.resolve(); // async by fetch contract
      return new Response(null, {
        status: 201,
        headers: { 'x-restli-id': urn },
      });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  it('sends the verified request: endpoint, headers, body schema', async () => {
    const { calls, fetchImpl } = fake201('urn:li:share:6844785523593134080');
    const provider = new LinkedInRealProvider(fetchImpl);
    const result = await provider.publishPost({
      accessToken: 'token-x',
      memberSub: 'sub-123',
      text: 'Hello from the test',
    });
    expect(result.confirmed).toBe(true);
    expect(result.postUrn).toBe('urn:li:share:6844785523593134080');
    expect(calls.length).toBe(1);
    const c = calls[0] as unknown as { url: string; init: RequestInit };
    expect(c.url).toBe('https://api.linkedin.com/rest/posts');
    const headers = c.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer token-x');
    expect(headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(headers['linkedin-version']).toBe(LINKEDIN_API_VERSION);
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(c.init.body as string) as Record<string, unknown>;
    expect(body.author).toBe('urn:li:person:sub-123');
    expect(body.commentary).toBe('Hello from the test');
    expect(body.visibility).toBe('PUBLIC');
    expect(body.lifecycleState).toBe('PUBLISHED');
  });
  it('201 without x-restli-id → invalid-response (no URN, no success claim)', async () => {
    const { fetchImpl } = fake201('');
    const provider = new LinkedInRealProvider(fetchImpl);
    await expect(
      provider.publishPost({ accessToken: 't', memberSub: 's', text: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it('403 → write-rejected with status', async () => {
    const fetchImpl = (() => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    const provider = new LinkedInRealProvider(fetchImpl);
    await expect(
      provider.publishPost({ accessToken: 't', memberSub: 's', text: 'x' }),
    ).rejects.toMatchObject({ code: 'write-rejected', status: 403 });
  });
  it('503 → http-status ambiguous-classified (outcome unknown)', async () => {
    const fetchImpl = (() => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const provider = new LinkedInRealProvider(fetchImpl);
    await expect(
      provider.publishPost({ accessToken: 't', memberSub: 's', text: 'x' }),
    ).rejects.toMatchObject({ code: 'http-status', status: 503 });
  });
  it('request-body content never appears in the error message', async () => {
    const fetchImpl = (() => new Response('secret-body-content', { status: 422 })) as unknown as typeof fetch;
    const provider = new LinkedInRealProvider(fetchImpl);
    let message = '';
    try {
      await provider.publishPost({ accessToken: 't', memberSub: 's', text: 'unique-post-body-xyz' });
    } catch (err) {
      message = err instanceof Error ? err.message : '';
    }
    expect(message).not.toContain('unique-post-body-xyz');
    expect(message).not.toContain('secret-body-content');
  });
});
