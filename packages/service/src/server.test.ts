import type { ResourceGrant } from '@wtfalch/authz';
import { resourceAccess } from '@wtfalch/authz';
import { accessInput } from '@wtfalch/authz/fixtures';
import type { ListReportingsResponse, Reporting } from '@wtfalch/reporting-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogue } from './catalogue.js';
import type { Queryable } from './db.js';
import { type ReportingCallerContext, createReportingHandler } from './server.js';
import { testDatabase } from './test/db.js';

const org = 'org-1';
const person = { id: 'person', class: 'human' as const };

function contextWith(permissions: string[]): ReportingCallerContext {
  return {
    applicationId: 'app',
    platformId: 'estate',
    access: resourceAccess(
      accessInput({
        catalogue,
        principal: person,
        organisationId: org,
        // The default fixture restrictions have an empty ceiling, which
        // denies every `offered: true` permission (`reportings:create`)
        // regardless of grants -- give the organisation and platform a
        // ceiling covering the whole catalogue, the same way
        // manage.test.ts does in the storage reference.
        restrictions: {
          kind: 'customer',
          state: 'active',
          ceiling: Object.keys(catalogue),
          selfDenied: [],
          denied: [],
          support: null,
        },
        grants: permissions.map(
          (permission): ResourceGrant => ({
            id: permission,
            applicationId: 'app',
            platformId: 'estate',
            boundary: { kind: 'organisation', organisationId: org },
            permission,
            recipient: { kind: 'principal', principal: person },
            scope: { kind: 'organisation' },
            relation: 'any',
          }),
        ),
      }),
    ),
  };
}

function createRequest(): Request {
  return new Request('https://reportings.test/v1/reportings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organisationId: org, name: 'Widget' }),
  });
}

describe('createReportingHandler', () => {
  it('refuses an unauthorised caller with 403 and never touches the store', async () => {
    let touched = false;
    const store: Queryable = {
      async query() {
        touched = true;
        throw new Error('store should not be touched');
      },
    };
    const audit = vi.fn(async () => {});
    const handler = createReportingHandler({
      store,
      resolveAccess: async () => contextWith([]),
      audit,
    });
    const response = await handler(createRequest());
    expect(response.status).toBe(403);
    expect(touched).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  let database: Awaited<ReturnType<typeof testDatabase>> | undefined;
  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it('lets an authorised caller create a reporting and audits it exactly once', async () => {
    database = await testDatabase();
    const audit = vi.fn(async () => {});
    const handler = createReportingHandler({
      store: database.db,
      resolveAccess: async () => contextWith(['reportings:create', 'reportings:read']),
      audit,
    });
    const createResponse = await handler(createRequest());
    expect(createResponse.status).toBe(201);
    const reporting = (await createResponse.json()) as Reporting;
    expect(reporting).toMatchObject({ organisationId: org, name: 'Widget' });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      operation: 'reportings:create',
      organisationId: org,
      resourceId: reporting.id,
    });

    const listResponse = await handler(
      new Request(`https://reportings.test/v1/reportings?organisationId=${org}`),
    );
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as ListReportingsResponse;
    expect(list.reportings).toEqual([reporting]);
  });

  it('answers 404 on an unknown path', async () => {
    const handler = createReportingHandler({
      store: { query: async () => [] },
      resolveAccess: async () => contextWith(['reportings:read']),
      audit: vi.fn(async () => {}),
    });
    const response = await handler(new Request('https://reportings.test/v1/other'));
    expect(response.status).toBe(404);
  });
});
