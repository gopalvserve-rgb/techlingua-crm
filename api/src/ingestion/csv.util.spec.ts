import { parseCsv, parseCsvRecords, rowToObject, sniffDelimiter, toCsv } from './csv.util';

/**
 * PROJECT_STATUS §5 listed "quoted-CSV import" as known-deferred. These are the
 * tests that close it: a real RFC-4180 parser, not split(',').
 */
describe('csv.util — RFC-4180 parsing', () => {
  it('keeps commas inside quoted fields', () => {
    const { headers, rows } = parseCsv('Name,City\n"Sharma, Priya",Delhi\n');
    expect(headers).toEqual(['Name', 'City']);
    expect(rows).toEqual([['Sharma, Priya', 'Delhi']]);
  });

  it('keeps NEWLINES inside quoted fields', () => {
    const { rows } = parseCsv('Name,Note\nAsha,"line one\nline two"\nRavi,ok\n');
    expect(rows).toEqual([['Asha', 'line one\nline two'], ['Ravi', 'ok']]);
  });

  it('unescapes doubled quotes', () => {
    const { rows } = parseCsv('Name,Note\nAsha,"He said ""hello"", loudly"\n');
    expect(rows[0][1]).toBe('He said "hello", loudly');
  });

  it('handles CRLF, a UTF-8 BOM and a missing trailing newline', () => {
    const { headers, rows } = parseCsv('﻿Name,Phone\r\nAsha,9811100001');
    expect(headers).toEqual(['Name', 'Phone']);
    expect(rows).toEqual([['Asha', '9811100001']]);
  });

  it('pads short rows and ignores blank lines', () => {
    const { rows } = parseCsv('A,B,C\n1,2\n\n3,4,5\n');
    expect(rows).toEqual([['1', '2', ''], ['3', '4', '5']]);
  });

  it('does not treat a quote mid-field as a quoted field', () => {
    const { rows } = parseCsv('A\n5" pipe\n');
    expect(rows[0][0]).toBe('5" pipe');
  });

  it('sniffs semicolon and tab delimiters', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(sniffDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(parseCsv('Name;City\n"Sharma; P";Delhi').rows).toEqual([['Sharma; P', 'Delhi']]);
  });

  it('parseCsvRecords includes the header record', () => {
    expect(parseCsvRecords('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('rowToObject trims and aligns to headers', () => {
    expect(rowToObject(['Name', 'City'], [' Asha ', 'Delhi'])).toEqual({ Name: 'Asha', City: 'Delhi' });
  });

  it('toCsv round-trips values that need quoting', () => {
    const csv = toCsv(['Row', 'Error', 'Name'], [[1, 'Invalid email: "x"', 'Sharma, Priya']]);
    const back = parseCsv(csv);
    expect(back.rows[0]).toEqual(['1', 'Invalid email: "x"', 'Sharma, Priya']);
  });
});
