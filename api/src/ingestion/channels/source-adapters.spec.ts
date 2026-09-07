import { adaptMarketplace } from './source-adapters';

describe('marketplace source adapters', () => {
  it('IndiaMART single: maps name/phone/email + UNIQUE_QUERY_ID as source_ref', () => {
    const r = adaptMarketplace('indiamart', {
      SENDER_NAME: 'Asha Rao', SENDER_MOBILE: '9876543210', SENDER_EMAIL: 'a@x.com',
      UNIQUE_QUERY_ID: 'IM-1', QUERY_MESSAGE: 'Need IELTS', SENDER_CITY: 'Pune',
    });
    expect(r).toHaveLength(1);
    expect(r[0].full_name).toBe('Asha Rao');
    expect(r[0].phone).toBe('9876543210');
    expect(r[0].email).toBe('a@x.com');
    expect(r[0].external_id).toBe('IM-1');
    expect(r[0].note).toContain('Need IELTS');
  });

  it('IndiaMART batch RESPONSE[] fans out to multiple leads', () => {
    const r = adaptMarketplace('indiamart', { RESPONSE: [
      { SENDER_NAME: 'A', SENDER_MOBILE: '111', UNIQUE_QUERY_ID: 'q1' },
      { SENDER_NAME: 'B', SENDER_MOBILE: '222', UNIQUE_QUERY_ID: 'q2' },
    ]});
    expect(r).toHaveLength(2);
    expect(r[1].external_id).toBe('q2');
  });

  it('JustDial: mobile + leadid', () => {
    const r = adaptMarketplace('justdial', { name: 'Ravi', mobile: '9000000000', leadid: 'JD-9', city: 'Delhi' });
    expect(r[0].full_name).toBe('Ravi');
    expect(r[0].external_id).toBe('JD-9');
  });

  it('TradeIndia webhook: GLUSR fields + QUERY_ID', () => {
    const r = adaptMarketplace('tradeindia', { GLUSR_USR_FNAME: 'Sam', GLUSR_USR_PHONE: '8000000000', QUERY_ID: 'TI-3' });
    expect(r[0].full_name).toBe('Sam');
    expect(r[0].external_id).toBe('TI-3');
  });

  it('unknown source falls back to generic name/phone', () => {
    const r = adaptMarketplace('magicbricks', { name: 'Neha', mobile: '7000000000', id: 'MB-2' });
    expect(r[0].full_name).toBe('Neha');
    expect(r[0].external_id).toBe('MB-2');
  });

  it('drops records with neither name nor phone', () => {
    expect(adaptMarketplace('indiamart', { QUERY_MESSAGE: 'hi' })).toHaveLength(0);
  });
});
