import { createHash } from 'node:crypto';

/**
 * Turning an exception into a group, without a database and without a
 * database of known errors: `sha256(kind + top five normalised frames)`,
 * truncated to 32 hex characters (docs/plans/errors.md, "Fingerprint").
 *
 * The whole design is one constraint: the same bug, thrown a thousand
 * times across deploys, must fingerprint the same every time, and a
 * different bug must not collide with it. That is why every normalisation
 * below throws away information that varies for reasons unrelated to which
 * bug this is — a line number, a package's patch version, a machine's
 * absolute filesystem path — while keeping what actually names the bug: the
 * error's class, the call chain's function names, and which files they are
 * in relative to the project.
 */

/** node_modules/<pkg>, node_modules/@scope/pkg — a scoped package's name is two segments. */
const SCOPED_PACKAGE = /^(@[^/]+\/[^/]+)/;
const PLAIN_PACKAGE = /^([^/]+)/;

/** webpack, webpack-internal and turbopack all prefix a location with a scheme and a fake "host". */
const BUNDLER_SCHEME_PREFIX = /^[a-zA-Z][\w+.-]*:\/\/[^/]*\//;

/** Trailing `:<line>:<column>` or, more rarely, just `:<line>`. */
const TRAILING_LINE_COL = /:\d+:\d+$/;
const TRAILING_LINE = /:\d+$/;

/** `at fn (location)` — the parenthesised form. Function-only frames have no match. */
const FRAME_WITH_FUNCTION = /^(.*)\s\((.+)\)$/;

/**
 * One V8 stack frame to its stable identity: the function name (if any) and
 * the location, with everything that drifts for reasons unrelated to the
 * bug removed.
 *
 * Handles both formats Node/V8 produce:
 *   at functionName (/path/to/file.ts:10:5)
 *   at /path/to/file.ts:10:5
 */
export function normaliseFrame(frame: string): string {
  let s = frame.trim();
  if (s.startsWith('at ')) s = s.slice(3).trim();

  const withFunction = s.match(FRAME_WITH_FUNCTION);
  const functionName = withFunction ? withFunction[1]?.trim() : undefined;
  const location = withFunction ? (withFunction[2]?.trim() ?? '') : s;

  const normalisedLocation = normaliseLocation(location);
  return functionName ? `${functionName} (${normalisedLocation})` : normalisedLocation;
}

function normaliseLocation(rawLocation: string): string {
  // Next.js emits webpack-internal:///, webpack://_N_E/ and turbopack://[project]/
  // ahead of the real path; a bundled build and a plain `node file.js` run of
  // the same source must fingerprint the same, so the scheme goes first.
  let location = rawLocation.replace(BUNDLER_SCHEME_PREFIX, '');
  location = location.replace(/^file:\/\//, '');

  // A dependency's own file layout is not this app's bug: two patch releases
  // of the same package rename nothing an app author can act on, and pnpm's
  // content-addressed store puts the version number in the path itself
  // (node_modules/.pnpm/lodash@4.17.20/node_modules/lodash/index.js). Taking
  // the LAST node_modules/ segment lands on the package's own copy of
  // itself, past any version-numbered store directory, so both versions
  // collapse to the same "node_modules/lodash".
  const nodeModulesIndex = location.lastIndexOf('node_modules/');
  if (nodeModulesIndex !== -1) {
    const afterNodeModules = location.slice(nodeModulesIndex + 'node_modules/'.length);
    const scoped = afterNodeModules.match(SCOPED_PACKAGE);
    const plain = afterNodeModules.match(PLAIN_PACKAGE);
    const pkg = scoped?.[1] ?? plain?.[1];
    return pkg ? `node_modules/${pkg}` : 'node_modules';
  }

  // Line and column drift on every edit to the file, even ones nowhere near
  // the throw (a comment added above it shifts every line below). Keeping
  // them would turn one bug into a new group on every deploy, which is the
  // exact failure mode a grouped error list exists to avoid.
  location = location.replace(TRAILING_LINE_COL, '').replace(TRAILING_LINE, '');

  // A bundler names its output after a build-varying token — a chunk id
  // (8471.js) or a content hash appended for cache-busting (main-abc123.js).
  // Neither identifies the bug; both identify the build, so a browser or
  // Next.js chunk stack would otherwise open a brand new group on every
  // deploy — the exact failure line numbers were already excluded to avoid.
  location = maskBasenameHash(location);

  return stripAbsolutePrefix(location);
}

/** A run of 6+ hex characters straight after the last `-` or `.` in a name. */
const HASH_SUFFIX = /[-.][0-9a-fA-F]{6,}$/;

/**
 * Masks a build-varying token in the FILENAME only — never a directory name
 * — so `chunks/8471.js` and `chunks/main-abc123.js` both collapse to a form
 * that survives a rebuild, while `dashboard/page.js` is untouched because
 * there is nothing in it to mask.
 */
function maskBasenameHash(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : path.slice(0, lastSlash + 1);
  const basename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  return `${dir}${maskBuildHash(basename)}`;
}

function maskBuildHash(basename: string): string {
  const lastDot = basename.lastIndexOf('.');
  // No extension, or a dotfile (".env"): nothing to anchor an extension on,
  // so there is no safe way to tell a hash from the rest of the name.
  if (lastDot <= 0) return basename;
  const ext = basename.slice(lastDot);
  const stem = basename.slice(0, lastDot);

  // A chunk named after nothing but its id: "8471.js", "9032.js". The whole
  // stem changes on every build even though it is the same chunk.
  if (/^\d+$/.test(stem)) return `#${ext}`;

  // A real name with a hash tacked on for cache-busting: "main-abc123.js",
  // "page.4f2a91b.js". Anchored on the LAST separator so it only ever
  // consumes a trailing suffix, and constrained to hex characters so an
  // ordinary multi-word filename is never mistaken for one — "component" in
  // "my-component.tsx" contains 'o', 'p', 'n', 't', none of them hex digits,
  // so it does not match and the name survives untouched.
  const masked = stem.replace(HASH_SUFFIX, (match) => `${match[0]}#`);
  return `${masked}${ext}`;
}

/**
 * The same file has a different absolute path in every environment it
 * runs in — a developer's home directory, the CI runner's workspace, the
 * container's /app — so keeping it would fragment one bug into one group
 * per place it was seen. `src/` is the one directory name this monorepo's
 * own code always sits under, so anything from there on is kept in full.
 * Failing that (a frame with no recognisable project root, e.g. a bare
 * dependency-free script), the last two path segments are kept: enough to
 * tell apart two files that happen to share a name, without the
 * environment-specific parent directories.
 */
function stripAbsolutePrefix(path: string): string {
  const marker = '/src/';
  const markerIndex = path.indexOf(marker);
  if (markerIndex !== -1) return path.slice(markerIndex + 1);
  if (path.startsWith('src/')) return path;

  const segments = path.split('/').filter((segment) => segment.length > 0);
  return segments.slice(-2).join('/');
}

const FRAME_LINE = /^at /;

function parseFrames(stack: string | null | undefined): string[] {
  if (!stack) return [];
  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => FRAME_LINE.test(line));
}

