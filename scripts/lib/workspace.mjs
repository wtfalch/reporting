/**
 * Shared workspace discovery for the guard scripts in this directory.
 *
 * Reads `pnpm-workspace.yaml`'s `packages:` list and expands each entry --
 * either a literal directory or a one-level `dir/*` glob, which is all this
 * repo ever uses -- into the package.json manifests found there.
 *
 * Scoping discovery to these globs, instead of walking the whole repo,
 * keeps `bootstrap/`'s template files (which are not workspace packages)
 * out of every guard script, and lets a package that a sibling agent has
 * not written yet simply be absent rather than a crash.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** The `packages:` glob entries from pnpm-workspace.yaml, or []. */
export function readWorkspacePatterns(root) {
  let text;
  try {
    text = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return [];
  }
  const patterns = [];
  let inPackages = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '');
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item) {
      patterns.push(item[1].replace(/^['"]|['"]$/g, ''));
    } else if (/^\S/.test(line)) {
      inPackages = false;
    }
  }
  return patterns;
}

/** Absolute directories a workspace glob pattern resolves to, sorted. */
export function expandPackageDirs(root, patterns) {
  const dirs = new Set();
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const parent = path.join(root, pattern.slice(0, -2));
      let entries;
      try {
        entries = readdirSync(parent, { withFileTypes: true });
      } catch {
        continue; // e.g. packages/ not created yet: skip gracefully
      }
      for (const entry of entries) {
        if (entry.isDirectory()) dirs.add(path.join(parent, entry.name));
      }
    } else {
      const dir = path.join(root, pattern);
      if (existsSync(dir) && statSync(dir).isDirectory()) dirs.add(dir);
    }
  }
  return [...dirs].sort();
}

/** Every workspace package with a readable package.json, as {dir, relDir, manifest}. */
export function loadPackages(root) {
  const dirs = expandPackageDirs(root, readWorkspacePatterns(root));
  const packages = [];
  for (const dir of dirs) {
    const manifestPath = path.join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue; // package not written yet: skip gracefully
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      console.warn(
        `warn: ${path.relative(root, manifestPath)} is not valid JSON, skipping (${err.message})`,
      );
      continue;
    }
    packages.push({ dir, relDir: path.relative(root, dir), manifest });
  }
  return packages;
}

/**
 * The one workspace package that `release.yml` publishes: not private, and
 * `publishConfig.access === "public"`.
 *
 * This is the single definition of that question. It had three: this file's
 * callers, the CI resolver under `.github/scripts/`, and the bootstrap CLI's
 * npm-publisher step. Three answers that agree today and can disagree
 * tomorrow, about which artifact goes on npm under the estate's name.
 *
 * Throws unless there is exactly one, naming what it found. Zero means the
 * shape was pruned wrongly or a manifest lost its `publishConfig`; more than
 * one means a private package stopped being private.
 */
export function findPublishablePackage(root) {
  const publishable = loadPackages(root).filter(
    (pkg) => pkg.manifest.private !== true && pkg.manifest.publishConfig?.access === 'public',
  );
  if (publishable.length !== 1) {
    const found = publishable.map((pkg) => pkg.relDir).join(', ') || 'none';
    throw new Error(
      [
        `expected exactly one publishable workspace package (not private, publishConfig.access === "public"), found ${publishable.length}: ${found}`,
        publishable.length > 1
          ? 'A package that should be private (such as @wtfalch/reporting-core or the service) is not.'
          : 'This repo has exactly one, packages/sdk. Zero means a manifest lost its publishConfig.',
      ].join('\n'),
    );
  }
  return publishable[0];
}
