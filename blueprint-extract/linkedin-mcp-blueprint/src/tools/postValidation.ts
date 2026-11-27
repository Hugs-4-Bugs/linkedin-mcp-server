/**
 * Post text validation shared by draft/preview/publish tools and both
 * providers. Verified against official documentation (M4 Phase 2):
 *  - commentary text maximum length is 3000 characters
 *    (Microsoft Learn "UGC Post API"; carried by the Posts API commentary).
 *  - text-only member posts carry no media (Posts API "Create Organic Posts").
 *
 * Validation is deliberately conservative: anything the verified API surface
 * does not clearly support (media, targetEntities, dark posts) is out of scope
 * for M4 and therefore not expressible in the schema at all.
 */

/** Verified commentary length ceiling (official docs). */
export const POST_TEXT_MAX_LENGTH = 3000;

/** Verified text-only post minimum (non-blank, not only whitespace). */
export const POST_TEXT_MIN_LENGTH = 1;

export type PostValidationCode =
  | 'too-long'
  | 'blank'
  | 'empty'
  | 'control-chars';

export class PostValidationError extends Error {
  constructor(
    readonly code: PostValidationCode,
    message: string,
    readonly maxLength: number,
  ) {
    super(message);
    this.name = 'PostValidationError';
  }
}

/**
 * Validate post text against the verified API constraints. Returns the
 * normalized (untrimmed — LinkedIn does not trim for you) text or throws.
 * The value itself never appears in the thrown message (log safety).
 */
export function validatePostText(text: string): string {
  if (text.length > POST_TEXT_MAX_LENGTH) {
    throw new PostValidationError(
      'too-long',
      `Post text exceeds the maximum length of ${String(POST_TEXT_MAX_LENGTH)} characters`,
      POST_TEXT_MAX_LENGTH,
    );
  }
  if (text.trim().length === 0) {
    // blank includes empty: message stays generic, never echoes the value
    throw new PostValidationError(
      text.length === 0 ? 'empty' : 'blank',
      'Post text is required and cannot be blank',
      POST_TEXT_MAX_LENGTH,
    );
  }
  // C0/C1 control characters would be rejected or mangled by the API;
  // reject locally so the exact request never leaves the process.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) {
    throw new PostValidationError(
      'control-chars',
      'Post text contains control characters',
      POST_TEXT_MAX_LENGTH,
    );
  }
  return text;
}

/** Normalized validation report for preview/draft outputs. */
export interface PostValidationReport {
  valid: boolean;
  textLength: number;
  maxLength: number;
  remaining: number;
  problems: { code: PostValidationCode; message: string }[];
}

/** Non-throwing variant used by preview to report all problems at once. */
export function reportPostText(text: string): PostValidationReport {
  const problems: { code: PostValidationCode; message: string }[] = [];
  let valid = true;
  if (text.length > POST_TEXT_MAX_LENGTH) {
    valid = false;
    problems.push({
      code: 'too-long',
      message: `Post text exceeds the maximum length of ${String(POST_TEXT_MAX_LENGTH)} characters`,
    });
  }
  if (text.trim().length === 0) {
    valid = false;
    problems.push({
      code: text.length === 0 ? 'empty' : 'blank',
      message: 'Post text is required and cannot be blank',
    });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) {
    valid = false;
    problems.push({ code: 'control-chars', message: 'Post text contains control characters' });
  }
  return {
    valid,
    textLength: text.length,
    maxLength: POST_TEXT_MAX_LENGTH,
    remaining: Math.max(0, POST_TEXT_MAX_LENGTH - text.length),
    problems,
  };
}
