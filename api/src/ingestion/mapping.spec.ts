import { applyMapping, autoMap, validateMapping, normHeader, CUSTOM_PREFIX } from './mapping.util';

describe('mapping.util — column mapping', () => {
  it('auto-maps common header spellings', () => {
    const m = autoMap(['Full Name', 'Mobile No.', 'Email ID', 'Course', 'Junk Column']);
    expect(m['Full Name']).toBe('full_name');
    expect(m['Mobile No.']).toBe('phone');
    expect(m['Email ID']).toBe('email');
    expect(m['Course']).toBe('course');
    expect(m['Junk Column']).toBe('');
  });

  it('auto-maps custom fields by key or label', () => {
    const m = autoMap(['Name', 'Phone', 'Preferred Batch'], [{ field_key: 'preferred_batch', label: 'Preferred Batch' }]);
    expect(m['Preferred Batch']).toBe(`${CUSTOM_PREFIX}preferred_batch`);
  });

  it('never maps two columns to the same field', () => {
    const m = autoMap(['Name', 'Lead Name']);
    const targets = Object.values(m).filter(Boolean);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('applyMapping ignores unmapped/blank columns and collects custom fields', () => {
    const p = applyMapping(
      { Name: 'Asha', Phone: '9811100001', Junk: 'x', Batch: 'Evening', Blank: '' },
      { Name: 'full_name', Phone: 'phone', Junk: '', Batch: `${CUSTOM_PREFIX}batch`, Blank: 'email' },
    );
    expect(p).toEqual({ full_name: 'Asha', phone: '9811100001', custom_fields: { batch: 'Evening' } });
  });

  it('validateMapping requires name + phone and rejects a doubled target', () => {
    expect(validateMapping({ A: 'full_name', B: 'phone' })).toEqual([]);
    expect(validateMapping({ A: 'full_name' })[0]).toMatch(/Mobile Number/);
    expect(validateMapping({ A: 'full_name', B: 'phone', C: 'phone' }).some((e) => /same field/.test(e))).toBe(true);
  });

  it('normHeader strips punctuation and case', () => {
    expect(normHeader('  Mobile-No. ')).toBe('mobileno');
  });
});
