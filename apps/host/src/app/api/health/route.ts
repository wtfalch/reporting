import { sharedHealth } from '@/lib/reporting-host';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return sharedHealth()();
}
