#!/usr/bin/env node
/**
 * The public-surface contract for every publishable workspace package.
 *
 * Usage: node scripts/check-package.mjs [root]
 *   root  Repo root to check (default: this script's parent directory,
 *         i.e. the real repo root). A test points this at a fixture tree.
 *
 * Rules, for every publishable package (no `"private": true`):
 *   1. publishConfig.access === "public".
 *   2. "files" lists README.md and LICENSE, and every other entry starts
 *      with "dist" (@wtfalch/email shipped eight versions with a broken
 *      tarball before anyone looked at "files").
 *   3. README.md, LICENSE and dist/ actually exist on disk, once the
 *      package has been built (dist/ present). An unbuilt package skips
 *      this and the tarball check (4) but still gets the manifest rules.
 *   4. The real npm tarball (via `npm pack`) contains exactly the files
 *      "files" plus package.json implies -- no stray file, none missing.
 *   5. "sideEffects" is present (false or an array): an absent
 *      "sideEffects" silently disables bundler tree-shaking.
 *   6. repository.directory matches the package's own path in the repo.
 *
 * Rules, for every package whose name ends "-service" (never published):
 *   7. "private": true.
 *   8. no publishConfig.
 *   9. a prepublishOnly script that throws, as a last-resort guard
 *      against an accidental `npm publish`.
 *
 * Rule, for a publishable package named <x> when a package named <x>-service
 * exists in the workspace (the service shape's public SDK):
 *  10. dependencies are empty/absent, or exactly `{ "@wtfalch/contracts":
 *      "<exact version>" }` (contracts ADR 0007, package-template
 *      ADR 0003 amendment) -- @wtfalch/contracts has no runtime
 *      dependencies of its own, so an SDK depending on nothing else still
 *      pulls nothing else into its host. peerDependencies is empty/absent,
 *      or exactly `{ "react": "<range>" }` with
 *      `peerDependenciesMeta.react.optional === true` (ADR 0003 amendment
 *      2026-10-23: the React provider); anything else is refused, since a
 *      public SDK must not pull in private server code or a server peer.
 *      One more exception (analytics ADR 0003 amendment 2026-10-12):
 *      `dependencies` may also hold `@rrweb/record`, pinned exact, for the
 *      session recorder behind the `./recorder` entry. Only `src/recorder.ts`
 *      may import it, so the beacon bundle never carries rrweb.
 *
 * Rule 11, for every publishable package, checked against the real packed
 * tarball's own package.json (not the source manifest -- same reasoning as
 * rules 3/4): no `@wtfalch/*` peerDependency is pinned to an exact version.
 * check-wtfalch-pins.mjs (docs/adr/0016-peer-ranges.md) allows a peer to be
 * exact or a range; this rule is the other half -- an exact `@wtfalch/*`
 * peer conflicts with any host already on a newer patch, so a publishable
 * package must actually use the range room, not just be allowed it.
 * Skipped, like rules 3/4, until the package has been built.
 *
 * Rule 12, for every publishable package, once built: every export without a
 * `*` imports by name, through `exports`, from the package's own directory
 * (a deleted `exports` entry or a missing built file fails here, not in a
 * consumer). A package with a `src/migrations/` directory must export
 * `./migrations-dir`, and the built directory that export names must hold
 * exactly one `.sql` per `src/migrations` entry (docs/adr/0006-migrations.md).
 * The trigger is the directory, not `src/migrations-dir.ts`, so deleting that
 * file and its export together does not switch the rule off. The migrations
 * half also runs for the service package, which is private and never packed
 * but whose built `migrations-dir.js` the Dockerfile copies into the image.
 *
 * Modelled on storage's scripts/verify-sdk.mjs (rules 1-4 and 10),
 * generalised here to both estate shapes and to every workspace package.
 * Like that script, this one always inspects the real tarball rather
 * than trusting the manifest.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPackages } from './lib/workspace.mjs';

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL('../', import.meta.url));

const problems = [];
const summaries = [];

/** Exactly `1.2.3`, optionally with a prerelease/build suffix. Same shape check-wtfalch-pins.mjs uses. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The one non-estate dependency an SDK may have, and the only source file that may import it. */
const RECORDER_DEPENDENCY = '@rrweb/record';
const RECORDER_SOURCE = 'recorder.ts';

