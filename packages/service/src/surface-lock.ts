// The 0.1 type surface, locked.
//
// Every type name index.ts exports is imported and referenced here. An
// import of a name index.ts no longer exports is a compile error, so
// `pnpm typecheck` fails the moment the surface shrinks. This file is never
// built into dist: tsconfig.build.json excludes it, and nothing references
// this file at runtime.
//
// It catches removal, not addition -- a value export (createReporting,
// listReportings, catalogue, migrate, ServiceError) already has runtime callers
// in store.test.ts/server.test.ts, so its removal already fails those tests;
// this file exists for the type-only names nothing else would notice losing.

import type { CreateReportingInput, Database, Permission, Queryable } from './index.js';

/** Referencing each name is what makes its absence a compile error. */
export type LockedSurface = [CreateReportingInput, Database, Permission, Queryable];

/** The surface is 4 names. Changing it is a breaking change. */
export type LockedSurfaceSize = 4;
