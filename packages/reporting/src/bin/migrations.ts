#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyMigrations, describeCopy } from './copy.js';

/**
 * `reporting-migrations [dir]`: copy this package's migrations the app has
 * not yet copied into `dir` (default `drizzle`) as the next numbers.
 * Idempotent; run it after every upgrade of @wtfalch/reporting, then commit
 * what it wrote.
 */
const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', 'migrations');
const to = resolve(process.cwd(), process.argv[2] ?? 'drizzle');
let version: string | undefined;
try {
  version = (
    JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string }
  ).version;
} catch {
  version = undefined;
}
console.log(describeCopy(copyMigrations({ from, to, version })));
