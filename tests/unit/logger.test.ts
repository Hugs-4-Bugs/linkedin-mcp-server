import { describe, expect, it } from 'vitest';
import { createLogger, redact } from '../../src/observability/logger.js';

describe('redacting logger', () => {
  it('redacts token-like keys', () => {
    const out = redact({ access_token: 'ABC', client_id: 'x', msg: 'fine' });
    expect(out.access_token).toBe('[REDACT]');
    expect(out.msg).toBe('fine');
  });

  it('redacts secret-named keys case-insensitively', () => {
    const out = redact({ ClientSecret: 'v', AuthorizationToken: 'v' });
    expect(out.ClientSecret).toBe('[REDACT]');
    expect(out.AuthorizationToken).toBe('[REDACT]');
  });

  it('redacts bearer strings regardless of key', () => {
    const out = redact({ note: 'Bearer eyJhbGciOi' });
    expect(out.note).toBe('[REDACT]');
  });

  it('redacts nested objects', () => {
    const out = redact({ ctx: { refresh_token: 'r', nested: { password: 'p' } } });
    const ctx = out.ctx as { refresh_token: string; nested: { password: string } };
    expect(ctx.refresh_token).toBe('[REDACT]');
    expect(ctx.nested.password).toBe('[REDACT]');
  });

  it('keeps non-sensitive metadata intact', () => {
    const out = redact({ latencyMs: 42, tool: 'status' });
    expect(out).toEqual({ latencyMs: 42, tool: 'status' });
  });

  it('writes structured JSON to the injected sink, not stdout', () => {
    const lines: string[] = [];
    const log = createLogger('test', (l) => lines.push(l));
    log.info('hello', { ok: true });
    const parsed = JSON.parse(lines[0] ?? '');
    expect(parsed.level).toBe('info');
    expect(parsed.scope).toBe('test');
    expect(parsed.msg).toBe('hello');
    expect(parsed.data).toEqual({ ok: true });
  });
});
