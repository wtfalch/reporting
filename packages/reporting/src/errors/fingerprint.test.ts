import { describe, expect, it } from 'vitest';
import { errorKind, fingerprint, normaliseFrame } from './fingerprint.js';

const HEX32 = /^[0-9a-f]{32}$/;

describe('normaliseFrame', () => {
  it('handles the parenthesised V8 format, keeping the function name', () => {
    expect(normaliseFrame('at processOrder (/Users/x/dev/app/src/orders/process.ts:42:11)')).toBe(
      'processOrder (src/orders/process.ts)',
    );
  });

  it('handles the bare-location V8 format, with no function name', () => {
    expect(normaliseFrame('at /Users/x/dev/app/src/http/router.ts:20:3')).toBe(
      'src/http/router.ts',
    );
  });

  it('drops the absolute path prefix ahead of src/', () => {
    expect(normaliseFrame('at fn (/home/runner/work/app/app/src/lib/thing.ts:1:1)')).toBe(
      'fn (src/lib/thing.ts)',
    );
    expect(normaliseFrame('at fn (/app/src/lib/thing.ts:1:1)')).toBe('fn (src/lib/thing.ts)');
  });

  it('falls back to the last two segments when there is no src/ to anchor on', () => {
    expect(normaliseFrame('at fn (/opt/deno/deep/nested/path/thing.js:1:1)')).toBe(
      'fn (path/thing.js)',
    );
  });

  it('collapses a plain node_modules package to its name, dropping the file inside it', () => {
    expect(normaliseFrame('at Object.get (/app/node_modules/lodash/index.js:100:5)')).toBe(
      'Object.get (node_modules/lodash)',
    );
  });

  it('collapses a scoped node_modules package', () => {
    expect(normaliseFrame('at run (/app/node_modules/@wtfalch/reporting/dist/index.js:9:1)')).toBe(
      'run (node_modules/@wtfalch/reporting)',
    );
  });

  it('collapses through a pnpm content-addressed store path to the package the code actually runs', () => {
    // The version lives in the middle directory, not in the final segment
    // this function anchors on — that is the whole reason two versions of
    // the same dependency must still collapse to one identity.
    const pnpmPath =
      'at Object.get (/app/node_modules/.pnpm/lodash@4.17.20/node_modules/lodash/index.js:100:5)';
    expect(normaliseFrame(pnpmPath)).toBe('Object.get (node_modules/lodash)');
  });

  it('strips a webpack-internal prefix before anchoring on src/', () => {
    expect(normaliseFrame('at Foo (webpack-internal:///./src/app/page.tsx:5:2)')).toBe(
      'Foo (src/app/page.tsx)',
    );
  });

  it('strips a webpack:// prefix with a build-id host', () => {
    expect(normaliseFrame('at Foo (webpack://_N_E/./src/app/page.tsx:5:2)')).toBe(
      'Foo (src/app/page.tsx)',
    );
  });

  it('strips a turbopack:// prefix', () => {
    expect(normaliseFrame('at Foo (turbopack://[project]/src/app/page.tsx:5:2)')).toBe(
      'Foo (src/app/page.tsx)',
    );
  });

  it('strips a file:// prefix', () => {
    expect(normaliseFrame('at Foo (file:///Users/x/dev/app/src/lib/thing.ts:5:2)')).toBe(
      'Foo (src/lib/thing.ts)',
    );
  });
});

describe('normaliseFrame: a bundler-assigned build hash in the filename is masked', () => {
  it('masks an all-numeric chunk id, e.g. Next.js chunk filenames', () => {
    expect(normaliseFrame('at o (/app/.next/static/chunks/8471.js:1:1)')).toBe('o (chunks/#.js)');
    expect(normaliseFrame('at o (/app/.next/static/chunks/9032.js:1:1)')).toBe('o (chunks/#.js)');
  });

  it('masks a trailing dash-hash suffix before the extension', () => {
    expect(normaliseFrame('at r (/app/.next/static/chunks/main-abc123.js:1:1)')).toBe(
      'r (chunks/main-#.js)',
    );
    expect(normaliseFrame('at r (/app/.next/static/chunks/main-def456.js:1:1)')).toBe(
      'r (chunks/main-#.js)',
    );
  });

  it('masks a trailing dot-hash suffix before the extension', () => {
    expect(normaliseFrame('at fn (/app/.next/static/chunks/page.4f2a91b.js:1:1)')).toBe(
      'fn (chunks/page.#.js)',
    );
  });

  it('leaves an ordinary filename alone — no hash to mask', () => {
    expect(normaliseFrame('at m (/app/.next/server/app/dashboard/page.js:1:1)')).toBe(
      'm (dashboard/page.js)',
    );
    expect(normaliseFrame('at handle (/app/src/app/route.ts:1:1)')).toBe(
      'handle (src/app/route.ts)',
    );
  });

  it('does not mistake an ordinary multi-word filename for a hash', () => {
    // The case most likely to be damaged by a careless regex: a real
    // filename with a dash followed by a 6+ character word. Requiring the
    // suffix to be hex-only excludes it, since "component" contains 'o',
    // 'p', 'n' and 't', none of them hex digits.
    expect(normaliseFrame('at Foo (/app/src/components/my-component.tsx:1:1)')).toBe(
      'Foo (src/components/my-component.tsx)',
    );
  });
});

