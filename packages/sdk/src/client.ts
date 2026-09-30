import { type ClientOptions, createTransport } from './transport.js';
import type { CreateReportingRequest, ListReportingsResponse, Reporting } from './types.js';

export { ReportingApiError, type ClientOptions } from './transport.js';

export function createReportingClient(options: ClientOptions) {
  const call = createTransport(options);
  return {
    createReporting: (input: CreateReportingRequest) =>
      call<Reporting>('POST', '/v1/reportings', input),
    listReportings: (organisationId: string) =>
      call<ListReportingsResponse>(
        'GET',
        `/v1/reportings?${new URLSearchParams({ organisationId })}`,
      ),
  };
}
