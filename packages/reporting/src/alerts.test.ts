import { describe, expect, it } from 'vitest';
import { alertKind, alertRow, projectDetail } from './alerts.js';
import { flatDataSchema } from './schema.js';

describe('alertKind', () => {
  it.each([
    ['orphan_memberships', 'alert.orphan_memberships'],
    ['system-role-versions', 'alert.system_role_versions'],
    ['Break Glass Burst!', 'alert.break_glass_burst'],
    ['', 'alert.unnamed'],
    ['123', 'alert.unnamed'],
  ])('%s -> %s', (check, kind) => {
    expect(alertKind(check)).toBe(kind);
  });
});

describe('projectDetail', () => {
  it('turns an array into its count', () => {
    expect(projectDetail([{ a: 1 }, { a: 2 }])).toEqual({ count: 2 });
  });

  it('keeps top-level scalars, names nested values, drops banned keys', () => {
    const out = projectDetail({
      tenantId: 't1',
      count: 3,
      ok: false,
      nothing: null,
      email: 'a@b.c',
      rows: [1, 2, 3],
      nested: { deep: true },
    });
    expect(out).toEqual({
      tenantId: 't1',
      count: 3,
      ok: false,
      nothing: null,
      rows: '[nested]',
      nested: '[nested]',
    });
    expect(flatDataSchema.safeParse(out).success).toBe(true);
  });

  it('describes a scalar and nothing', () => {
    expect(projectDetail('x')).toEqual({ detail: 'x' });
    expect(projectDetail(undefined)).toEqual({});
  });

  it('always produces something the table accepts', () => {
    const row = alertRow({
      check: 'stuck_invitations',
      message: 'm'.repeat(600),
      detail: { email: 'leak@example.test', id: 'i1', failedSince: new Date(0) },
    });
    expect(row.kind).toBe('alert.stuck_invitations');
    expect(row.level).toBe('alert');
    expect(row.message).toHaveLength(512);
    expect(row.data).not.toHaveProperty('email');
    expect(row.data.failedSince).toBe('[nested]');
    expect(flatDataSchema.safeParse(row.data).success).toBe(true);
  });
});
