// The 0.1 type surface, locked (as analytics' surface-lock.ts).
//
// Every type name index.ts exports is imported and referenced here. An import
// of a name index.ts no longer exports is a compile error, so `pnpm
// typecheck` fails the moment the surface shrinks. This file is never built
// into dist: tsconfig.build.json excludes it.
//
// It catches removal, not addition -- a value export already has runtime
// callers in the tests, so its removal already fails them; this file exists
// for the type-only names nothing else would notice losing.

import type {
  Actor,
  AuditEvent,
  AuditEventRow,
  CreateReportingHandlerOptions,
  ErrorGroup,
  ErrorReport,
  ErrorRuntime,
  ErrorSeries,
  ErrorState,
  ErrorsList,
  IngestOptions,
  ListOptions,
  Logger,
  MintRequest,
  MintSiteKeyInput,
  MintedSiteKey,
  ReportingEnvironment,
  SeriesBucket,
  SeriesOptions,
  ServiceErrorCode,
  SiteKeyAuditEvent,
  SiteKeyBinding,
  SiteKeyCacheOptions,
  SiteKeyConfig,
  SiteKeyResolver,
  SiteKeyRow,
  StateAuditEvent,
  Tx,
} from './index.js';
import type { migrationSources, migrationsDir } from './migrations-dir.js';

/** Referencing each name is what makes its absence a compile error. */
export type LockedSurface = [
  Actor,
  AuditEvent,
  AuditEventRow,
  CreateReportingHandlerOptions,
  ErrorGroup,
  ErrorReport,
  ErrorRuntime,
  ErrorSeries,
  ErrorState,
  ErrorsList,
  IngestOptions,
  ListOptions,
  Logger,
  MintRequest,
  MintSiteKeyInput,
  MintedSiteKey,
  ReportingEnvironment,
  SeriesBucket,
  SeriesOptions,
  ServiceErrorCode,
  SiteKeyAuditEvent,
  SiteKeyBinding,
  SiteKeyCacheOptions,
  SiteKeyConfig,
  SiteKeyResolver,
  SiteKeyRow,
  StateAuditEvent,
  Tx,
];

/** The surface is 28 names. Changing it is a breaking change for the host. */
export type LockedSurfaceSize = 28;

/** The runtime exports outside `index.ts`: the subpath
 * `@wtfalch/reporting-service/migrations-dir`. */
export type LockedSubpaths = [typeof migrationsDir, typeof migrationSources];
