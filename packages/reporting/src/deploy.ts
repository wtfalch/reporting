export type Color = 'blue' | 'green';

export interface DeployTags {
  readonly release: string | null;
  readonly color: Color | null;
}

/**
 * The release and color the platform gave this container
 * (`REPORTING_RELEASE`, `REPORTING_COLOR`). A color that is not blue or green
 * is null, so a bad value cannot fail a write on the column's CHECK.
 */
export function deployTags(env: NodeJS.ProcessEnv = process.env): DeployTags {
  const color = env.REPORTING_COLOR;
  const release = env.REPORTING_RELEASE?.slice(0, 128);
  return {
    release: release ? release : null,
    color: color === 'blue' || color === 'green' ? color : null,
  };
}
