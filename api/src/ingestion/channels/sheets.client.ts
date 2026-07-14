import { createSign } from 'crypto';

/**
 * Minimal Google Sheets v4 reader — no googleapis dependency (the API is one GET).
 *
 * Two credential modes, both supplied by the client in Settings and stored
 * encrypted (see crypto.util.ts):
 *   1. service-account JSON (preferred) — we sign an RS256 JWT and exchange it
 *      for an access token at oauth2.googleapis.com. The client shares the sheet
 *      with the service account's client_email (Viewer).
 *   2. API key — only works when the sheet is "Anyone with the link · Viewer".
 *
 * NOTHING here is configured yet: Gopal has not supplied Google credentials. The
 * whole path is therefore built to degrade, not crash — `readValues` throws a
 * typed SheetNotConfiguredError that the poller turns into a skipped poll and the
 * UI shows as "Not configured", exactly like the SMS gateway's 503.
 */

export class SheetNotConfiguredError extends Error {
  readonly notConfigured = true;
  constructor(msg = 'Google Sheets not configured — add the Spreadsheet ID and a service-account JSON (or API key) in the channel settings') {
    super(msg);
    this.name = 'SheetNotConfiguredError';
  }
}

export type HttpFn = (url: string, init?: {
  method?: string; headers?: Record<string, string>; body?: string;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const defaultHttp: HttpFn = (url, init) => (globalThis as any).fetch(url, init);

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export interface SheetCreds { service_account_json?: string; api_key?: string }

export class SheetsClient {
  /** overridable so tests never touch the network */
  http: HttpFn = defaultHttp;

  private tokens = new Map<string, { token: string; expiresAt: number }>();

  /** Mint (and cache) an access token from a service-account key file. */
  async accessToken(saJsonRaw: string): Promise<string> {
    let sa: { client_email?: string; private_key?: string; token_uri?: string };
    try { sa = JSON.parse(saJsonRaw); } catch { throw new SheetNotConfiguredError('The service-account JSON is not valid JSON.'); }
    if (!sa.client_email || !sa.private_key) {
      throw new SheetNotConfiguredError('The service-account JSON is missing client_email / private_key.');
    }
    const cached = this.tokens.get(sa.client_email);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b64({ alg: 'RS256', typ: 'JWT' });
    const claim = b64({
      iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || TOKEN_URL,
      exp: now + 3600, iat: now,
    });
    const signer = createSign('RSA-SHA256');
    signer.update(`${head}.${claim}`);
    const sig = signer.sign(sa.private_key.replace(/\\n/g, '\n')).toString('base64url');
    const assertion = `${head}.${claim}.${sig}`;

    const res = await this.http(sa.token_uri || TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Google rejected the service account (${res.status}): ${text.slice(0, 200)}`);
    const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('Google returned no access token.');
    this.tokens.set(sa.client_email, {
      token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    });
    return json.access_token;
  }

  /**
   * Read a range. Returns the raw row matrix exactly as Google gives it
   * (row 1 = headers). Throws SheetNotConfiguredError when credentials are absent.
   */
  async readValues(sheetId: string, range: string, creds: SheetCreds): Promise<string[][]> {
    if (!sheetId) throw new SheetNotConfiguredError();
    const sa = (creds.service_account_json ?? '').trim();
    const key = (creds.api_key ?? '').trim();
    if (!sa && !key) throw new SheetNotConfiguredError();

    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range || 'A:Z')}`;
    let url = base;
    const headers: Record<string, string> = {};
    if (sa) headers.Authorization = `Bearer ${await this.accessToken(sa)}`;
    else url = `${base}?key=${encodeURIComponent(key)}`;

    const res = await this.http(url, { headers });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 403 || res.status === 404
        ? ' — check the Spreadsheet ID and that the sheet is shared with the service account (or link-viewable for an API key).'
        : '';
      throw new Error(`Google Sheets returned ${res.status}${hint}`);
    }
    const json = JSON.parse(text) as { values?: string[][] };
    return json.values ?? [];
  }
}
