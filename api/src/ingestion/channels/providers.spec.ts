import {
  PROVIDERS, formToPayload, googleToPayload, metaToPayload, missingRequirements,
  parseFieldMap, sheetRowToPayload,
} from './providers';

describe('provider registry', () => {
  it('the Available Tools grid is EXACTLY the client\'s 12 tools (DEF-INT-01)', () => {
    // The grid = the non-hidden providers (what ChannelService.providers() returns).
    const visible = Object.values(PROVIDERS).filter((p) => !p.hidden).map((p) => p.key).sort();
    expect(visible).toEqual([
      '99acres', 'custom', 'google_ads', 'google_form', 'google_sheet',
      'housing', 'indiamart', 'justdial', 'meta', 'meta_whatsapp', 'tradeindia', 'webhook',
    ]);
    expect(visible).toHaveLength(12);
    // Meta WhatsApp is present and deep-links to Settings; the website form is HIDDEN, not deleted
    // (existing website channels + ingestion keep working), so it never shows in the grid.
    expect(PROVIDERS.meta_whatsapp?.deeplink).toBeTruthy();
    expect(PROVIDERS.website?.hidden).toBe(true);
    expect(visible).not.toContain('website');
  });

  it('is generic: JustDial/IndiaMART would be one registry entry, no schema change', () => {
    // every provider is described purely by data — the UI form, the endpoint and the
    // "configured?" rule all derive from this spec. Nothing is hard-coded per provider.
    for (const p of Object.values(PROVIDERS)) {
      expect(p.kind === 'webhook' || p.kind === 'poll').toBe(true);
      expect(Array.isArray(p.config)).toBe(true);
      expect(Array.isArray(p.secrets)).toBe(true);
    }
  });

  it('reports what is missing for a "not configured" channel', () => {
    expect(missingRequirements('meta', {}, [])).toContain('App secret');
    expect(missingRequirements('meta', {}, ['verify_token', 'app_secret', 'page_access_token'])).toEqual([]);
    // the Sheet: id + EITHER credential
    expect(missingRequirements('google_sheet', {}, [])).toEqual(
      expect.arrayContaining(['Spreadsheet ID', 'Google credentials (service-account JSON or API key)']),
    );
    expect(missingRequirements('google_sheet', { sheet_id: 'S1' }, ['api_key'])).toEqual([]);
    expect(missingRequirements('google_sheet', { sheet_id: 'S1' }, ['service_account_json'])).toEqual([]);
  });
});

describe('field mapping', () => {
  it('maps a Meta lead-ads field_data payload', () => {
    const p = metaToPayload([
      { name: 'full_name', values: ['Priya Sharma'] },
      { name: 'phone_number', values: ['+91 98111 00001'] },
      { name: 'email', values: ['priya@example.com'] },
      { name: 'city', values: ['Delhi'] },
      { name: 'what_is_your_budget', values: ['2-5 Lakh'] },
    ]);
    expect(p).toMatchObject({ full_name: 'Priya Sharma', phone: '+91 98111 00001', email: 'priya@example.com', city: 'Delhi' });
  });

  it('joins Meta first_name + last_name into full_name', () => {
    const p = metaToPayload([
      { name: 'first_name', values: ['Ravi'] }, { name: 'last_name', values: ['Kumar'] },
      { name: 'phone_number', values: ['9811100002'] },
    ]);
    expect(p.full_name).toBe('Ravi Kumar');
  });

  it('honours the admin field_map for a custom Meta question, incl. custom fields', () => {
    const p = metaToPayload(
      [{ name: 'which_course_are_you_interested_in?', values: ['IELTS'] },
       { name: 'preferred_batch', values: ['Morning'] }],
      { 'which_course_are_you_interested_in?': 'course', preferred_batch: 'cf:batch' },
    );
    expect(p.course).toBe('IELTS');
    expect(p.custom_fields).toEqual({ batch: 'Morning' });
  });

  it('maps a Google Ads user_column_data payload by column_id', () => {
    const p = googleToPayload([
      { column_id: 'FULL_NAME', column_name: 'Full name', string_value: 'Amit Verma' },
      { column_id: 'PHONE_NUMBER', column_name: 'Phone number', string_value: '9811100003' },
      { column_id: 'EMAIL', column_name: 'Email', string_value: 'amit@example.com' },
      { column_id: 'CITY', column_name: 'City', string_value: 'Mumbai' },
      { column_id: 'POSTAL_CODE', column_name: 'Postcode', string_value: '400001' },
    ]);
    expect(p).toMatchObject({ full_name: 'Amit Verma', phone: '9811100003', email: 'amit@example.com', city: 'Mumbai' });
    expect((p as any).POSTAL_CODE).toBeUndefined();     // unmapped keys are dropped, not smuggled in
  });

  it('falls back to the human column_name for a custom Google question', () => {
    const p = googleToPayload(
      [{ column_id: 'CUSTOM_QUESTION_1', column_name: 'Which course?', string_value: 'Spoken English' }],
      { 'Which course?': 'course' },
    );
    expect(p.course).toBe('Spoken English');
  });

  it('maps a website form body through common aliases', () => {
    const p = formToPayload({ name: 'Neha', mobile: '9811100004', 'e-mail': 'n@x.com', message: 'call me', interested_in: 'IELTS' });
    expect(p).toMatchObject({ full_name: 'Neha', phone: '9811100004', email: 'n@x.com', note: 'call me', course: 'IELTS' });
  });

  it('maps a sheet row against its header row', () => {
    const p = sheetRowToPayload(['Name', 'Mobile', 'Email', 'Course'], ['Sunil', '9811100005', 's@x.com', 'IELTS']);
    expect(p).toMatchObject({ full_name: 'Sunil', phone: '9811100005', email: 's@x.com', course: 'IELTS' });
  });

  it('a broken field_map JSON blob never breaks capture', () => {
    expect(parseFieldMap('{not json')).toEqual({});
    expect(parseFieldMap(null)).toEqual({});
    expect(parseFieldMap('{"a":"course"}')).toEqual({ a: 'course' });
  });
});
