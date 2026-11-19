import { pairsToPayload } from './providers';

/**
 * 19 Nov 2026 — a website form connected as a Custom Integration posted SENDER_NAME / MOBILE /
 * SENDER_EMAIL / QUERY_MESSAGE and every submission failed "Name is required". Prefixed and
 * "_no / _id" field names now map on their own; explicit mappings still win.
 */
describe('custom integration field names', () => {
  it('the exact payload the website sent maps to name, mobile, email and note', () => {
    const p = pairsToPayload([['MOBILE', '9811111111'], ['SENDER_NAME', 'ZZTEST Riya'], ['SENDER_EMAIL', 'riya@example.com'], ['QUERY_MESSAGE', 'German A1 fees?']]);
    expect(p).toMatchObject({ full_name: 'ZZTEST Riya', phone: '9811111111', email: 'riya@example.com', note: 'German A1 fees?' });
  });

  it('common "_no" / "_id" / "your_" spellings and IndiaMART names', () => {
    expect(pairsToPayload([['your-name', 'A'], ['mobile_no', '9800000000'], ['email_id', 'a@b.co'], ['your_message', 'hi']]))
      .toMatchObject({ full_name: 'A', phone: '9800000000', email: 'a@b.co', note: 'hi' });
    const im = pairsToPayload([['SENDER_NAME', 'B'], ['SENDER_MOBILE', '+91 98000 00000'], ['SENDER_CITY', 'Delhi'], ['QUERY_PRODUCT_NAME', 'IELTS']]);
    expect(im).toMatchObject({ full_name: 'B', phone: '+91 98000 00000' });
    expect(im.city).toBeUndefined();     // city / product stay "other fields" on the note, as before
    expect(im.course).toBeUndefined();
  });

  it('the fallback reads keys that clearly say what they are, but never a company / course / father name', () => {
    const p = pairsToPayload([['Applicant_Full_Name', 'C'], ['Primary-Mobile-Number', '9700000000'], ['company_name', 'Acme'],
      ['course_name_selected', 'Data'], ['father_name', 'D'], ['Your Requirement', 'weekend batch']]);
    expect(p.full_name).toBe('C');
    expect(p.phone).toBe('9700000000');
    expect(p.note).toBe('weekend batch');
  });

  it('first + last name keys combine; an explicit mapping (or "ignore") always wins', () => {
    expect(pairsToPayload([['Applicant_First_Name', 'Riya'], ['Applicant_Last_Name', 'Sharma'], ['cell', '9600000000']]).full_name).toBe('Riya Sharma');
    expect(pairsToPayload([['SENDER_NAME', 'X'], ['contact_person', 'Y']], { SENDER_NAME: 'note', contact_person: 'full_name' }))
      .toMatchObject({ full_name: 'Y', note: 'X' });
    expect(pairsToPayload([['SENDER_NAME', 'X'], ['buyer', 'Y']], { SENDER_NAME: '_ignore', buyer: 'full_name' }).full_name).toBe('Y');
  });
});