/** Non-test source files under `<dir>/src` (posix names relative to it) that mention `needle`. */
function sourceFilesMentioning(dir, needle) {
  const srcDir = path.join(dir, 'src');
  if (!existsSync(srcDir)) return [];
  const hits = [];
  (function walk(sub) {
    for (const name of readdirSync(path.join(srcDir, sub))) {
      const rel = path.posix.join(sub, name);
      if (statSync(path.join(srcDir, rel)).isDirectory()) {
        if (name !== 'test') walk(rel);
      } else if (/\.[cm]?[jt]sx?$/.test(name) && !/\.test\.[cm]?[jt]sx?$/.test(name)) {
        if (readFileSync(path.join(srcDir, rel), 'utf8').includes(needle)) hits.push(rel);
      }
    }
  })('');
  return hits;
}

function fail(pkg, rule, message) {
  problems.push(`${pkg.manifest.name ?? pkg.relDir} (${pkg.relDir}) [${rule}]: ${message}`);
}

/** Expand a `files` entry against what is really on disk under `dir`, as posix paths. */
function expandFilesEntry(dir, entry) {
  const abs = path.join(dir, entry);
  if (!existsSync(abs)) return [entry]; // reported missing elsewhere; keep it in the expected set
  if (!statSync(abs).isDirectory()) return [entry];
  const out = [];
  (function walk(sub) {
    for (const name of readdirSync(path.join(abs, sub))) {
      if (name.startsWith('.')) continue; // never a legitimate build artifact
      const rel = path.posix.join(sub, name);
      if (statSync(path.join(abs, rel)).isDirectory()) walk(rel);
      else out.push(path.posix.join(entry, rel));
    }
  })('');
  return out;
}

