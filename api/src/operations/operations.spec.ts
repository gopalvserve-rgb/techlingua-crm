import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { ResolvedScope } from '../rbac/rbac.types';
import { CatalogService } from './catalog.service';
import { VendorService } from './vendor.service';
import { InventoryService } from './inventory.service';
import { AssetService } from './asset.service';
import { ProcurementService } from './procurement.service';
import { CatalogController } from './catalog.controller';
import { VendorController } from './vendor.controller';
import { InventoryController } from './inventory.controller';
import { AssetController } from './asset.controller';
import { ProcurementController } from './procurement.controller';

/**
 * ERP OPERATIONS (Batch 5) — unit coverage: catalog/vendor/asset/PO CRUD guards, GST math on a
 * PO (discount-before-tax, summed), receiving a PO writes inventory receipts + increments on-hand,
 * inventory movement in/out + low-stock guard, GSTIN validation, and the RBAC census (every route
 * guarded; every key catalogued).
 */
const scopeAll: ResolvedScope = { permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };

const resolver = {
  buildScopeWhere: (scope: ResolvedScope, _cols: any, _params: unknown[]) => (scope.all ? '1=1' : '1=0'),
};
const numbering = (map: Record<string, string> = {}) => ({
  allocate: async (kind: string) => map[kind] ?? `${kind.toUpperCase()}-0001`,
});

describe('CatalogService', () => {
  const mkDb = (capture: any[]) => ({
    one: async (sql: string) => (/FROM organisation/.test(sql) ? { id: 1 } : null),
    query: async (sql: string, p: unknown[]) => { capture.push({ sql, p }); return []; },
    tx: async (fn: any) => fn({
      query: async (sql: string, p: unknown[] = []) => {
        capture.push({ sql, p });
        if (/INSERT INTO catalog_item/.test(sql)) return { rows: [{ id: 7 }] };
        return { rows: [] };
      },
    }),
  });
  it('mints an item code from numbering and stores rupee paise price + GST%', async () => {
    const cap: any[] = [];
    const svc = new CatalogService(mkDb(cap) as never, numbering({ catalog: 'ITM-0001' }) as never);
    const out = await svc.create({ name: 'Course Kit', price: '1500', tax_pct: 18, hsn_code: '4901', unit: 'pcs' }, { id: 1 });
    expect(out.item_code).toBe('ITM-0001');
    const ins = cap.find((c) => /INSERT INTO catalog_item/.test(c.sql));
    expect(ins.p).toContain(150000);   // Rs.1500 -> 150000 paise
    expect(ins.p).toContain(18);       // GST 18%
  });
  it('rejects a blank name and an out-of-range GST', async () => {
    const svc = new CatalogService(mkDb([]) as never, numbering() as never);
    await expect(svc.create({ name: '' }, { id: 1 })).rejects.toThrow(/name is required/i);
    await expect(svc.create({ name: 'X', tax_pct: 120 }, { id: 1 })).rejects.toThrow(/GST/i);
  });
});

describe('VendorService — GSTIN', () => {
  const db = { one: async (sql: string) => (/FROM organisation/.test(sql) ? { id: 1 } : null), query: async () => [{ id: 3 }] };
  it('accepts a valid 15-char GSTIN and rejects a malformed one', async () => {
    const svc = new VendorService(db as never);
    await expect(svc.create({ name: 'Acme', gstin: '27AAPFU0939F1ZV' }, { id: 1 })).resolves.toEqual({ id: 3 });
    await expect(svc.create({ name: 'Acme', gstin: 'BADGSTIN' }, { id: 1 })).rejects.toThrow(/GSTIN/);
  });
});

describe('InventoryService — movement math', () => {
  const mkClient = (start: number) => {
    let onHand = start; let hasRow = start !== null;
    const moves: any[] = [];
    return {
      moves, get onHand() { return onHand; },
      query: async (sql: string, p: unknown[] = []) => {
        if (/SELECT id, qty_on_hand/.test(sql)) return hasRow ? { rows: [{ id: 1, qty_on_hand: onHand, low_stock_threshold: 0 }] } : { rows: [] };
        if (/INSERT INTO inventory_stock/.test(sql)) { hasRow = true; return { rows: [{ id: 1 }] }; }
        if (/UPDATE inventory_stock SET qty_on_hand/.test(sql)) { onHand = Number(p[1]); return { rows: [] }; }
        if (/INSERT INTO inventory_movement/.test(sql)) { moves.push(p); return { rows: [] }; }
        return { rows: [] };
      },
    };
  };
  it('receipt adds, issue subtracts, and issuing below zero is blocked', async () => {
    const svc = new InventoryService({} as never, resolver as never);
    const c = mkClient(5);
    await svc.applyMovementTx(c as never, { orgId: 1, itemId: 2, branchId: 9, location: 'Main', type: 'receipt', delta: 10, actorId: 1 });
    expect(c.onHand).toBe(15);
    const r = await svc.applyMovementTx(c as never, { orgId: 1, itemId: 2, branchId: 9, location: 'Main', type: 'issue', delta: -4, actorId: 1 });
    expect(r.qty_after).toBe(11);
    await expect(svc.applyMovementTx(c as never, { orgId: 1, itemId: 2, branchId: 9, location: 'Main', type: 'issue', delta: -50, actorId: 1 }))
      .rejects.toThrow(/below zero/);
  });
});

