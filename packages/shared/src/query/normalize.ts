/**
 * Normalization used ONLY for inspecting values for script markers (never for building queries).
 *
 * Steps (ADR-005): up to 2 URL-decoding passes, HTML entity / \u-escape decoding, Unicode NFKC,
 * removal of zero-width / bidi / soft-hyphen characters, lowercase.
 */

const INVISIBLE_RE = /[­᠎​-‏‪-‮⁠-⁤﻿]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control characters is the purpose
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function decodeUrlOnce(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s.replace(/%([0-9a-f]{2})/gi, (_m, h: string) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    );
  }
}

function decodeEscapes(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => safeFromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#([0-9]+);?/g, (_m, d: string) => safeFromCodePoint(Number.parseInt(d, 10)))
    .replace(/&colon;?/gi, ':')
    .replace(/&(tab|newline);?/gi, '')
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_m, h: string) =>
      safeFromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/\\u([0-9a-f]{4})/gi, (_m, h: string) => safeFromCodePoint(Number.parseInt(h, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_m, h: string) => safeFromCodePoint(Number.parseInt(h, 16)));
}

function safeFromCodePoint(cp: number): string {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
}

/** Lowercased, decoded, NFKC-normalized form for pattern inspection. */
export function normalizeForInspection(value: string): string {
  let s = value;
  for (let i = 0; i < 2; i++) s = decodeUrlOnce(s);
  s = decodeEscapes(s);
  s = s.normalize('NFKC').replace(INVISIBLE_RE, '');
  return s.toLowerCase();
}

/** Letters only — defeats separators/whitespace inserted inside keywords ("java\tscript"). */
function lettersOnly(normalized: string): string {
  return normalized.replace(/[^a-z]/g, '');
}

export function hasControlChars(value: string): boolean {
  return CONTROL_RE.test(value);
}

/**
 * Enforced everywhere (server + extension): ServiceNow evaluates `javascript:` values
 * server-side, so the word is rejected in any disguise, in any value.
 */
export function containsScriptMarker(value: string): boolean {
  const n = normalizeForInspection(value);
  return lettersOnly(n).includes('javascript') || hasControlChars(n);
}

/**
 * Additional patterns rejected in the `strict` profile (raw `encoded_query` typed by the model).
 * Not applied to compiled structured filters, where literal code searches such as
 * `scriptLIKEgs.addErrorMessage` are legitimate (see ADR-005 addendum).
 */
const SCRIPT_LIKE_PATTERNS: readonly RegExp[] = [
  /\bgs\s*\./,
  /\$\{/,
  /\beval\s*\(/,
  /\bnew\s+[a-z_$]/,
];

export function containsScriptLikePattern(value: string): boolean {
  const n = normalizeForInspection(value);
  return SCRIPT_LIKE_PATTERNS.some((re) => re.test(n));
}
