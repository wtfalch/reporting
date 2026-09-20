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
 */
export function heldSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  const specs = [env.KEYSTORE_KEK ?? '', ...(env.KEYSTORE_KEK_PREVIOUS ?? '').split(',')]
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
