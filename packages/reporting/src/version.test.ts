import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release version', () => {
  it('is a major release that matches the top CHANGELOG entry (the analytics removal is a breaking change)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    const changelog = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
    expect(pkg.version).toBe('1.0.0');
    expect(changelog.match(/^## (\S+)/m)?.[1]).toBe('1.0.0');
  });
});