/** Import `specifier` from `dir` the way a consumer would; returns its `migrationsDir` ('' if none). */
function importByName(dir, specifier) {
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(specifier)}); console.log(m.migrationsDir ?? '')`,
    ],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** Rule 12, migrations half: see the header. Runs for any package with `src/migrations/`. */
function checkMigrationsDir(pkg) {
  const { manifest, dir } = pkg;
  if (!existsSync(path.join(dir, 'src', 'migrations'))) return;
  if (!manifest.exports?.['./migrations-dir']) {
    fail(
      pkg,
      'migrations-dir.export',
      'src/migrations exists but "exports" has no "./migrations-dir"',
    );
    return;
  }
  try {
    const built = importByName(dir, `${manifest.name}/migrations-dir`);
    const sqlIn = (directory) =>
      existsSync(directory)
        ? readdirSync(directory)
            .filter((name) => name.endsWith('.sql'))
            .sort()
        : [];
    const want = sqlIn(path.join(dir, 'src', 'migrations'));
    const have = sqlIn(built);
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      fail(
        pkg,
        'migrations-dir.files',
        `migrationsDir (${built}) holds ${JSON.stringify(have)}, src/migrations holds ${JSON.stringify(want)}`,
      );
    }
  } catch (err) {
    fail(pkg, 'migrations-dir.files', `could not read migrationsDir: ${err.message}`);
  }
}

const packages = loadPackages(root);
/**
 * The names of the private service packages, so a public package can be
 * recognised as the service shape's SDK.
 *
 * The relationship is by NAME, not by directory. Keying off "sits in the same
 * parent directory" looked right and was wrong: on this template's own `main`
 * both shapes are present, so `packages/widget` — a library package that is
 * allowed its optional authz peer — shares `packages/` with
 * `packages/service` and was refused a peer dependency it is entitled to.
 * `@wtfalch/reporting` is the SDK for `@wtfalch/reporting-service` because of what it
 * is called.
 */
const serviceNames = new Set(
  packages.map((pkg) => pkg.manifest.name ?? '').filter((name) => name.endsWith('-service')),
);

for (const pkg of packages) {
  const { manifest, dir, relDir } = pkg;
  const name = manifest.name ?? relDir;

  if ((manifest.name ?? '').endsWith('-service')) {
    if (manifest.private !== true) {
      fail(
        pkg,
        'service.private',
        `"private" must be true, got ${JSON.stringify(manifest.private)}`,
      );
    }
    if (manifest.publishConfig !== undefined) {
      fail(pkg, 'service.publishConfig', 'must have no "publishConfig"');
    }
    const prepublish = manifest.scripts?.prepublishOnly;
    if (!prepublish || !/throw|exit\s+1|process\.exit\(\s*1\s*\)/.test(prepublish)) {
      fail(
        pkg,
        'service.prepublishOnly',
        `"scripts.prepublishOnly" must exist and throw/exit non-zero, got ${JSON.stringify(prepublish)}`,
      );
    }
    checkMigrationsDir(pkg);
    summaries.push(`${name}: service package, unpublishable`);
    continue;
  }

  if (manifest.private === true) {
    summaries.push(`${name}: private, not publishable, skipped`);
    continue;
  }

  // Rule 1
  if (manifest.publishConfig?.access !== 'public') {
    fail(
      pkg,
      'publishConfig.access',
      `must be "public", got ${JSON.stringify(manifest.publishConfig?.access)}`,
    );
  }

  // Rule 2
  const files = manifest.files;
  const filesOk = Array.isArray(files) && files.length > 0;
  if (!filesOk) {
    fail(pkg, 'files', `"files" must be a non-empty array, got ${JSON.stringify(files)}`);
  } else {
    if (!files.includes('README.md')) fail(pkg, 'files.readme', '"files" must include "README.md"');
    if (!files.includes('LICENSE')) fail(pkg, 'files.license', '"files" must include "LICENSE"');
    for (const entry of files) {
      if (entry === 'README.md' || entry === 'LICENSE') continue;
      if (!entry.startsWith('dist')) {
        fail(
          pkg,
          'files.dist-prefix',
          `every other "files" entry must start with "dist", got ${JSON.stringify(entry)}`,
        );
      }
    }
  }

  // Rule 5
  if (
    !('sideEffects' in manifest) ||
    (manifest.sideEffects !== false && !Array.isArray(manifest.sideEffects))
  ) {
    fail(
      pkg,
      'sideEffects',
      `"sideEffects" must be false or an array, got ${JSON.stringify(manifest.sideEffects)}`,
    );
  }

  // Rule 6
  const posixRelDir = relDir.split(path.sep).join('/');
  if (manifest.repository?.directory !== posixRelDir) {
    fail(
      pkg,
      'repository.directory',
      `must equal "${posixRelDir}", got ${JSON.stringify(manifest.repository?.directory)}`,
    );
  }

  // Rule 10
  if (serviceNames.has(`${manifest.name}-service`)) {
    const deps = Object.keys(manifest.dependencies ?? {});
    const peers = manifest.peerDependencies ?? {};
    const peerDeps = Object.keys(peers);
    const allowedPeers =
      peerDeps.length === 0 ||
      (peerDeps.length === 1 &&
        typeof peers.react === 'string' &&
        !EXACT_VERSION.test(peers.react) &&
        manifest.peerDependenciesMeta?.react?.optional === true);
    const allowedDeps = deps.every(
      (dep) => dep === '@wtfalch/contracts' || dep === RECORDER_DEPENDENCY,
    );
    if (!allowedDeps) {
      fail(
        pkg,
        'sdk.dependencies',
        `must be empty/absent or hold only "@wtfalch/contracts" and "${RECORDER_DEPENDENCY}", each pinned to an exact version: this is the SDK for ${manifest.name}-service, got ${JSON.stringify(manifest.dependencies)}`,
      );
    }
    const recorderRange = manifest.dependencies?.[RECORDER_DEPENDENCY];
    if (recorderRange !== undefined) {
      if (typeof recorderRange !== 'string' || !EXACT_VERSION.test(recorderRange)) {
        fail(
          pkg,
          'sdk.dependencies',
          `${RECORDER_DEPENDENCY} must be pinned to an exact version, got ${JSON.stringify(recorderRange)}`,
        );
      }
      for (const file of sourceFilesMentioning(dir, RECORDER_DEPENDENCY)) {
        if (file !== RECORDER_SOURCE) {
          fail(
            pkg,
            'sdk.dependencies',
            `only src/${RECORDER_SOURCE} (the ./recorder entry) may use ${RECORDER_DEPENDENCY}, found it in src/${file}`,
          );
        }
      }
    }
    if (!allowedPeers) {
      fail(
        pkg,
        'sdk.peerDependencies',
        `must be empty/absent or exactly { "react": "<range>" } marked optional in peerDependenciesMeta: this is the SDK for ${manifest.name}-service, got ${JSON.stringify(manifest.peerDependencies)}`,
      );
    }
  }

  // Rules 3 + 4: only once the package has actually been built.
  const distDir = path.join(dir, 'dist');
  if (!existsSync(distDir)) {
    summaries.push(`${name}: not built, skipping tarball check`);
    continue;
  }

  const readmePath = path.join(dir, 'README.md');
  const licensePath = path.join(dir, 'LICENSE');
  const readmeExists = existsSync(readmePath);
  const licenseExists = existsSync(licensePath);
  if (!readmeExists) {
    fail(
      pkg,
      'files.readme',
      `README.md declared in "files" but missing on disk at ${relDir}/README.md`,
    );
  }
  if (!licenseExists) {
    fail(
      pkg,
      'files.license',
      `LICENSE declared in "files" but missing on disk at ${relDir}/LICENSE`,
    );
  }
  if (!readmeExists || !licenseExists || !filesOk) {
    continue; // already reported; nothing more useful to say about the tarball
  }

  // Rule 12
  for (const subpath of Object.keys(manifest.exports ?? {})) {
    if (subpath.includes('*') || subpath === './package.json') continue;
    try {
      importByName(dir, subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`);
    } catch (err) {
      fail(
        pkg,
        'exports.import',
        `import of "${subpath}" through "exports" failed: ${String(err.stderr ?? err.message)
          .trim()
          .split('\n')
          .at(-1)}`,
      );
    }
  }
  checkMigrationsDir(pkg);

  const expected = new Set(['package.json']);
  for (const entry of files) {
    for (const resolved of expandFilesEntry(dir, entry)) expected.add(resolved);
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'reporting-pack-'));
  try {
    const output = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp],
      {
        cwd: dir,
        encoding: 'utf8',
        // This script itself runs inside `packages/sdk`'s prepublishOnly, so
        // an outer `npm publish --dry-run` has already set
        // npm_config_dry_run=true in this process's own environment -- npm
        // exports every CLI flag it was invoked with as npm_config_* for
        // child processes to read. Left inherited, this nested `npm pack`
        // would honour that flag too and produce no tarball at all, which
        // read as "npm pack failed" rather than what it actually was
        // (nothing to inspect). `npm pack` always needs a real tarball here,
        // regardless of what invoked this script (#14).
        env: { ...process.env, npm_config_dry_run: 'false' },
      },
    );
    const [packed] = JSON.parse(output);
    const tarball = path.join(tmp, packed.filename);
    const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((entry) => entry.replace(/^package\//, ''))
      .sort();
    const expectedSorted = [...expected].sort();
    const missing = expectedSorted.filter((entry) => !entries.includes(entry));
    const stray = entries.filter((entry) => !expectedSorted.includes(entry));
    if (missing.length > 0 || stray.length > 0) {
      fail(
        pkg,
        'tarball',
        `real tarball does not match "files": missing ${JSON.stringify(missing)}, stray ${JSON.stringify(stray)}`,
      );
    } else {
      summaries.push(`${name}: tarball matches "files" exactly (${entries.length} entries)`);
    }

    // Rule 11: read the packed package.json back out of the real tarball
    // (not `manifest` -- a prepack step could in principle rewrite it) and
    // check its peerDependencies, the same way rules 3/4 trust the tarball
    // over the source tree.
    const packedManifestRaw = execFileSync('tar', ['-xzf', tarball, '-O', 'package/package.json'], {
      encoding: 'utf8',
    });
    const packedManifest = JSON.parse(packedManifestRaw);
    for (const [dep, range] of Object.entries(packedManifest.peerDependencies ?? {})) {
      if (!dep.startsWith('@wtfalch/')) continue;
      if (EXACT_VERSION.test(range)) {
        fail(
          pkg,
          'peerDependencies.range',
          `${dep} peer is pinned exactly ("${range}") in the packed tarball; a @wtfalch/* peer must be a range (docs/adr/0016-peer-ranges.md)`,
        );
      }
    }
  } catch (err) {
    // `npm pack`/`tar` failing outright (bad manifest fields, unreadable
    // file, etc.) is itself a contract violation worth naming cleanly,
    // not an uncaught crash that skips every package after it.
    fail(pkg, 'tarball', `\`npm pack\` failed: ${err.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (problems.length > 0) {
  console.error('check-package: public-surface contract violations:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log('check-package:');
for (const summary of summaries) console.log(`  ${summary}`);