describe('fingerprint: the same bug groups across line-number drift', () => {
  // The whole point: an edit that shifts every line below it (a comment, a
  // new import) must not split one bug into a new group. The stacks below
  // are otherwise byte-identical; only the line:column numbers differ.
  const stackAtLine42 = [
    'Error: boom',
    '    at processOrder (/Users/x/dev/app/src/orders/process.ts:42:11)',
    '    at handleRequest (/Users/x/dev/app/src/http/handler.ts:88:5)',
    '    at /Users/x/dev/app/src/http/router.ts:20:3',
  ].join('\n');
  const stackAtLine57 = [
    'Error: boom',
    '    at processOrder (/Users/x/dev/app/src/orders/process.ts:57:4)',
    '    at handleRequest (/Users/x/dev/app/src/http/handler.ts:91:9)',
    '    at /Users/x/dev/app/src/http/router.ts:25:1',
  ].join('\n');

  it('fingerprints the same', () => {
    const a = fingerprint({ kind: 'Error', message: 'boom', stack: stackAtLine42 });
    const b = fingerprint({ kind: 'Error', message: 'boom', stack: stackAtLine57 });
    expect(a).toBe(b);
  });

  it('is unaffected by the message text, since the stack is what is hashed', () => {
    const a = fingerprint({ kind: 'Error', message: 'boom', stack: stackAtLine42 });
    const b = fingerprint({
      kind: 'Error',
      message: 'a completely different message',
      stack: stackAtLine57,
    });
    expect(a).toBe(b);
  });
});

describe('fingerprint: genuinely different errors do not collide', () => {
  const stackA = ['Error: boom', '    at processOrder (/app/src/orders/process.ts:42:11)'].join(
    '\n',
  );
  const stackB = ['Error: nope', '    at somethingElse (/app/src/other/thing.ts:10:2)'].join('\n');

  it('differs when the call chain differs', () => {
    const a = fingerprint({ kind: 'Error', message: 'boom', stack: stackA });
    const b = fingerprint({ kind: 'Error', message: 'nope', stack: stackB });
    expect(a).not.toBe(b);
  });

  it('differs when only the kind differs, same stack', () => {
    const a = fingerprint({ kind: 'TypeError', message: 'boom', stack: stackA });
    const b = fingerprint({ kind: 'RangeError', message: 'boom', stack: stackA });
    expect(a).not.toBe(b);
  });
});

describe('fingerprint: node_modules version drift groups together', () => {
  const stackOldLodash = [
    'Error: boom',
    '    at Object.get (/app/node_modules/.pnpm/lodash@4.17.20/node_modules/lodash/index.js:100:5)',
    '    at caller (/app/src/index.ts:5:1)',
  ].join('\n');
  const stackNewLodash = [
    'Error: boom',
    '    at Object.get (/app/node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/index.js:142:9)',
    '    at caller (/app/src/index.ts:9:1)',
  ].join('\n');

  it('fingerprints the same across a dependency patch bump', () => {
    const a = fingerprint({ kind: 'TypeError', message: 'boom', stack: stackOldLodash });
    const b = fingerprint({ kind: 'TypeError', message: 'boom', stack: stackNewLodash });
    expect(a).toBe(b);
  });
});

