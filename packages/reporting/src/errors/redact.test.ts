import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REDACTED, heldSecrets, redactText, scrub } from './redact.js';

/**
 * The scrubber, and the shapes an error report actually arrives in.
 *
 * Every case here is one somebody has shipped: the key in a message, in a
 * stack frame's captured context, in a breadcrumb four levels down. The
 * scrubber either covers all of them or it is decoration.
 */

const generateWrappingKey = (id: string) => `${id}:${randomBytes(32).toString('base64')}`;

const kek = generateWrappingKey('now');
const previous = generateWrappingKey('then');
const env = { KEYSTORE_KEK: kek, KEYSTORE_KEK_PREVIOUS: previous };
const secrets = heldSecrets(env);
const base64Of = (spec: string) => spec.slice(spec.indexOf(':') + 1);

describe('what counts as a held secret', () => {
  it('is both variables in full, and each base64 half on its own', () => {
    expect(secrets).toContain(kek);
    expect(secrets).toContain(previous);
    expect(secrets).toContain(base64Of(kek));
    expect(secrets).toContain(base64Of(previous));
  });

  it('is nothing at all when the store is not configured', () => {
    expect(heldSecrets({})).toEqual([]);
    expect(heldSecrets({ KEYSTORE_KEK: '   ' })).toEqual([]);
  });

  it('takes every generation listed, so an outgoing key is covered too', () => {
    const third = generateWrappingKey('before');
    const all = heldSecrets({
      KEYSTORE_KEK: kek,
      KEYSTORE_KEK_PREVIOUS: `${previous}, ${third}`,
    });
    expect(all).toContain(third);
  });

  it('does not add a short tail on its own — a short tail is a common substring, not a secret', () => {
    const shortSpec = 'k1:short-tail-16'; // 14-char tail: not > 16, so excluded alone
    const all = heldSecrets({ KEYSTORE_KEK: shortSpec });
    expect(all).toContain(shortSpec);
    expect(all).not.toContain('short-tail-16');
  });
});

describe('redactText', () => {
  it('replaces a wrapping key wherever it sits in a realistic multi-line stack', () => {
    const stack = [
      'Error: could not unwrap key',
      '    at unwrap (/app/src/keystore/unwrap.ts:42:11)',
      `    context: KEYSTORE_KEK=${kek}`,
      '    at boot (/app/src/index.ts:5:1)',
    ].join('\n');

    const out = redactText(stack, secrets);

    expect(out).not.toContain(kek);
    expect(out).not.toContain(base64Of(kek));
    expect(out).toContain(REDACTED);
    // Everything that was not the secret survives untouched.
    expect(out).toContain('at unwrap (/app/src/keystore/unwrap.ts:42:11)');
    expect(out).toContain('at boot (/app/src/index.ts:5:1)');
  });

  it('replaces the base64 half alone, since heldSecrets adds it separately', () => {
    const message = `unexpected token near ${base64Of(kek)}`;
    const out = redactText(message, secrets);
    expect(out).not.toContain(base64Of(kek));
    expect(out).toBe(`unexpected token near ${REDACTED}`);
  });

  it('leaves a short tail alone — the existing 16-char rule', () => {
    const shortSpec = 'k1:short-tail-16';
    const shortSecrets = heldSecrets({ KEYSTORE_KEK: shortSpec });
    const out = redactText('the tail short-tail-16 shows up bare here', shortSecrets);
    expect(out).toContain('short-tail-16');
    expect(out).not.toContain(REDACTED);
  });

  it('replaces every occurrence, not only the first', () => {
    const out = redactText(`${kek} and again ${kek}`, secrets);
    expect(out).toBe(`${REDACTED} and again ${REDACTED}`);
  });

  it('returns the input unchanged, by identity, when there is nothing to hide', () => {
    const text = 'a perfectly ordinary error message';
    expect(redactText(text, [])).toBe(text);
  });
});

describe('scrub', () => {
  it('replaces it wherever it is nested', () => {
    const event = {
      breadcrumbs: [{ data: { env: { KEYSTORE_KEK: kek } } }],
      exception: { values: [{ stacktrace: { frames: [{ vars: { spec: base64Of(previous) } }] } }] },
    };
    const out = JSON.stringify(scrub(event, secrets));
    expect(out).not.toContain(base64Of(kek));
    expect(out).not.toContain(base64Of(previous));
    expect(out).toContain(REDACTED);
  });

  it('replaces the message and the stack on a captured error shape', () => {
    const captured = {
      message: `could not parse ${kek}`,
      stack: `Error: boom\n    at fn (/app/src/a.ts:1:1)\n    key=${base64Of(previous)}`,
    };
    const out = scrub(captured, secrets);
    expect(out.message).toBe(`could not parse ${REDACTED}`);
    expect(out.stack).not.toContain(base64Of(previous));
  });

  it('leaves everything else exactly as it was', () => {
    const event = { level: 'error', tags: { route: '/manage' }, n: 4, ok: false, nil: null };
    expect(scrub(event, secrets)).toEqual(event);
  });

  it('returns the input unchanged, by identity, when there is nothing to hide', () => {
    const event = { message: 'a perfectly ordinary error' };
    expect(scrub(event, [])).toBe(event);
  });

  it('survives an object cycle, which every error object graph has', () => {
    const event: Record<string, unknown> = { message: kek };
    event.self = event;
    const out = scrub(event, secrets) as Record<string, unknown>;
    expect(out.message).toBe(REDACTED);
    expect(out.self).toBe(out);
  });

  it('survives a cycle that spans an array, without hanging', () => {
    const node: Record<string, unknown> = { message: kek };
    const list: unknown[] = [node];
    node.siblings = list;
    const out = scrub(node, secrets) as Record<string, unknown>;
    expect(out.message).toBe(REDACTED);
    expect((out.siblings as unknown[])[0]).toBe(out);
  });

  it('walks an array without turning it into an object', () => {
    const out = scrub({ headers: ['a', kek, 'b'] }, secrets);
    expect(Array.isArray(out.headers)).toBe(true);
    expect(out.headers[1]).toBe(REDACTED);
  });
});
