import type { ReportingErrorRow } from '../tables.js';

/**
 * The operator's error list: a plain table over the rows `errorsPage()`
 * already returned, newest last-seen first — the same props-in split as
 * `charts.tsx`, no fetching and no client state. The stack and the rest of
 * one group's detail belong in a detail view, not here; this table only ever
 * renders the group's summary columns.
 */

export function ErrorsTable(props: {
  readonly rows: readonly ReportingErrorRow[];
  readonly label?: string;
}) {
  if (props.rows.length === 0) {
    return <p data-reporting-errors-empty="">No errors captured. All clear.</p>;
  }
  return (
    <table data-reporting-errors="" aria-label={props.label ?? 'Errors, newest last seen first'}>
      <thead>
        <tr>
          <th scope="col">Kind</th>
          <th scope="col">Message</th>
          <th scope="col">Occurrences</th>
          <th scope="col">First seen</th>
          <th scope="col">Last seen</th>
          <th scope="col">Runtime</th>
          <th scope="col">Release</th>
          <th scope="col">State</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr key={row.fingerprint}>
            <td>{row.kind}</td>
            <td
              style={{ maxWidth: '32rem', overflowWrap: 'anywhere', wordBreak: 'break-word' }}
              title={row.message}
            >
              {row.message}
            </td>
            {/*
              `occurrences` is a bigint on the wire: postgres-js hands it back
              as a string, and a count this large already loses precision the
              moment anything calls `Number()` on it. String(...) never does
              that conversion, so it is safe whether the value that reaches
              here is still a string or already a number.
            */}
            <td style={{ fontVariantNumeric: 'tabular-nums' }}>{String(row.occurrences)}</td>
            <td>{formatTimestamp(row.firstSeenAt)}</td>
            <td>{formatTimestamp(row.lastSeenAt)}</td>
            <td>{row.runtime}</td>
            <td>{row.release ?? '—'}</td>
            <td>{row.state}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatTimestamp(value: Date): string {
  return `${value.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}
