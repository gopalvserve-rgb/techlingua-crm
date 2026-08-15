import { InvoiceService } from './invoice.service';

/**
 * dev/88 — GST invoice seller identity now prefers the VERTICAL's billing identity
 * (GSTIN, display/legal name, billing address) and falls back to the branch (055) per field.
 * These pin BOTH halves: the context SQL expresses the vertical-first COALESCE, and the
 * snapshot values that flow onto gst_invoice at creation reflect whatever the query returns.
 */

type Call = { sql: string; params: unknown[] };

function mkDb(row: any) {
  const calls: Call[] = [];
  const q = (sql: string, params: unknown[] = []) => { calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return [row]; };
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => q(sql, params),
    one: async (sql: string, params: unknown[] = []) => (q(sql, params) as any[])[0] ?? null,
  };
}

const mk = (db: any) => new InvoiceService(db as any, { buildScopeWhere: () => '1=1' } as any, {} as never);

describe('invoice seller identity prefers the vertical (dev/88)', () => {
  it('enrolmentContext SQL COALESCEs the vertical GSTIN/display name/billing address first', async () => {
    const db = mkDb({
      id: 1, enrolment_no: 'E1', branch_id: 3, vertical_id: 5, net_fee_minor: 1000000,
      seller_legal_name: 'TL Language Academy', seller_gstin: '27AAPFU0939F1ZV', seller_address: 'Vertical billing addr',
      seller_state_id: 27, lead_name: 'Asha', lead_email: null, lead_phone: null, lead_state_id: 27,
    });
    const ctx = await (mk(db) as any).enrolmentContext(1, { all: true });
    const sql = db.calls[0].sql;
    expect(sql).toContain('COALESCE(NULLIF(vv.gstin');
    expect(sql).toContain('COALESCE(NULLIF(vv.display_name');
    expect(sql).toContain('COALESCE(NULLIF(vv.billing_address');
    expect(sql).toContain('LEFT JOIN vertical vv ON vv.id = e.vertical_id');
    // the resolved (vertical-preferred) identity is what will be snapshotted onto the invoice
    expect(ctx.seller_gstin).toBe('27AAPFU0939F1ZV');
    expect(ctx.seller_legal_name).toBe('TL Language Academy');
    expect(ctx.seller_address).toBe('Vertical billing addr');
  });

  it('branchContext SQL prefers the vertical identity too', async () => {
    const db = mkDb({
      branch_id: 3, vertical_id: 5,
      seller_legal_name: 'Branch Legal', seller_gstin: '29AAAAA0000A1Z5', seller_address: 'Branch addr', seller_state_id: 29,
    });
    const ctx = await (mk(db) as any).branchContext(3, 5, { all: true });
    const sql = db.calls[0].sql;
    expect(sql).toContain('COALESCE(NULLIF(v.gstin');
    expect(sql).toContain('COALESCE(NULLIF(v.display_name');
    expect(sql).toContain('COALESCE(NULLIF(v.billing_address');
    expect(ctx.seller_gstin).toBe('29AAAAA0000A1Z5');
  });
});
