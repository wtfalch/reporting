import { BANNED_KEYS, KIND_PATTERN } from './schema.js';
import type { AlertFinding, FlatData } from './types.js';

/**
 * A finding becomes one `alert.<check>` row. Its `detail` is arbitrary and
 * often nested (a list of orphan rows, an object of counts), and the table
 * refuses nesting, so it is projected: an array becomes its count, an
 * object keeps its top-level scalars with banned keys dropped and nested
 * values named as such, anything else is described. Never the detail
 * wholesale: that is how an address ends up in an operational row.
 */

export function alertKind(check: string): string {
  const name = check
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '');
  const kind = `alert.${name || 'unnamed'}`;
  return KIND_PATTERN.test(kind) ? kind : 'alert.unnamed';
}

export function projectDetail(detail: unknown): FlatData {
  if (detail === undefined || detail === null) return {};
  if (Array.isArray(detail)) return { count: detail.length };
  if (typeof detail === 'object') {
    const out: FlatData = {};
    for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
      if ((BANNED_KEYS as readonly string[]).includes(key)) continue;
      if (value === null || typeof value === 'boolean') out[key] = value;
      else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : String(value);
      else if (typeof value === 'string') out[key] = value.slice(0, 500);
      else out[key] = '[nested]';
    }
    return out;
  }
  return { detail: String(detail).slice(0, 500) };
}

export function alertRow(finding: AlertFinding): {
  kind: string;
  level: 'alert';
  message: string;
  data: FlatData;
} {
  return {
    kind: alertKind(finding.check),
    level: 'alert',
    message: (finding.message || finding.check).slice(0, 512),
    data: { check: finding.check.slice(0, 200), ...projectDetail(finding.detail) },
  };
}
