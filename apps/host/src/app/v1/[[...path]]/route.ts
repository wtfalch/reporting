import { sharedHost } from '@/lib/reporting-host';

// The `postgres` driver needs Node, not the edge runtime; every response is
// per-caller, so nothing here is safe to cache or pre-render statically.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The service answers GET, POST and DELETE (docs/plans/backend.md, "The
// contract"); it serves server callers and Boule, so there is no CORS and no
// OPTIONS here.
export function GET(request: Request) {
  return sharedHost().handleV1(request);
}
export function POST(request: Request) {
  return sharedHost().handleV1(request);
}
export function DELETE(request: Request) {
  return sharedHost().handleV1(request);
}
