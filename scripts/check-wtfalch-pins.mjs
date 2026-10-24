#!/usr/bin/env node
/**
 * Every `@wtfalch/*` dependency in this workspace must be pinned to an
 * exact version, or the literal `workspace:*` -- except `peerDependencies`,
 * which may also be a real semver range (see below).
 *
 * Usage: node scripts/check-wtfalch-pins.mjs [root]
 *   root  Repo root to check (default: this script's parent directory,
 *         i.e. the real repo root). A test points this at a fixture tree.
 *
 * Why exact and not a caret. `@wtfalch/*` packages are all pre-1.0. A
 * zero-major range like "^0.3.2" cannot reach "0.4.0" under semver --
 * caret only widens within the leftmost nonzero component, and for a
 * "0.x" version that component is the second one, not the third. A
 * caret on an estate package is therefore a silent freeze that looks
 * like a range: it never crosses a minor bump, so a real feature or fix
 * release never reaches the consumer on its own. The estate has already
 * stranded consumers this way. Renovate raises an exact pin with a
 * visible PR; a caret just sits there and never moves.
 *
 * `peerDependencies` is the one field this reasoning does not fit
 * (docs/adr/0016-peer-ranges.md): a peer names what a *host* app may
 * already have installed, not this package's own install. An exact peer
 * pin against a host that already moved to a newer patch is a hard peer
 * conflict, not a silent freeze -- it fails the install outright. So
 * `peerDependencies` may be `workspace:*`, an exact version, or a real
 * range (RANGE, below); `dependencies`, `devDependencies` and
 * `optionalDependencies` keep the exact-or-`workspace:*` rule unchanged.
 * `scripts/check-package.mjs` Rule 11 separately requires that a
 * publishable package's packed `@wtfalch/*` peers actually use that room,
 * so an exact peer pin cannot quietly come back.
 *
 * No dependencies, so it runs before `pnpm install` and cannot itself drift.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPackages } from './lib/workspace.mjs';

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL('../', import.meta.url));

const SCOPE = /^@wtfalch\//;
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
/** The one field allowed a real range instead of an exact pin. See the file header. */
const RANGE_FIELDS = new Set(['peerDependencies']);
/** Exactly `1.2.3`, optionally with a prerelease/build suffix. Nothing a range can widen. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SEMVER_SRC = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?';
/**
 * A real semver range, allowed in `peerDependencies` only: a caret or tilde
 * on one version, or one or two `>=`/`<=`/`>`/`<` comparators each pinned to
 * a real version, space-separated. Deliberately not the full range grammar
 * -- no `||`, no `x`/`*` wildcards, no partial versions -- a `@wtfalch/*`
 * peer says which versions were actually checked, not "anything".
 */
const RANGE = new RegExp(
  `^(?:[\\^~]${SEMVER_SRC}|(?:>=|<=|>|<)${SEMVER_SRC}(?: (?:>=|<=|>|<)${SEMVER_SRC})?)$`,
);

function manifestsToCheck() {
  const list = loadPackages(root).map(({ dir, relDir, manifest }) => ({
    relPath: path.join(relDir, 'package.json'),
    manifest,
    dir,
  }));
  try {
    const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    list.unshift({ relPath: 'package.json', manifest: rootManifest, dir: root });
  } catch {
    // no root manifest to check; workspace packages are still checked below
  }
  return list;
}

const problems = [];
for (const { relPath, manifest } of manifestsToCheck()) {
  for (const field of FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (!SCOPE.test(dep)) continue;
      if (range === 'workspace:*' || EXACT.test(range)) continue;
      if (RANGE_FIELDS.has(field) && RANGE.test(range)) continue;
      const allowed =
        field === 'peerDependencies'
          ? 'an exact version, "workspace:*", or a real semver range (e.g. "^1.2.3" or ">=1.2.3 <2.0.0")'
          : 'an exact version or "workspace:*"';
      problems.push(`${relPath}: ${dep} is "${range}", not ${allowed}`);
    }
  }
}

if (problems.length > 0) {
  console.error('check-wtfalch-pins: @wtfalch/* dependencies must be pinned exactly:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nUse "1.2.3" or "workspace:*". peerDependencies may also use a real range, e.g.');
  console.error('">=1.2.3 <2.0.0" or "^1.2.3" -- not "workspace:^", "*" or a partial version.');
  process.exit(1);
}

console.log(
  'check-wtfalch-pins: every declared @wtfalch/* dependency is an exact pin, "workspace:*",',
);
console.log('or (peerDependencies only) a real semver range');
