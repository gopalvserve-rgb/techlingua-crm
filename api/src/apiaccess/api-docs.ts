/**
 * API DOCUMENTATION — the human descriptions for the public, key-authed endpoints.
 *
 * The AUTHORITATIVE list of endpoints is reflected off PublicApiController at
 * request time (see ApiKeysController.docs), so a route can never appear in the
 * docs without existing, nor exist without being listed. This file supplies the
 * prose, headers and worked examples keyed by `METHOD /full/path`; a test asserts
 * every reflected public route has an entry here, so the docs cannot silently
 * drift from the routes.
 */

export interface ApiDocParam { name: string; required: boolean; note: string }
export interface ApiEndpointDoc {
  summary: string;
  description: string;
  headers: string[];
  params?: ApiDocParam[];
  exampleRequest?: unknown;
  exampleResponse: unknown;
}

const AUTH_HEADERS = [
  'Authorization: Bearer tlk_live_xxxxxxxx   (or)   X-API-Key: tlk_live_xxxxxxxx',
  'Content-Type: application/json',
];

/** Keyed by `METHOD /api/public-api/<path>` — the full path a client calls. */
export const API_ENDPOINT_DOCS: Record<string, ApiEndpointDoc> = {
  'POST /api/public-api/leads': {
    summary: 'Create a lead',
    description:
      'Push a new lead into the CRM. The lead goes through the SAME ingestion pipeline as '
      + 'the CSV import and the Meta/Google/website capture channels: phones are normalised '
      + 'to E.164, the target campaign\'s duplicate rule is applied, the campaign\'s assignment '
      + '(round-robin / conditional / on-demand) runs, and everything is audited. Sending the '
      + 'same "external_id" twice never creates a second lead. If the key has a default campaign '
      + 'and source, "campaign_id"/"source_id" may be omitted.',
    headers: AUTH_HEADERS,
    params: [
      { name: 'name', required: true, note: 'Lead full name (alias: full_name).' },
      { name: 'phone', required: true, note: 'Mobile number, any format; normalised to E.164.' },
      { name: 'email', required: false, note: 'Email address.' },
      { name: 'course', required: false, note: 'Course name or id (resolved against the Course master).' },
      { name: 'campaign_id', required: false, note: 'Target campaign. Falls back to the key\'s default.' },
      { name: 'source_id', required: false, note: 'Target source. Falls back to the key\'s default.' },
      { name: 'external_id', required: false, note: 'Your own record id. Makes the call idempotent — a replay is a no-op.' },
      { name: 'note', required: false, note: 'A free-text note stored on the lead.' },
    ],
    exampleRequest: {
      name: 'Asha Nair',
      phone: '+91 90000 12345',
      email: 'asha@example.com',
      course: 'IELTS',
      external_id: 'web-2026-07-24-0012',
      note: 'Enquired via partner site',
    },
    exampleResponse: {
      ok: true,
      status: 'created',
      lead_id: 1234,
      duplicate_of: null,
      message: 'Lead created.',
    },
  },
  'GET /api/public-api/leads': {
    summary: 'List leads',
    description:
      'Return the most recent leads the key may see, newest first. Supports "limit" (max 200) '
      + 'and "offset" for paging. A key reads at its configured record scope (org-wide by default).',
    headers: ['Authorization: Bearer tlk_live_xxxxxxxx   (or)   X-API-Key: tlk_live_xxxxxxxx'],
    params: [
      { name: 'limit', required: false, note: 'Page size, 1–200 (default 50).' },
      { name: 'offset', required: false, note: 'Rows to skip (default 0).' },
    ],
    exampleResponse: {
      count: 1,
      leads: [
        {
          id: 1234,
          full_name: 'Asha Nair',
          phone: '+919000012345',
          email: 'asha@example.com',
          stage: 'New Lead',
          status: null,
          campaign: 'Partner Web',
          source: 'Website',
          created_at: '2026-07-24T09:12:00.000Z',
        },
      ],
    },
  },
  'GET /api/public-api/health': {
    summary: 'Health / authentication check',
    description:
      'A liveness probe. With a valid, enabled key it returns your key\'s name and capabilities — '
      + 'the quickest way to confirm your credential works before wiring anything up.',
    headers: ['Authorization: Bearer tlk_live_xxxxxxxx   (or)   X-API-Key: tlk_live_xxxxxxxx'],
    exampleResponse: {
      ok: true,
      key: 'Partner integration',
      scopes: ['lead:create', 'lead:read'],
    },
  },
};