describe('fingerprint: a bundled filename hash groups across deploys (regression)', () => {
  // Reproduces the defect: a browser or server error whose frame points at
  // a bundler-named file must not open a new group on every build just
  // because the build renamed the file.
  it('two Next.js chunk-id filenames from different builds fingerprint the same', () => {
    const a = fingerprint({
      kind: 'Error',
      message: 'boom',
      stack: ['Error: boom', '    at o (/app/.next/static/chunks/8471.js:10:5)'].join('\n'),
    });
    const b = fingerprint({
      kind: 'Error',
      message: 'boom',
      stack: ['Error: boom', '    at o (/app/.next/static/chunks/9032.js:10:5)'].join('\n'),
    });
    expect(a).toBe(b);
  });

  it('two content-hashed asset filenames from different builds fingerprint the same', () => {
    const a = fingerprint({
      kind: 'Error',
      message: 'boom',
      stack: ['Error: boom', '    at r (/app/.next/static/chunks/main-abc123.js:10:5)'].join('\n'),
    });
    const b = fingerprint({
      kind: 'Error',
      message: 'boom',
      stack: ['Error: boom', '    at r (/app/.next/static/chunks/main-def456.js:10:5)'].join('\n'),
    });
    expect(a).toBe(b);
  });

  it('does not merge genuinely different files, and does not touch a filename with no hash', () => {
    const page = fingerprint({
      kind: 'Error',
      message: 'boom',
      stack: ['Error: boom', '    at m (/app/.next/server/app/dashboard/page.js:10:5)'].join('\n'),
    });
    const component = fingerprint({
      kind: 'Error',
      message: 'boom',
      stack: ['Error: boom', '    at Foo (/app/src/components/my-component.tsx:10:5)'].join('\n'),
    });
    expect(page).not.toBe(component);
    expect(page).toMatch(HEX32);
    expect(component).toMatch(HEX32);
  });
});

describe('fingerprint: no-stack fallback masks unique data in the message', () => {
  it('groups messages that differ only by digits', () => {
    const a = fingerprint({ kind: 'NotFoundError', message: 'user 4821 not found' });
    const b = fingerprint({ kind: 'NotFoundError', message: 'user 9913 not found' });
    expect(a).toBe(b);
  });

  it('treats a null and an empty stack the same as no stack at all', () => {
    const a = fingerprint({ kind: 'NotFoundError', message: 'user 4821 not found', stack: null });
    const b = fingerprint({ kind: 'NotFoundError', message: 'user 9913 not found', stack: '' });
    expect(a).toBe(b);
  });

  it('still tells genuinely different messages apart', () => {
    const a = fingerprint({ kind: 'NotFoundError', message: 'user not found' });
    const b = fingerprint({ kind: 'NotFoundError', message: 'order not found' });
    expect(a).not.toBe(b);
  });

  it('falls back when the stack has no line this package recognises as a frame', () => {
    const a = fingerprint({
      kind: 'NotFoundError',
      message: 'user 4821 not found',
      stack: 'not a real stack',
    });
    const b = fingerprint({
      kind: 'NotFoundError',
      message: 'user 9913 not found',
      stack: 'also not a stack',
    });
    expect(a).toBe(b);
  });
});

describe('errorKind', () => {
  it('names the class for an Error subclass', () => {
    expect(errorKind(new TypeError('x'))).toBe('TypeError');
    class ZodError extends Error {}
    expect(errorKind(new ZodError('x'))).toBe('ZodError');
  });

  it('is stable and does not throw for a non-Error throw', () => {
    expect(() => errorKind('a string throw')).not.toThrow();
    expect(() => errorKind(null)).not.toThrow();
    expect(() => errorKind(undefined)).not.toThrow();
    expect(() => errorKind({})).not.toThrow();
    expect(() => errorKind(Object.create(null))).not.toThrow();
    expect(() => errorKind(42)).not.toThrow();

    expect(errorKind('a string throw')).toBe(errorKind('a different string'));
    expect(errorKind(null)).toBe('null');
    expect(errorKind(undefined)).toBe('undefined');
    expect(errorKind({})).toBe(errorKind({ other: 'shape' }));
    expect(errorKind(Object.create(null))).toBe('object');
  });
});

describe('fingerprint: always exactly 32 lower-case hex characters', () => {
  it.each([
    { kind: 'Error', message: 'boom', stack: 'Error: boom\n    at fn (/app/src/a.ts:1:1)' },
    { kind: 'Error', message: 'boom' },
    { kind: errorKind(null), message: 'x' },
    { kind: errorKind({}), message: 'x' },
    { kind: errorKind('thrown string'), message: 'x' },
  ])('matches /^[0-9a-f]{32}$/', (input) => {
    expect(fingerprint(input)).toMatch(HEX32);
    expect(fingerprint(input)).toHaveLength(32);
  });

  it('never throws when computing a fingerprint from a non-Error kind', () => {
    expect(() => fingerprint({ kind: errorKind(null), message: 'x' })).not.toThrow();
    expect(() => fingerprint({ kind: errorKind({}), message: 'x' })).not.toThrow();
  });
});
