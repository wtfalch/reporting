/** Public HTTP contracts for the Reporting service. Internal storage rows are never returned. */
export interface Reporting {
  id: string;
  organisationId: string;
  name: string;
  createdAt: string;
}

export interface CreateReportingRequest {
  organisationId: string;
  name: string;
}

export interface ListReportingsResponse {
  reportings: Reporting[];
}

/** The wire shape of a failed request, discriminated on `code` so a caller can
 * narrow on it. Every non-2xx response body has this shape. */
export type ReportingError =
  | { code: 'invalid_request'; message: string }
  | { code: 'unauthorized'; message: string }
  | { code: 'forbidden'; message: string }
  | { code: 'not_found'; message: string }
  | { code: 'unavailable'; message: string };

export type ReportingErrorCode = ReportingError['code'];
