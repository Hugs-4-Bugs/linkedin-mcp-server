/**
 * M9 Phase 2 — billing UI contract tests (headless render of the REAL
 * compiled admin page, jsdom; fetch stubbed — no server needed).
 *
 * These are frontend tests of the actual shipped UI code:
 *   - navigation contains the Billing entry
 *   - dashboard branches: active subscription, quota exhaustion, empty
 *     (no subscription), billing-disabled (404 → self-hosted message),
 *     auth failure (401), server error, network error
 *   - plan grid renders ONLY server-catalog plans; current plan marked
 *   - checkout POST hits /api/billing/checkout with CSRF header and
 *     renders the payment-pending state (never an entitlement grant)
 *   - cancel flow: armed checkbox + confirm + CSRF + pending message
 *   - XSS: hostile plan ids are escaped
 *
 * Backend integration (real HTTP) is covered by billing-api-e2e.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { ADMIN_PAGE_HTML } from '../../src/mcp/transport/adminPage.js';

interface FetchLog {
  path: string;
  init?: RequestInit;
}

/** jsdom window handle, loosely typed: the page script runs inside jsdom's
 * VM context; the server tsconfig excludes DOM lib types, so we keep the
 * handle structural ({ fetch, eval, confirm, document }). */
interface PageWindow {
  fetch: typeof fetch;
  eval: (src: string) => unknown;
  confirm: () => boolean;
  document: Document;
}

let dom: JSDOM;
let doc: Document;
let w: PageWindow | undefined;
let calls: FetchLog[];

/** eval() inside the jsdom window: the page script's own scope. */
function inPage<T>(code: string): Promise<T> {
  // The JSDOM window exposes a VM context; running the page's functions
  // inside it resolves the script's own identifiers (renderBilling, M, …).
  if (w === undefined) throw new Error('page window not initialized');
  return Promise.resolve(w.eval(code) as T);
}

function respond(status: number, payload: unknown): void {
  if (w === undefined) throw new Error('page window not initialized');
  w.fetch = ((path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return Promise.resolve({
      status,
      json: () => Promise.resolve(payload),
    } as unknown as Response);
  }) as typeof fetch;
}

const SUMMARY_ACTIVE = {
  billingMode: 'hosted (test)',
  provider: 'razorpay',
  tenantId: 'tenant-abc',
  subscription: {
    subscriptionId: 'sub_e2e_1',
    planId: 'pro',
    providerStatus: 'active',
    entitlementStatus: 'active',
    graceEndsAt: null,
    updatedAt: 1_700_000_000_000,
    usable: true,
  },
  rawProviderStatus: 'active',
  usage: { counter: 'tool-calls', periodDays: 30, used: 4, limit: 500, remaining: 496, exhausted: false },
  plans: [
    { planId: 'pro', monthlyToolCalls: 500, priceInr: 999, currency: 'INR', billingInterval: 'monthly' },
    { planId: 'team', monthlyToolCalls: 5000, priceInr: 4999, currency: 'INR', billingInterval: 'monthly' },
  ],
  checkoutSupported: true,
};

const deepClone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

async function renderBillingView(): Promise<void> {
  await inPage<unknown>('renderBilling()');
  await new Promise((r) => { setTimeout(r, 40); });
}

beforeAll(() => {
  dom = new JSDOM(ADMIN_PAGE_HTML, {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:3333/admin',
    beforeParse(window) {
      // boot() hits /auth/state; neutralize it so tests drive views.
      window.fetch = () => Promise.resolve(new Response(JSON.stringify({ authenticated: false }), { status: 200, headers: { 'content-type': 'application/json' } }));
    },
  });
  w = dom.window as PageWindow;
  doc = dom.window.document;
  // Replace boot-triggered state: emulate an authenticated console user.
  void inPage<unknown>(`M.me = { tenantId: 'tenant-abc', username: 'u', via: 'session' }; M.csrf = 'tok-1';`);
  calls = [];
  respond(200, SUMMARY_ACTIVE);
});

describe('billing navigation (real page)', () => {
  it('console nav includes a Billing entry', () => {
    const nav = doc.querySelector('#nav-billing');
    expect(nav).not.toBeNull();
    expect(nav?.getAttribute('data-view')).toBe('billing');
  });
});

