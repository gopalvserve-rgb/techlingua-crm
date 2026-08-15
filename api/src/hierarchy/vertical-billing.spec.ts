import { BadRequestException } from '@nestjs/common';
import { HierarchyService } from './hierarchy.service';

/**
 * dev/88 — Vertical billing / identity fields (client feedback): the Add/Edit Vertical form
 * captures GSTIN, billing address, phone, email, display name, LOGO (R2) and bank details.
 * These pin the server contract: create + update persist every field, validation is loose but
 * real, and the logo R2 flow mints a key + returns a presigned url.
 */

type Call = { sql: string; params: unknown[] };

function mkDb(rowFactory?: () => any) {
  const calls: Call[] = [];
  const exec = (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return [rowFactory ? rowFactory() : { id: 1 }];
  };
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => exec(sql, params),
    one: async (sql: string, params: unknown[] = []) => (exec(sql, params) as any[])[0] ?? null,
    tx: async (fn: (c: any) => Promise<unknown>) =>
      fn({ query: async (sql: string, params: unknown[] = []) => ({ rows: exec(sql, params) }) }),
  };
}

const storage = {
  verticalLogoKey: (id: number, fn: string) => `verticals/${id}/logo/uuid-${fn}`,
  presignPut: async (key: string) => `https://r2.example/put/${key}`,
  presignGet: async (key: string) => `https://r2.example/get/${key}`,
};

const svc = (db: any) =>
  new HierarchyService(db as any, { buildScopeWhere: () => 'TRUE' } as any, {} as any, storage as any);

describe('createVertical persists the billing/identity fields', () => {
  it('the INSERT carries gstin, billing address, phone, email, display name and bank details', async () => {
    const db = mkDb();
    await svc(db).createVertical({
      branch_id: 1, name: 'Language Academy', code: 'TLA',
      gstin: '27aapfu0939f1zv', billing_address: '2nd Floor, MG Road, Pune', phone: '9876543210',
      email: 'accounts@tla.example', display_name: 'Tech Lingua Language Academy',
      bank_name: 'HDFC Bank', bank_account_no: '501000123456', bank_ifsc: 'hdfc0000123',
      bank_branch: 'MG Road', bank_account_holder: 'Tech Lingua LLP',
    }, 9);
    const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO vertical'))!;
    expect(ins).toBeDefined();
    for (const col of ['gstin', 'billing_address', 'phone', 'email', 'display_name',
      'bank_name', 'bank_account_no', 'bank_ifsc', 'bank_branch', 'bank_account_holder']) {
      expect(ins.sql).toContain(col);
    }
    expect(ins.params).toContain('27AAPFU0939F1ZV');            // GSTIN upper-cased
    expect(ins.params).toContain('2nd Floor, MG Road, Pune');
    expect(ins.params).toContain('accounts@tla.example');
    expect(ins.params).toContain('Tech Lingua Language Academy');
    expect(ins.params).toContain('HDFC0000123');                // IFSC upper-cased
    expect(ins.params).toContain('Tech Lingua LLP');
  });

  it('a create with no billing fields still inserts NULLs (no regression)', async () => {
    const db = mkDb();
    await svc(db).createVertical({ branch_id: 1, name: 'Plain', code: 'PLN' }, 9);
    const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO vertical'))!;
    expect(ins.params).toContain(null);
  });
});

describe('updateVertical whitelists + validates the billing/identity fields', () => {
  it('the UPDATE carries every editable identity column (Edit -> save -> reload keeps them)', async () => {
    const db = mkDb();
    await svc(db).updateVertical(2, {
      gstin: '27AAPFU0939F1ZV', billing_address: 'New addr', phone: '+91 98765 43210',
      email: 'x@y.com', display_name: 'Brand', bank_name: 'SBI', bank_account_no: '111',
      bank_ifsc: 'SBIN0000001', bank_branch: 'Main', bank_account_holder: 'Org',
    });
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE vertical'))!;
    for (const col of ['gstin', 'billing_address', 'phone', 'email', 'display_name',
      'bank_name', 'bank_account_no', 'bank_ifsc', 'bank_branch', 'bank_account_holder']) {
      expect(upd.sql).toContain(`${col} = $`);
    }
    expect(upd.params).toContain('Brand');
  });

  it('rejects a malformed GSTIN, email and phone (validation is synchronous)', () => {
    expect(() => svc(mkDb()).updateVertical(2, { gstin: 'NOTAGSTIN' })).toThrow(BadRequestException);
    expect(() => svc(mkDb()).updateVertical(2, { email: 'not-an-email' })).toThrow(BadRequestException);
    expect(() => svc(mkDb()).updateVertical(2, { phone: '123' })).toThrow(BadRequestException);
  });
});

describe('vertical logo (R2, presigned)', () => {
  it('logoUploadUrl mints a verticals/<id>/logo key + presigned PUT url', async () => {
    const out = await svc(mkDb()).logoUploadUrl(7, { file_name: 'brand.png', content_type: 'image/png' });
    expect(out.r2_key).toBe('verticals/7/logo/uuid-brand.png');
    expect(out.url).toContain('put');
  });

  it('attachLogo sets logo_r2_key and returns a presigned logo_url', async () => {
    const db = mkDb();
    const out = await svc(db).attachLogo(7, { r2_key: 'verticals/7/logo/uuid-brand.png', content_type: 'image/png' });
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE vertical'))!;
    expect(upd.sql).toContain('logo_r2_key = $');
    expect(out.logo_r2_key).toBe('verticals/7/logo/uuid-brand.png');
    expect(out.logo_url).toContain('get');
  });

  it('attachLogo rejects an r2_key that is not under this vertical', async () => {
    await expect(svc(mkDb()).attachLogo(7, { r2_key: 'verticals/99/logo/x.png' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
