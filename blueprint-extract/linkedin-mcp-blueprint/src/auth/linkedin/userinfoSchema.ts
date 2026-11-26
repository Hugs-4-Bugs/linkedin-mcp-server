/**
 * Strict validation of an OIDC userinfo payload (M3).
 *
 * Rules (owner requirement: "validate response schema and reject malformed
 * or unexpected data"):
 * - the payload must be a JSON object, not an array or primitive;
 * - `sub` is required and a non-empty string (the member identity);
 * - unknown top-level keys are REJECTED (unexpected data, not silently
 *   dropped) — the permitted set mirrors the fixed self-serve scopes;
 * - localized name fields (name_locale variants) are NOT accepted — we
 *   expose the invariant `name` only;
 * - every present field must be the right type; email must look like an
 *   email; locale must have a language.
 * On violation, UserinfoValidationError is thrown with a field pointer and
 * a reason — never with the offending value (no response-body leakage).
 */
import * as z from 'zod/v4';

export class UserinfoValidationError extends Error {
  constructor(
    /** JSON pointer of the offending field, e.g. "/email". */
    readonly field: string,
    readonly reason: string,
  ) {
    super(`userinfo field ${field}: ${reason}`);
    this.name = 'UserinfoValidationError';
  }
}

const PERMITTED_KEYS = new Set([
  'sub',
  'name',
  'given_name',
  'family_name',
  'email',
  'email_verified',
  'locale',
  'picture',
]);

const EmailSchema = z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be an email address');
const LocaleSchema = z.object({
  language: z.string().min(2).max(8),
  country: z.string().min(2).max(2).optional(),
});

/** Validated userinfo: only permitted fields, explicitly-typed optionals. */
export interface ValidatedUserInfo {
  sub: string;
  name?: string | undefined;
  given_name?: string | undefined;
  family_name?: string | undefined;
  email?: string | undefined;
  email_verified?: boolean | undefined;
  locale?: { language: string; country?: string | undefined } | undefined;
  picture?: string | undefined;
}

/**
 * Validate a parsed userinfo body. Returns the narrowed, typed subset.
 * Throws UserinfoValidationError on any deviation.
 */
export function validateUserInfo(input: unknown): ValidatedUserInfo {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new UserinfoValidationError('/', 'response must be a JSON object');
  }
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!PERMITTED_KEYS.has(key)) {
      throw new UserinfoValidationError(`/${key}`, 'unexpected field rejected');
    }
  }
  if (typeof obj.sub !== 'string' || obj.sub.length === 0) {
    throw new UserinfoValidationError('/sub', 'required non-empty string member id');
  }
  const stringFields = ['name', 'given_name', 'family_name', 'picture'] as const;
  for (const f of stringFields) {
    const v = obj[f];
    if (v !== undefined && (typeof v !== 'string' || v.length === 0)) {
      throw new UserinfoValidationError(`/${f}`, 'must be a non-empty string when present');
    }
  }
  if (obj.email !== undefined) {
    const r = EmailSchema.safeParse(obj.email);
    if (!r.success) {
      throw new UserinfoValidationError('/email', 'must be an email address when present');
    }
  }
  if (obj.email_verified !== undefined && typeof obj.email_verified !== 'boolean') {
    throw new UserinfoValidationError('/email_verified', 'must be a boolean when present');
  }
  if (obj.locale !== undefined) {
    const r = LocaleSchema.safeParse(obj.locale);
    if (!r.success) {
      throw new UserinfoValidationError('/locale', 'must be {language, country?} when present');
    }
  }
  return {
    sub: obj.sub,
    name: typeof obj.name === 'string' ? obj.name : undefined,
    given_name: typeof obj.given_name === 'string' ? obj.given_name : undefined,
    family_name: typeof obj.family_name === 'string' ? obj.family_name : undefined,
    email: typeof obj.email === 'string' ? obj.email : undefined,
    email_verified: typeof obj.email_verified === 'boolean' ? obj.email_verified : undefined,
    locale: obj.locale as { language: string; country?: string | undefined } | undefined,
    picture: typeof obj.picture === 'string' ? obj.picture : undefined,
  } satisfies ValidatedUserInfo;
}