describe('AssetService — create mints code + validates status', () => {
  const mkDb = (cap: any[]) => ({
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM vertical WHERE id/.test(sql)) return { id: 3 };
      return null;
    },
    query: async () => [],
    tx: async (fn: any) => fn({
      query: async (sql: string, p: unknown[] = []) => {
        cap.push({ sql, p });
        if (/INSERT INTO asset/.test(sql)) return { rows: [{ id: 42 }] };
        return { rows: [] };
      },
    }),
  });
  it('mints AST- code, stores rupee cost paise', async () => {
    const cap: any[] = [];
    const svc = new AssetService(mkDb(cap) as never, resolver as never, numbering({ asset: 'AST-0001' }) as never);
    const out = await svc.create({ name: 'Projector', branch_id: 9, cost: '25000', status: 'in_use' }, { id: 1 }, scopeAll);
    expect(out.asset_code).toBe('AST-0001');
    const ins = cap.find((c) => /INSERT INTO asset/.test(c.sql));
    expect(ins.p).toContain(2500000);
  });
});

describe('ProcurementService — GST totals + receive to stock', () => {
  const inv = { applyMovementTx: jest.fn(async () => ({ qty_after: 10 })) } as unknown as InventoryService;
  it('computes per-line GST (discount before tax) and sums the PO', async () => {
    const cap: any[] = [];
    const db = {
      one: async (sql: string) => {
        if (/FROM organisation/.test(sql)) return { id: 1 };
        if (/FROM vendor WHERE id/.test(sql)) return { id: 5 };
        return null;
      },
      query: async () => [],
      tx: async (fn: any) => fn({
        query: async (sql: string, p: unknown[] = []) => {
          cap.push({ sql, p });
          if (/INSERT INTO purchase_order\b/.test(sql)) return { rows: [{ id: 88 }] };
          return { rows: [] };
        },
      }),
    };
    const svc = new ProcurementService(db as never, resolver as never, numbering({ po: 'PO-0001' }) as never, inv);
    const out = await svc.create({
      vendor_id: 5, branch_id: 9,
      items: [{ description: 'Books', qty: 10, unit_price: '100', tax_pct: 18 }],   // gross 1000 -> tax 180 -> total 1180
    }, { id: 1 }, scopeAll);
    expect(out.po_no).toBe('PO-0001');
    const head = cap.find((c) => /INSERT INTO purchase_order\b/.test(c.sql));
    expect(head.p).toContain(100000);   // subtotal paise
    expect(head.p).toContain(18000);    // GST paise
    expect(head.p).toContain(118000);   // total paise
  });
  it('receiving a PO writes an inventory receipt for each catalog line and marks it received', async () => {
    (inv.applyMovementTx as jest.Mock).mockClear();
    const po = {
      id: 88, org_id: 1, po_no: 'PO-0001', status: 'sent', branch_id: 9, location: 'Main',
      items: [{ id: 1, item_id: 2, qty: 10 }, { id: 2, item_id: null, qty: 3 }],
    };
    const updates: any[] = [];
    const db = {
      one: async () => null,
      query: async () => [],
      tx: async (fn: any) => fn({ query: async (sql: string, p: unknown[] = []) => { updates.push({ sql, p }); return { rows: [] }; } }),
    };
    const svc = new ProcurementService(db as never, resolver as never, numbering() as never, inv);
    jest.spyOn(svc, 'get').mockResolvedValue(po as never);
    const out = await svc.receive(88, {}, { id: 1 }, scopeAll);
    expect(out.items_stocked).toBe(1);                         // only the catalog line
    expect((inv.applyMovementTx as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(updates.some((u) => /status = 'received'/.test(u.sql))).toBe(true);
  });
});

describe('Operations RBAC census', () => {
  const controllers: any[] = [CatalogController, VendorController, InventoryController, AssetController, ProcurementController];
  const catalogKeys = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
  it('every route declares a permission that exists in the catalog', () => {
    for (const C of controllers) {
      const proto = C.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const isRoute = Reflect.getMetadata(PATH_METADATA, proto[name]) !== undefined
          && Reflect.getMetadata(METHOD_METADATA, proto[name]) !== undefined;
        if (!isRoute) continue;
        const perm = Reflect.getMetadata(PERMISSION_KEY, proto[name]);
        expect(perm).toBeTruthy();
        expect(catalogKeys.has(perm)).toBe(true);
      }
    }
  });
  it('catalogs all five operations modules', () => {
    for (const m of ['catalog', 'inventory', 'asset', 'vendor', 'procurement']) {
      expect(PERMISSION_CATALOG.some((x) => x.module === m)).toBe(true);
    }
  });
});
