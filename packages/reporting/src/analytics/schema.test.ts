import { describe, expect, it } from 'vitest';
import {
  beaconBatchSchema,
  clampOccurredAt,
  countryOf,
  deviceOf,
  normalisePath,
  referrerHostOf,
} from './schema.js';

describe('normalisePath (A7)', () => {
  it('replaces identifiers, tokens and addresses with placeholders', () => {
    expect(normalisePath('/org/3f2504e0-4f89-11d3-9a0c-0305e82c3301/invoices/1234')).toBe(
      '/org/:id/invoices/:n',
    );
    expect(normalisePath('/invite/aGVsbG8td29ybGQtdG9rZW4tMTIz')).toBe('/invite/:x');
    expect(normalisePath('/people/ada@example.test')).toBe('/people/:x');
    expect(normalisePath('/reset/9f86d081884c7d659a2feaa0c55ad015')).toBe('/reset/:x');
    expect(normalisePath('/Docs/Getting-Started?token=abc#top')).toBe('/docs/getting-started');
    expect(normalisePath('')).toBe('/');
    expect(normalisePath('/%E0%A4%A')).toBe('/:x');
  });
  it('bounds the result', () => {
    expect(normalisePath(`/${'a/'.repeat(600)}`).length).toBeLessThanOrEqual(512);
  });
});

describe('the derived fields', () => {
  it('keeps only the referrer host', () => {
    expect(referrerHostOf('https://WWW.Example.com/path?q=1')).toBe('www.example.com');
    expect(referrerHostOf('not a url')).toBeNull();
    expect(referrerHostOf(null)).toBeNull();
  });
  it('classifies devices coarsely and discards the rest', () => {
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')).toBe(
      'mobile',
    );
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(
      deviceOf('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari'),
    ).toBe('mobile');
    expect(
      deviceOf('Mozilla/5.0 (Linux; Android 14; SM-X900) AppleWebKit/537.36 Chrome/120 Safari'),
    ).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15')).toBe(
      'desktop',
    );
    expect(deviceOf('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe('bot');
    expect(deviceOf(null)).toBe('unknown');
  });
  it('takes a country only from a real code', () => {
    expect(countryOf('NO')).toBe('NO');
    expect(countryOf('XX')).toBeNull();
    expect(countryOf('T1')).toBeNull();
    expect(countryOf('norway')).toBeNull();
  });
  it('clamps the beacon clock to ten minutes either side of arrival', () => {
    const received = new Date('2026-09-12T12:00:00Z');
    expect(clampOccurredAt(received.getTime() - 3_600_000, received).toISOString()).toBe(
      '2026-09-12T11:50:00.000Z',
    );
    expect(clampOccurredAt(received.getTime() + 3_600_000, received).toISOString()).toBe(
      '2026-09-12T12:10:00.000Z',
    );
    expect(clampOccurredAt(received.getTime() - 1000, received).toISOString()).toBe(
      '2026-09-12T11:59:59.000Z',
    );
  });
});

describe('the beacon batch schema', () => {
  const event = { name: 'page.view', at: 1, path: '/', props: {} };
  it('accepts a batch and refuses a user id, a nested prop, a banned key and an oversize batch', () => {
    expect(beaconBatchSchema.safeParse({ site: 'app', events: [event] }).success).toBe(true);
    expect(
      beaconBatchSchema.safeParse({ site: 'app', userId: 'u1', events: [event] }).success,
    ).toBe(false);
    expect(
      beaconBatchSchema.safeParse({ site: 'app', events: [{ ...event, props: { a: { b: 1 } } }] })
        .success,
    ).toBe(false);
    expect(
      beaconBatchSchema.safeParse({ site: 'app', events: [{ ...event, props: { email: 'x' } }] })
        .success,
    ).toBe(false);
    expect(
      beaconBatchSchema.safeParse({ site: 'app', events: Array.from({ length: 21 }, () => event) })
        .success,
    ).toBe(false);
    expect(
      beaconBatchSchema.safeParse({ site: 'app', events: [{ ...event, name: 'Bad Name' }] })
        .success,
    ).toBe(false);
    expect(
      beaconBatchSchema.safeParse({ site: 'app', visitorId: 'short', events: [event] }).success,
    ).toBe(false);
  });
});
