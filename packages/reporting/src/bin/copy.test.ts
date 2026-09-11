import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST, copyMigrations, describeCopy } from './copy.js';

describe('copyMigrations', () => {
  it('copies as the next number, records it, and does nothing the second time', () => {
    const from = mkdtempSync(join(tmpdir(), 'rep-from-'));
    const to = mkdtempSync(join(tmpdir(), 'rep-to-'));
    writeFileSync(join(from, '0001_reporting.sql'), 'select 1;');
    writeFileSync(join(to, '0009_device_sign_in.sql'), '-- host');

    const first = copyMigrations({ from, to, version: '0.1.0' });
    expect(first.copied).toEqual([{ from: '0001_reporting.sql', to: '0010_reporting.sql' }]);
    expect(readFileSync(join(to, '0010_reporting.sql'), 'utf8')).toMatch(
      /^-- Copied from @wtfalch\/reporting 0\.1\.0 \(migrations\/0001_reporting\.sql\)/,
    );
    expect(JSON.parse(readFileSync(join(to, MANIFEST), 'utf8'))).toEqual({
      copied: { '0001_reporting.sql': '0010_reporting.sql' },
    });
    expect(describeCopy(first)).toContain('0001_reporting.sql -> 0010_reporting.sql');

    const second = copyMigrations({ from, to });
    expect(second.copied).toEqual([]);
    expect(describeCopy(second)).toBe('reporting-migrations: nothing to copy');
    expect(readdirSync(to).sort()).toEqual([
      MANIFEST,
      '0009_device_sign_in.sql',
      '0010_reporting.sql',
    ]);
  });
});
