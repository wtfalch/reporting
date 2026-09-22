import { z } from 'zod';

/**
 * What a row may hold, refused in TypeScript before it is queued and again by
 * the table's CHECKs. The two lists that matter for privacy, `BANNED_KEYS` and
 * the flatness rule, are here and in `migrations/0001_reporting.sql`, and
 * `schema.test.ts` reads the SQL to pin them equal.
 */

export const LEVELS = ['info', 'warn', 'error', 'alert'] as const;
export type Level = (typeof LEVELS)[number];

export const ACTOR_CLASSES = ['human', 'api_key', 'agent', 'service'] as const;
export type ActorClass = (typeof ACTOR_CLASSES)[number];

export const ERROR_STATES = ['open', 'resolved', 'ignored'] as const;
export type ErrorState = (typeof ERROR_STATES)[number];

export const ERROR_RUNTIMES = ['server', 'edge', 'browser'] as const;
export type ErrorRuntime = (typeof ERROR_RUNTIMES)[number];

/** `namespace.name`: one dot, lower case, digits and underscores. */
export const KIND_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
export const SITE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** sha256 of the kind and the top normalised frames, truncated to 32 hex, lower case. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Keys a `data` object may not carry, because each names a person or a
 * secret. A guardrail against the accidental case, not proof of absence: a
 * string under any other key can still hold an address, and review is the
 * third net.
 */
export const BANNED_KEYS = [
  'email',
  'name',
  'display_name',
  'displayName',
  'password',
  'secret',
  'token',
  'authorization',
] as const;

export const LIMITS = {
  message: 512,
  actorId: 256,
  requestId: 128,
  targetType: 64,
  targetId: 256,
  dataBytes: 16384,
  site: 64,
  stack: 16384,
} as const;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** Flat, bounded, banned keys refused, numbers finite. */
export const flatDataSchema = z.record(z.string(), scalar).superRefine((data, ctx) => {
  for (const key of Object.keys(data)) {
    if ((BANNED_KEYS as readonly string[]).includes(key)) {
      ctx.addIssue({ code: 'custom', path: [key], message: `"${key}" may not be a data key` });
    }
    const value = data[key];
    if (typeof value === 'number' && !Number.isFinite(value)) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'must be a finite number' });
    }
  }
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > LIMITS.dataBytes) {
    ctx.addIssue({
      code: 'custom',
      message: `must serialise to at most ${LIMITS.dataBytes} bytes`,
    });
  }
});
export type FlatData = z.infer<typeof flatDataSchema>;

const bounded = (max: number) => z.string().min(1).max(max);

/**
 * `z.object`, not strict: a host hands over its resolved principal, which
 * carries a display name and an address beside `class` and `id`, and those
 * must be dropped rather than refused. Stripping is the privacy behaviour;
 * refusing would make every host's call site narrow by hand, and the first
 * one did not.
 */
export const actorSchema = z.object({
  class: z.enum(ACTOR_CLASSES),
  id: bounded(LIMITS.actorId),
});
export type Actor = z.infer<typeof actorSchema>;

export const targetSchema = z.object({
  type: bounded(LIMITS.targetType),
  id: bounded(LIMITS.targetId),
});

/** What a caller hands `event()`. Everything else on the row is the writer's. */
export const eventInputSchema = z.strictObject({
  kind: z.string().regex(KIND_PATTERN, 'a kind is namespace.name, lower case'),
  message: bounded(LIMITS.message),
  level: z.enum(LEVELS).default('info'),
  tenantId: z.uuid().nullish(),
  actor: actorSchema.nullish(),
  requestId: bounded(LIMITS.requestId).nullish(),
  target: targetSchema.nullish(),
  data: flatDataSchema.default({}),
  occurredAt: z.date().optional(),
});
export type EventInput = z.input<typeof eventInputSchema>;
export type ValidEvent = z.output<typeof eventInputSchema>;

export const siteSchema = z
  .string()
  .regex(SITE_PATTERN, 'a site id is lower case, digits and dashes');

/**
 * Deploy target, not per-event: stamped once on `ReportingOptions.environment`,
 * the same as `site`, because a preview or stage deploy is a whole process
 * running with that value, not a claim an individual event makes (gap issue
 * #6). Unlike `runtime` or `level`, the set of names is not fixed -- a host
 * may run `production`/`stage`/`preview`, or its own scheme -- so this only
 * keeps it slug-shaped.
 */
export const ENVIRONMENT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const environmentSchema = z
  .string()
  .regex(ENVIRONMENT_PATTERN, 'an environment is lower case, digits, dashes and underscores');

export const fingerprintSchema = z
  .string()
  .regex(FINGERPRINT_PATTERN, 'a fingerprint is 32 lower-case hex characters');