/**
 * A message differs by the one thing that made this particular occurrence
 * unique — a user id, a filename, a value that failed validation — so a
 * fallback that used the raw message would give one group per occurrence,
 * which is exactly the firehose grouping exists to prevent. Digits and
 * quoted substrings are the two shapes that carry that kind of unique data
 * in practice, so both are masked before hashing: "user 4821 not found" and
 * "user 9913 not found" become the same "user # not found".
 */
function maskMessage(message: string): string {
  return message
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/`[^`]*`/g, '`…`')
    .replace(/\d+/g, '#');
}

/**
 * The group an error belongs to: sha256 over the kind and the top five
 * normalised frames, truncated to 32 lower-case hex characters. Five frames
 * because the throw site and its immediate callers are what identifies a
 * bug; frames further up are shared by every request and add nothing but
 * noise a coincidental match in them could exploit.
 *
 * Falls back to `kind + masked message` when there is no stack at all, or
 * the stack has no line this package recognises as a frame (a non-V8
 * runtime, or a stack someone already stripped).
 */
export function fingerprint(input: {
  kind: string;
  message: string;
  stack?: string | null;
}): string {
  const frames = parseFrames(input.stack).slice(0, 5).map(normaliseFrame);
  const basis =
    frames.length > 0
      ? `${input.kind}\n${frames.join('\n')}`
      : `${input.kind}\n${maskMessage(input.message)}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

/**
 * The class name a `kind` column and a fingerprint are built from —
 * `TypeError`, `ZodError` — bounded so a pathological name cannot blow out
 * the 512-character message column it eventually contributes to, and safe
 * for the throws JavaScript actually allows: a string, `null`, an object
 * with no prototype at all. None of those may throw out of this function;
 * an error reporter that itself throws while reporting an error is the one
 * failure mode worse than not reporting it.
 */
export function errorKind(error: unknown): string {
  if (error instanceof Error) {
    return bound(error.constructor?.name || error.name || 'Error');
  }
  if (error === null) return 'null';
  if (error === undefined) return 'undefined';
  if (Array.isArray(error)) return 'array';
  if (typeof error === 'object') {
    // Object.create(null) has no `.constructor` at all; a plain `{}` has one
    // whose name is the unhelpful "Object". Either way there is no class
    // name worth keeping, so it is grouped as a plain object rather than
    // risking a crash reading a property that may not exist.
    const ctorName = (error as { constructor?: { name?: string } }).constructor?.name;
    return bound(ctorName && ctorName !== 'Object' ? ctorName : 'object');
  }
  // string, number, boolean, symbol, bigint, function.
  return bound(typeof error);
}

function bound(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 100) : 'Error';
}
