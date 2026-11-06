import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Telemetry is off via NEXT_TELEMETRY_DISABLED=1 in the root Dockerfile's
// builder stage -- Next reads that at CLI invocation time, before this file
// is ever loaded, so there is no config field here that does the same thing.
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  transpilePackages: ['@wtfalch/reporting-service', '@wtfalch/reporting-core'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default config;
