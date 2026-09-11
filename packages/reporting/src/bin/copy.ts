import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Migrations in this estate are hand-written SQL, numbered per app, applied
 * by psql on boot, additive. A package cannot own a number in an app's
 * sequence, so this copies any migration the app has not yet copied into the
 * app's `drizzle/` as the next numbers and records which in a manifest. The
 * same mechanism `@wtfalch/threads` uses; the manifest name differs.
 */

export const MANIFEST = '.reporting-migrations.json';

export interface Manifest {
  /** package file name -> the name it was copied to in the app */
  copied: Record<string, string>;
}

export interface CopyResult {
  copied: Array<{ from: string; to: string }>;
  manifest: Manifest;
}

const NUMBERED = /^(\d{4})_(.+\.sql)$/;

function readManifest(dir: string): Manifest {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) return { copied: {} };
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Manifest>;
  return { copied: parsed.copied ?? {} };
}

function nextNumber(dir: string): number {
  let max = -1;
  for (const name of readdirSync(dir)) {
    const m = NUMBERED.exec(name);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function copyMigrations(opts: { from: string; to: string; version?: string }): CopyResult {
  mkdirSync(opts.to, { recursive: true });
  const manifest = readManifest(opts.to);
  const copied: CopyResult['copied'] = [];
  const sources = readdirSync(opts.from)
    .filter((n) => NUMBERED.test(n))
    .sort();
  let next = nextNumber(opts.to);
  for (const name of sources) {
    if (manifest.copied[name]) continue;
    const rest = NUMBERED.exec(name)?.[2] ?? name;
    const target = `${String(next).padStart(4, '0')}_${rest}`;
    const body = readFileSync(join(opts.from, name), 'utf8');
    const header = `-- Copied from @wtfalch/reporting${opts.version ? ` ${opts.version}` : ''} (migrations/${name}) by reporting-migrations.\n-- Do not edit here; the next package version ships the next file.\n\n`;
    writeFileSync(join(opts.to, target), header + body);
    manifest.copied[name] = target;
    copied.push({ from: name, to: target });
    next += 1;
  }
  writeFileSync(join(opts.to, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { copied, manifest };
}

export function describeCopy(result: CopyResult): string {
  if (result.copied.length === 0) return 'reporting-migrations: nothing to copy';
  return result.copied
    .map((c) => `reporting-migrations: ${c.from} -> ${basename(c.to)}`)
    .join('\n');
}
