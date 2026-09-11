import type { ReactNode } from 'react';

/**
 * Two server-renderable pictures for the readers' pages, inline SVG with no
 * dependency: a sparkline over a series and a bar list over buckets. Colours
 * come from `currentColor` and CSS variables the host sets, so the host's
 * theme applies.
 */

export function Sparkline(props: {
  readonly points: readonly { readonly day: string; readonly value: number }[];
  readonly width?: number;
  readonly height?: number;
  readonly label?: string;
}) {
  const w = props.width ?? 320;
  const h = props.height ?? 64;
  const values = props.points.map((p) => p.value);
  const max = Math.max(1, ...values);
  const n = Math.max(1, values.length - 1);
  const coords = values.map(
    (v, i) => [(i / n) * (w - 2) + 1, h - 1 - (v / max) * (h - 2)] as const,
  );
  const line = coords
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  const area = coords.length > 0 ? `${line} L${(w - 1).toFixed(1)} ${h - 1} L1 ${h - 1} Z` : '';
  const last = coords.at(-1);
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      height={h}
      role="img"
      aria-label={props.label ?? `${values.length} days, up to ${max}`}
      preserveAspectRatio="none"
      style={{ display: 'block', maxWidth: '100%' }}
    >
      <title>{props.label ?? `${values.length} days, up to ${max}`}</title>
      {area ? <path d={area} fill="currentColor" opacity="0.12" /> : null}
      {line ? <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}
      {last ? <circle cx={last[0]} cy={last[1]} r="2.5" fill="currentColor" /> : null}
    </svg>
  );
}

export function BarList(props: {
  readonly items: readonly {
    readonly key: string;
    readonly value: number;
    readonly hint?: ReactNode;
  }[];
  readonly label?: string;
}) {
  const max = Math.max(1, ...props.items.map((i) => i.value));
  return (
    <ol
      data-reporting-bars=""
      aria-label={props.label}
      style={{ listStyle: 'none', margin: 0, padding: 0 }}
    >
      {props.items.map((item) => (
        <li
          key={item.key}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: '0.5rem',
            alignItems: 'center',
            padding: '0.25rem 0',
          }}
        >
          <div style={{ position: 'relative', minWidth: 0 }}>
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                inset: 0,
                width: `${(item.value / max) * 100}%`,
                background: 'currentColor',
                opacity: 0.1,
                borderRadius: 2,
              }}
            />
            <span
              style={{
                position: 'relative',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'block',
                padding: '0 0.375rem',
              }}
            >
              {item.key}
              {item.hint ? (
                <span style={{ opacity: 0.6, marginLeft: '0.5rem' }}>{item.hint}</span>
              ) : null}
            </span>
          </div>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{item.value.toLocaleString()}</span>
        </li>
      ))}
    </ol>
  );
}