describe('billing dashboard states (real page logic)', () => {
  it('renders the active-subscription dashboard from server data only', async () => {
    respond(200, SUMMARY_ACTIVE);
    await renderBillingView();
    const html = doc.getElementById('main')?.innerHTML ?? '';
    expect(html).toContain('Current subscription');
    expect(html).toContain('sub_e2e_1');
    expect(html).toContain('500'); // limit
    expect(html).toContain('>current<'); // pro is current
    expect(doc.querySelectorAll('.b-choose').length).toBe(1); // only team selectable
    // usage bar percent computed from server numbers
    expect(html).toContain('% of the monthly allowance');
  });

  it('renders the quota-exhausted state with the structured refusal copy', async () => {
    const payload = deepClone(SUMMARY_ACTIVE);
    payload.usage = { counter: 'tool-calls', periodDays: 30, used: 500, limit: 500, remaining: 0, exhausted: true };
    respond(200, payload);
    await renderBillingView();
    const html = doc.getElementById('main')?.innerHTML ?? '';
    expect(html).toContain('Plan usage limit reached');
  });

  it('renders the empty (no subscription) state honestly', async () => {
    const payload = deepClone(SUMMARY_ACTIVE);
    payload.subscription = null;
    payload.usage = { counter: 'tool-calls', periodDays: 30, used: 0, limit: 0, remaining: 0, exhausted: false };
    respond(200, payload);
    await renderBillingView();
    const html = doc.getElementById('main')?.innerHTML ?? '';
    expect(html).toContain('No subscription on this tenant yet');
    expect(html).not.toContain('sub_e2e_1');
  });

  it('404 (billing disabled) renders the self-hosted message, never an error wall', async () => {
    respond(404, { error: 'not found' });
    await renderBillingView();
    const html = doc.getElementById('main')?.innerHTML ?? '';
    expect(html).toContain('self-hosted mode');
    expect(html).toContain('not applicable');
  });

  it('401 renders the session-expired error with retry', async () => {
    respond(401, { error: 'authentication required' });
    await renderBillingView();
    const html = doc.getElementById('main')?.innerHTML ?? '';
    expect(html).toContain('Session expired');
    expect(html).toContain('Retry');
  });

  it('HTTP 500 renders a server error with retry, no raw stack', async () => {
    respond(500, { error: 'billing summary unavailable' });
    await renderBillingView();
    const html = doc.getElementById('main')?.innerHTML ?? '';
    expect(html).toContain('HTTP 500');
    expect(html).toContain('Retry');
    expect(html).not.toContain('stack');
  });

  it('network failure renders the network error with retry', async () => {
    if (w === undefined) throw new Error('page window not initialized');
    w.fetch = () => { calls.push({ path: '/api/billing/summary' }); return Promise.reject(new Error('offline')); };
    await renderBillingView();
    const html = doc.getElementById('main')?.innerHTML ?? '';
    expect(html).toContain('Network error');
  });
});

describe('plan grid + checkout interaction (real page logic)', () => {
  it('renders only server-catalog plans and escapes hostile ids (XSS-safe)', async () => {
    const payload = deepClone(SUMMARY_ACTIVE);
    payload.subscription = null;
    payload.plans = [{ planId: '<img src=x onerror=alert(1)>', monthlyToolCalls: 5, priceInr: 1, currency: 'INR', billingInterval: 'monthly' }];
    respond(200, payload);
    await renderBillingView();
    const html = doc.getElementById('main')?.innerHTML ?? '';
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror');
    expect(doc.querySelectorAll('.b-choose').length).toBe(1);
  });

  it('checkout POST carries CSRF + planId and renders payment-PENDING (no entitlement grant)', async () => {
    respond(200, SUMMARY_ACTIVE);
    await renderBillingView();
    respond(200, { status: 'pending', planId: 'team', priceInr: 4999, currency: 'INR', billingInterval: 'monthly', message: '...', checkoutUrl: null });
    const btn = doc.querySelector('.b-choose') as unknown as HTMLButtonElement;
    btn.click();
    await new Promise((r) => { setTimeout(r, 40); });
    const checkoutCall = calls.find((c) => c.path === '/api/billing/checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall?.init?.method).toBe('POST');
    const headers = checkoutCall?.init?.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('tok-1');
    const bodyStr = checkoutCall?.init?.body as string | undefined;
    expect(bodyStr).toContain('"planId":"team"');
    const html = doc.getElementById('main')?.innerHTML ?? '';
    expect(html).toContain('Payment pending');
    expect(html).toContain('only after the payment provider confirms');
    // The UI must NOT flip any local entitlement/state after checkout.
    expect(html).not.toContain('subscription is now active');
  });

  it('checkout failure (400 unknown plan) surfaces the structured error', async () => {
    respond(200, SUMMARY_ACTIVE);
    await renderBillingView();
    respond(400, { error: 'unknown plan' });
    (doc.querySelector('.b-choose') as unknown as HTMLButtonElement).click();
    await new Promise((r) => { setTimeout(r, 40); });
    const html = doc.getElementById('main')?.innerHTML ?? '';
    expect(html).toContain('Checkout failed');
    expect(html).toContain('unknown plan');
  });

  it('cancel flow requires the arm-gate before POSTing (two-step confirmation)', async () => {
    respond(200, SUMMARY_ACTIVE);
    await renderBillingView();
    respond(200, { status: 'cancel-requested', planId: 'pro', subscriptionId: 'sub_e2e_1' });
    const cancelBtn = doc.getElementById('b-cancel') as unknown as HTMLButtonElement;
    const before = calls.length;
    cancelBtn.click(); // first click: reveals the confirm box, no POST
    expect(calls.length).toBe(before);
    const check = doc.getElementById('b-cancel-check') as unknown as HTMLInputElement;
    check.checked = true;
    w.confirm = () => true; // jsdom confirm() returns false by default
    cancelBtn.click(); // second click with armed checkbox + confirmed dialog
    await new Promise((r) => { setTimeout(r, 40); });
    const cancelCall = calls.find((c) => c.path === '/api/billing/cancel');
    expect(cancelCall).toBeDefined();
    expect(cancelCall?.init?.method).toBe('POST');
    const headers = cancelCall?.init?.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('tok-1');
    const html = doc.getElementById('main')?.innerHTML ?? '';
    expect(html).toContain('Cancellation requested');
    expect(html).toContain('remains active until the provider confirms');
  });
});
