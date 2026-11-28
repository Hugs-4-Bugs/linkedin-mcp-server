/**
 * M3 unit tests — userinfo schema validation and scope-report truth model.
 * The schema tests are adversarial: every malformed/unexpected shape must be
 * rejected, and the error must never echo the offending value.
 */
import { describe, expect, it } from 'vitest';
import {
  validateUserInfo,
  UserinfoValidationError,
} from '../../src/auth/linkedin/userinfoSchema.js';
import { buildScopeReport } from '../../src/auth/linkedin/scopeReport.js';
import { LINKEDIN_SCOPES } from '../../src/config/config.js';

describe('userinfo schema validation', () => {
  it('accepts the canonical fixture and preserves fields', () => {
    const r = validateUserInfo({
      sub: 'abc123',
      name: 'Mock Member',
      given_name: 'Mock',
      family_name: 'Member',
      email: 'abc123@example.invalid',
      email_verified: true,
      locale: { language: 'en', country: 'US' },
      picture: 'https://example.invalid/p.png',
    });
    expect(r.sub).toBe('abc123');
    expect(r.name).toBe('Mock Member');
    expect(r.emailVerifiedIsBool).toBeUndefined(); // not a field: sanity that no invention happens
    expect(r.email_verified).toBe(true);
    expect(r.locale?.language).toBe('en');
  });

  it('accepts a minimal response (sub only) and returns absent optionals as undefined', () => {
    const r = validateUserInfo({ sub: 'x' });
    expect(r.email).toBeUndefined();
    expect(r.name).toBeUndefined();
  });

  it('rejects non-object bodies: array, string, null', () => {
    expect(() => validateUserInfo([])).toThrow(UserinfoValidationError);
    expect(() => validateUserInfo('nope')).toThrow(/must be a JSON object/);
    expect(() => validateUserInfo(null)).toThrow(/must be a JSON object/);
  });

  it('rejects missing or empty sub', () => {
    expect(() => validateUserInfo({ name: 'x' })).toThrow(/\/sub/);
    expect(() => validateUserInfo({ sub: '' })).toThrow(/\/sub/);
  });

  it('rejects unexpected fields (unknown capability data)', () => {
    expect(() => validateUserInfo({ sub: 'x', headline: 'CEO' })).toThrow(/\/headline.*unexpected field/);
    expect(() => validateUserInfo({ sub: 'x', urn: 'urn:li:fake' })).toThrow(/unexpected field/);
  });

  it('rejects wrong-typed fields with pointers, without echoing values', () => {
    const err = (() => {
      try {
        validateUserInfo({ sub: 'x', email_verified: 'yes' });
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(UserinfoValidationError);
    expect(err?.message).toContain('/email_verified');
    expect(err?.message).not.toContain('yes');
    expect(() => validateUserInfo({ sub: 'x', email: 'not-an-email' })).toThrow(/\/email/);
    expect(() => validateUserInfo({ sub: 'x', locale: { language: 'e' } })).toThrow(/\/locale/);
    expect(() => validateUserInfo({ sub: 'x', name: 42 })).toThrow(/\/name/);
  });

  it('rejects localized-variant name keys (unexpected by policy)', () => {
    expect(() =>
      validateUserInfo({ sub: 'x', 'name,localized': 'X' }),
    ).toThrow(/unexpected field/);
  });
});

describe('scope report truth model', () => {
  const NOW = 1_000_000;

  it('requested ≠ granted: full request with empty claim is unverified, all missing', () => {
    const r = buildScopeReport({ accessToken: 't', expiresAt: NOW + 1, scopes: [] }, NOW);
    expect(r.verification).toBe('unverified');
    expect(r.unverified).toBe(true);
    expect(r.tokenScopeClaim).toEqual([]);
    expect(r.missingFromClaim).toEqual([...LINKEDIN_SCOPES]);
    expect(r.matchedFromClaim).toEqual([]);
    expect(r.connectionState).toBe('connected');
  });

  it('partial claim: matched + missing reported separately', () => {
    const r = buildScopeReport(
      { accessToken: 't', expiresAt: NOW + 1, scopes: ['openid', 'profile'] },
      NOW,
    );
    expect(r.verification).toBe('token-response');
    expect(r.unverified).toBe(false);
    expect(r.matchedFromClaim).toEqual(['openid', 'profile']);
    expect(r.missingFromClaim).toEqual(['email', 'w_member_social']);
  });

  it('disconnected: no tokens at all', () => {
    const r = buildScopeReport(undefined, NOW);
    expect(r.connectionState).toBe('disconnected');
    expect(r.tokenScopeClaim).toEqual([]);
    expect(r.unverified).toBe(true);
  });

  it('expired token: claim kept for forensics, state expired', () => {
    const r = buildScopeReport(
      { accessToken: 't', expiresAt: NOW - 1, scopes: ['openid'] },
      NOW,
    );
    expect(r.connectionState).toBe('expired');
    expect(r.verification).toBe('token-response'); // claim is still what was captured
  });

  it('requested set is what we asked for, never mutated by the claim', () => {
    const r = buildScopeReport(
      { accessToken: 't', expiresAt: NOW + 1, scopes: ['openid', 'r_emailaddress'] },
      NOW,
    );
    expect(r.requestedScopes).toEqual([...LINKEDIN_SCOPES]);
    // foreign scopes in the claim are reported as-is, not interpreted
    expect(r.tokenScopeClaim).toContain('r_emailaddress');
    expect(r.matchedFromClaim).toEqual(['openid']);
  });
});
