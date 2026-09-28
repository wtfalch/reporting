import { randomUUID } from 'node:crypto';
import type { Reporting } from '@wtfalch/reporting-sdk';
import type { Queryable } from './db.js';

interface ReportingRow extends Record<string, unknown> {
  id: string;
  organisation_id: string;
  name: string;
  created_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: ReportingRow): Reporting {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    name: row.name,
    createdAt: toIso(row.created_at),
  };
}

export interface CreateReportingInput {
  organisationId: string;
  name: string;
}

/** Parameterised SQL only, an organisation predicate on every query -- one
 * organisation must never see another's reportings. */
export async function createReporting(
  db: Queryable,
  input: CreateReportingInput,
): Promise<Reporting> {
  const rows = await db.query<ReportingRow>(
    'INSERT INTO reportings (id, organisation_id, name) VALUES ($1, $2, $3) ' +
      'RETURNING id, organisation_id, name, created_at',
    [randomUUID(), input.organisationId, input.name],
  );
  const row = rows[0];
  if (!row) throw new Error('Insert did not return a row');
  return fromRow(row);
}

export async function listReportings(db: Queryable, organisationId: string): Promise<Reporting[]> {
  const rows = await db.query<ReportingRow>(
    'SELECT id, organisation_id, name, created_at FROM reportings ' +
      'WHERE organisation_id = $1 ORDER BY created_at ASC, id ASC',
    [organisationId],
  );
  return rows.map(fromRow);
}
