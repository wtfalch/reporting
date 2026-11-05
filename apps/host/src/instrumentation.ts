function warn(variable: string, consequence: string): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      message: `reporting: ${variable} is not set: ${consequence}`,
      meta: { variable },
    }),
  );
}

/**
 * Runs once when the server starts, and injects the production composition.
 *
 * Site keys and the audit log live in this backend's own database, and every
 * operator route (`POST /v1/site-keys`, `DELETE /v1/site-keys/:id`, the error
 * reads and the state change) is open to `REPORTING_OPERATOR_KEY` alone.
 * Unset, they refuse every caller. The tenant id is derived from
 * `AUTH_ORGANIZATION_ID`; unset, minting answers 503. Either one unset or
 * empty logs a warning at boot, naming the variable and never a value, so a
 * misconfigured deployment does not look healthy.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { configureProductionComposition } = await import('./lib/composition');
  const { tenantIdOf } = await import('@wtfalch/reporting-service');
  const organisationId = process.env.AUTH_ORGANIZATION_ID;
  if (!process.env.REPORTING_OPERATOR_KEY) {
    warn('REPORTING_OPERATOR_KEY', 'the operator routes will answer 401 to every caller');
  }
  if (!organisationId) {
    warn('AUTH_ORGANIZATION_ID', 'minting a site key will answer 503 not_configured');
  }
  configureProductionComposition({
    operatorKey: process.env.REPORTING_OPERATOR_KEY,
    tenantId: organisationId ? tenantIdOf(organisationId) : undefined,
  });
}
