import { describe, expect, it } from 'vitest';
import { BANNED_KEYS, KIND_PATTERN, LIMITS, eventInputSchema, flatDataSchema } from './schema.js';
import { MIGRATION_SQL } from './test/db.js';

describe('eventInputSchema', () => {
  const ok = { kind: 'forum.outbox_drained', message: 'sent 3' };

  it('accepts the minimum and fills the defaults', () => {
    const v = eventInputSchema.parse(ok);
    expect(v.level).toBe('info');
    expect(v.data).toEqual({});
  });

  it.each([
    ['no dot', { ...ok, kind: 'forum' }],
    ['two dots', { ...ok, kind: 'a.b.c' }],
    ['upper case', { ...ok, kind: 'Forum.drained' }],
    ['empty message', { ...ok, message: '' }],
    ['message too long', { ...ok, message: 'x'.repeat(LIMITS.message + 1) }],
    ['unknown level', { ...ok, level: 'debug' }],
    ['tenant not a uuid', { ...ok, tenantId: 'acme' }],
    ['actor without class', { ...ok, actor: { id: 'u1' } }],
    ['target without id', { ...ok, target: { type: 'mailbox' } }],
    ['unknown key on the input', { ...ok, extra: 1 }],
  ])('refuses %s', (_name, input) => {
    expect(eventInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('flatDataSchema', () => {
  it('accepts flat scalars and nulls', () => {
    expect(flatDataSchema.parse({ a: 1, b: 'x', c: true, d: null })).toEqual({
      a: 1,
      b: 'x',
      c: true,
      d: null,
    });
  });

  it.each([
    ['a nested object', { user: { id: 1 } }],
    ['an array', { ids: [1, 2] }],
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
  ])('refuses %s', (_name, data) => {
    expect(flatDataSchema.safeParse(data).success).toBe(false);
  });

  it.each(BANNED_KEYS)('refuses the banned key %s', (key) => {
    expect(flatDataSchema.safeParse({ [key]: 'x' }).success).toBe(false);
  });

  it('refuses a payload over the byte limit', () => {
    expect(flatDataSchema.safeParse({ big: 'x'.repeat(LIMITS.dataBytes) }).success).toBe(false);
  });
});

describe('the SQL and the TypeScript agree', () => {
  it('on the banned keys', () => {
    const m = /data \?\| array\[([^\]]+)\]/.exec(MIGRATION_SQL);
    expect(m?.[1]).toBeDefined();
    const inSql = (m?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort();
    expect(inSql).toEqual([...BANNED_KEYS].sort());
  });

  it('on the kind pattern', () => {
    const m = /kind ~ '([^']+)'/.exec(MIGRATION_SQL);
    expect(m?.[1]).toBe(KIND_PATTERN.source);
  });

  it('on the limits', () => {
    expect(MIGRATION_SQL).toContain(`length(message) between 1 and ${LIMITS.message}`);
    expect(MIGRATION_SQL).toContain(`octet_length(data::text) <= ${LIMITS.dataBytes}`);
    expect(MIGRATION_SQL).toContain(`length(actor_id) between 1 and ${LIMITS.actorId}`);
    expect(MIGRATION_SQL).toContain(`length(request_id) between 1 and ${LIMITS.requestId}`);
  });
});
