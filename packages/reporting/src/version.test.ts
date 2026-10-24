import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release version', () => {
  it('matches the top CHANGELOG entry, on or after the 1.0.0 analytics removal', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    const changelog = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
    expect(changelog.match(/^## (\S+)/m)?.[1]).toBe(pkg.version);
    expect(Number(pkg.version.split('.')[0])).toBeGreaterThanOrEqual(1);
  });
});
