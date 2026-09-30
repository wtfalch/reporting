/**
 * Keeping the wrapping keys out of anything this package captures.
 *
 * **Why this is worth a file.** The store's whole promise is that a database
 * dump is ciphertext, and that promise has exactly one premise: the wrapping
 * key is not where the ciphertext is. An error report is the most likely way
 * for it to end up somewhere else — a crash during boot with the environment
 * attached, a configuration error whose message quotes the value it could not
 * parse, a breadcrumb from a library that logs what it was given. None of
 * those is a bug in this module; all of them would hand the key to whoever
 * can read the error.
 *
 * So the rule is stated once, here, and applied on the capture path rather
 * than trusted to every path in. `scrub` walks a structure and replaces any
 * exact occurrence of a held key with a marker; `redactText` does the same
 * for the plain-string case — a captured `message` or `stack` — without
 * walking a structure that does not exist yet.
 *
 * **It cannot cover stored values**, and does not pretend to: those are not in
 * the environment, so there is nothing to enumerate. What protects them is
 * that no code path writes one anywhere but the response that asked for it.
 *
 * No `server-only`: the edge runtime captures errors too, and this reaches
 * nothing but its arguments and `process.env`.
 */

export const REDACTED = '[redacted: wrapping key]';

/**
 * The exact strings that must never appear in anything sent anywhere: both
 * environment variables in full, and each key's base64 half on its own, since
 * a parser that split on the colon would report only that part.
 *
 * `extraEnvVars` is how a host extends the list beyond the estate's own
 * KEYSTORE_* convention (gap issue #7): each named variable is read the same
 * way `KEYSTORE_KEK_PREVIOUS` is -- comma-separated values allowed, each
 * trimmed -- so a host's own rotation scheme is covered the same way the
 * estate's is, with no new format to learn.
 */
export function heldSecrets(
  env: Readonly<Record<string, string | undefined>>,
  extraEnvVars: readonly string[] = [],
): string[] {
  const specs = [
    env.KEYSTORE_KEK ?? '',
    ...(env.KEYSTORE_KEK_PREVIOUS ?? '').split(','),
    ...extraEnvVars.flatMap((name) => (env[name] ?? '').split(',')),
  ]
    .map((spec) => spec.trim())
    .filter((spec) => spec.length > 0);

  const secrets = new Set<string>();
  for (const spec of specs) {
    secrets.add(spec);
    const separator = spec.indexOf(':');
    // A short tail is not worth replacing: it would be a common substring
    // rather than a secret, and a scrubber that rewrites ordinary text is one
    // somebody turns off.
    if (separator > 0 && spec.length - separator > 16) secrets.add(spec.slice(separator + 1));
  }
  return [...secrets];
}

/**
 * The string case alone: a captured `message` and `stack` are strings before
 * they are anything else, so the capture path scrubs them directly rather
 * than wrapping each in an object just to hand it to `scrub`.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Pattern-based PII redaction for a captured `message` or `stack`.
 *
 * `redactText` only knows the exact strings the host holds. A user's email
 * address or a bearer token inside an error message is not one of them, yet
 * it would be stored verbatim, kept until pruned and readable by anyone who
 * can open the errors page. This covers the common shapes by pattern: cheap,
 * and with false negatives (a bare opaque token with no label is not caught).
 * A string that only looks like a secret and is not one, such as a version
 * like `lodash@4.17.20`, is left alone.
 */
const PII_PATTERNS: readonly [RegExp, string][] = [
  // URL userinfo: `scheme://user:pass@host` keeps scheme and user, drops the
  // password (also `scheme://:pass@host`). Before the email rule, which would
  // otherwise take `pass@host` and leave the user behind a wrong label.
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]{0,64}:)[^\s@/]{1,256}@/gi, '$1[redacted: password]@'],
  // Every quantifier is bounded (RFC 5321 limits: 64-char local part, 63-char
  // labels), so a long run of `a.a.a.` with no `@` costs a fixed amount per
  // start position rather than a rescan of the rest of the string.
  [
    /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g,
    '[redacted: email]',
  ],
  // A PEM private key block; an unterminated one (a truncated stack) runs to the end.
  [
    /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g,
    '[redacted: private key]',
  ],
  // The JSON form of an Authorization header, whatever the value's length.
  [/("authorization"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[redacted: token]"'],
  // A Cookie or Set-Cookie header's value, to the end of the line.
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, '$1[redacted: cookie]'],
  // A JSON "cookie" / "set-cookie" value.
  [/("(?:set-)?cookie"\s*:\s*)"(?:[^"\\]|\\.){0,2048}"/gi, '$1"[redacted: cookie]"'],
  // A labelled secret in `=`, `:`, JSON (`"password":"x"`) or `%3D` form,
  // including `x-api-key:` headers. A quoted value is taken whole.
  [
    /((?:password|passwd|token|secret|api[_-]?key|apikey|client_secret|access_token|refresh_token)["']?\s*(?::|=|%3D)\s*)(?:"(?:[^"\\]|\\.){0,512}"|'[^']{0,512}'|[^\s&;,'"}]+)/gi,
    '$1[redacted: secret]',
  ],
  // JWT: three base64url segments, the first two starting with an encoded `{"`.
  // Linear: a start cannot sit inside a base64url run (the lookbehind), and
  // each segment is capped, so a hostile `-eyJ-eyJ...` costs a fixed amount.
  [
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,2048}\.eyJ[A-Za-z0-9_-]{5,2048}\.[A-Za-z0-9_-]{0,2048}/g,
    '[redacted: token]',
  ],
  // An Authorization header's value, including its scheme.
  [/\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s,;'"]+/gi, '$1[redacted: token]'],
  // A scheme followed by a credential, anywhere.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted: token]'],
  // Well-known prefixed token formats.
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g,
    '[redacted: token]',
  ],
];

export function redactPii(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PII_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The same structure with every held secret replaced.
 *
 * Walks rather than serialising and string-replacing, so the shape a caller
 * expects survives. Cycles are tracked because an error object graph has them
 * and a scrubber that hangs is worse than one that missed something.
 */
export function scrub<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  return walk(value, secrets, new WeakMap()) as T;
}

function walk(value: unknown, secrets: readonly string[], seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value !== 'object') return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(walk(item, secrets, seen));
    return copy;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = walk(item, secrets, seen);
  return copy;
}
