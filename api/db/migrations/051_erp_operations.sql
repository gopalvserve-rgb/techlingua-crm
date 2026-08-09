-- =============================================================================
-- 051 — ERP OPERATIONS (Phase 2, Batch 5)
--
-- Five operations modules on India-first foundations (₹ integer paise / NUMERIC, GST/HSN,
-- vendor GSTIN):
--   1) CATALOG           — org-wide master of items/products/services (item code, name,
--                          category, unit, ₹ price, GST%, HSN/SAC, active).
--   2) INVENTORY         — per-branch/location stock of catalog items: on-hand qty, low-stock
--                          threshold + a movement log (receipt / issue / adjustment).
--   3) ASSETS            — equipment/furniture/IT register: asset code (numbering), category,
--                          branch/location, purchase date + ₹ cost, status, assigned-to,
--                          warranty/AMC dates. Lifecycle.
--   4) VENDORS           — org-wide vendor master (GSTIN, contact, address, category, bank).
--   5) PROCUREMENT (PO)  — purchase orders to a vendor for catalog items (line qty × ₹ price,
--                          GST, total), PO number (numbering), draft→sent→received→closed;
--                          RECEIVING a PO writes inventory receipts + increments on-hand.
--
-- Scope: inventory / asset / purchase_order DENORMALISE branch_id (+ vertical_id where apt) so
-- the ScopeResolver filters them like every branch-scoped module. Catalog + vendor are ORG-WIDE
-- masters (permission-gated, not branch-filtered — the masters pattern).
--
-- Money is ₹ integer paise (BIGINT *_minor) / NUMERIC quantities — no floats. GST computed
-- exactly like quotations (discount-before-tax, per line, half-up — common/money.util.ts).
--
-- Idempotent throughout (IF NOT EXISTS / guarded / ON CONFLICT DO NOTHING). Re-runnable.
-- Table order respects FK dependencies (vendor before asset/purchase_order; catalog before
-- inventory/PO items).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) catalog_item — org-wide master of items/products/services.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog_item (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  item_code     VARCHAR(48) NOT NULL,
  name          VARCHAR(200) NOT NULL,
  category      VARCHAR(80) NULL,
  item_type     VARCHAR(12) NOT NULL DEFAULT 'product' CHECK (item_type IN ('product', 'service')),
  unit          VARCHAR(24) NOT NULL DEFAULT 'pcs',
  price_minor   BIGINT NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  tax_pct       NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_pct >= 0 AND tax_pct <= 100),
  hsn_code      VARCHAR(12) NULL,          -- HSN (goods) / SAC (services), India
  description   TEXT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_code ON catalog_item (org_id, lower(item_code)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_catalog_active ON catalog_item (is_active) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2) vendor — org-wide vendor master (India: GSTIN, address, optional bank).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  name          VARCHAR(200) NOT NULL,
  gstin         VARCHAR(15) NULL,          -- 15-char GSTIN, India
  category      VARCHAR(80) NULL,
  contact_person VARCHAR(160) NULL,
  phone         VARCHAR(24) NULL,
  email         VARCHAR(160) NULL,
  address       TEXT NULL,
  city          VARCHAR(120) NULL,
  state         VARCHAR(120) NULL,
  pincode       VARCHAR(12) NULL,
  bank_name     VARCHAR(160) NULL,
  bank_account  VARCHAR(40) NULL,
  bank_ifsc     VARCHAR(20) NULL,
  notes         TEXT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_vendor_active ON vendor (is_active) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3a) inventory_stock — on-hand per (item, branch, location). Low-stock = on_hand <= threshold.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_stock (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL REFERENCES organisation(id),
  item_id             BIGINT NOT NULL REFERENCES catalog_item(id),
  branch_id           BIGINT NOT NULL REFERENCES branch(id),
  location            VARCHAR(80) NOT NULL DEFAULT 'Main',
  qty_on_hand         NUMERIC(14,3) NOT NULL DEFAULT 0,
  low_stock_threshold NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
  created_by          BIGINT NULL REFERENCES "user"(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ NULL,
  deleted_by          BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_item_branch_loc ON inventory_stock (item_id, branch_id, location) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_stock_branch ON inventory_stock (branch_id) WHERE deleted_at IS NULL;

-- 3b) inventory_movement — append-only stock ledger (receipt / issue / adjustment).
CREATE TABLE IF NOT EXISTS inventory_movement (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  item_id       BIGINT NOT NULL REFERENCES catalog_item(id),
  branch_id     BIGINT NOT NULL REFERENCES branch(id),
  location      VARCHAR(80) NOT NULL DEFAULT 'Main',
  movement_type VARCHAR(12) NOT NULL CHECK (movement_type IN ('receipt', 'issue', 'adjustment')),
  qty_delta     NUMERIC(14,3) NOT NULL,     -- signed: receipt +, issue -, adjustment ±
  qty_after     NUMERIC(14,3) NOT NULL,     -- on-hand snapshot after this movement
  reason        TEXT NULL,
  ref_type      VARCHAR(24) NULL,           -- e.g. 'po'
  ref_id        BIGINT NULL,                -- e.g. purchase_order.id
  created_by    BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movement_item ON inventory_movement (item_id, branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_movement_branch ON inventory_movement (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_movement_ref ON inventory_movement (ref_type, ref_id);

-- ---------------------------------------------------------------------------
-- 4) asset — equipment / furniture / IT register.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  asset_code     VARCHAR(48) NOT NULL,
  name           VARCHAR(200) NOT NULL,
  category       VARCHAR(80) NULL,
  branch_id      BIGINT NOT NULL REFERENCES branch(id),
  vertical_id    BIGINT NULL REFERENCES vertical(id),
  location       VARCHAR(120) NULL,
  serial_no      VARCHAR(120) NULL,
  purchase_date  DATE NULL,
  cost_minor     BIGINT NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  vendor_id      BIGINT NULL REFERENCES vendor(id),
  status         VARCHAR(12) NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use', 'in_repair', 'retired')),
  assigned_to    BIGINT NULL REFERENCES "user"(id),
  warranty_until DATE NULL,
  amc_until      DATE NULL,
  notes          TEXT NULL,
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_code ON asset (org_id, lower(asset_code)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asset_branch ON asset (branch_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asset_status ON asset (status) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5a) purchase_order — a PO to a vendor (header + GST totals + lifecycle).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_order (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  po_no          VARCHAR(48) NOT NULL,
  vendor_id      BIGINT NOT NULL REFERENCES vendor(id),
  branch_id      BIGINT NOT NULL REFERENCES branch(id),
  vertical_id    BIGINT NULL REFERENCES vertical(id),
  location       VARCHAR(80) NOT NULL DEFAULT 'Main',  -- receiving location for inventory
  status         VARCHAR(12) NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'sent', 'received', 'closed', 'cancelled')),
  order_date     DATE NULL,
  expected_date  DATE NULL,
  notes          TEXT NULL,
  terms          TEXT NULL,
  subtotal_minor BIGINT NOT NULL DEFAULT 0,
  discount_minor BIGINT NOT NULL DEFAULT 0,
  tax_minor      BIGINT NOT NULL DEFAULT 0,   -- total GST
  total_minor    BIGINT NOT NULL DEFAULT 0,
  received_at    TIMESTAMPTZ NULL,
  received_by    BIGINT NULL REFERENCES "user"(id),
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_po_no ON purchase_order (org_id, po_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_po_branch ON purchase_order (branch_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_po_vendor ON purchase_order (vendor_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_order (status) WHERE deleted_at IS NULL;

-- 5b) purchase_order_item — PO line items (qty × ₹ price, per-line discount + GST).
CREATE TABLE IF NOT EXISTS purchase_order_item (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  po_id          BIGINT NOT NULL REFERENCES purchase_order(id) ON DELETE CASCADE,
  line_no        INT NOT NULL DEFAULT 1,
  item_id        BIGINT NULL REFERENCES catalog_item(id),
  description    VARCHAR(300) NOT NULL,
  hsn_code       VARCHAR(12) NULL,
  qty            NUMERIC(14,3) NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit           VARCHAR(24) NULL,
  unit_price_minor BIGINT NOT NULL DEFAULT 0 CHECK (unit_price_minor >= 0),
  discount_type  VARCHAR(8) NOT NULL DEFAULT 'amount' CHECK (discount_type IN ('amount', 'percent')),
  discount_value NUMERIC(14,3) NOT NULL DEFAULT 0,
  discount_minor BIGINT NOT NULL DEFAULT 0,
  tax_pct        NUMERIC(5,2) NOT NULL DEFAULT 0,  -- GST %
  gross_minor    BIGINT NOT NULL DEFAULT 0,
  taxable_minor  BIGINT NOT NULL DEFAULT 0,
  tax_minor      BIGINT NOT NULL DEFAULT 0,
  total_minor    BIGINT NOT NULL DEFAULT 0,
  received_qty   NUMERIC(14,3) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_po_item_po ON purchase_order_item (po_id, line_no);

-- ---------------------------------------------------------------------------
-- 6) Permissions — catalog.* / inventory.* / asset.* / vendor.* / procurement.* + role grants.
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('catalog.read', 'catalog', 'read'),
  ('catalog.create', 'catalog', 'create'),
  ('catalog.update', 'catalog', 'update'),
  ('catalog.delete', 'catalog', 'delete'),
  ('inventory.read', 'inventory', 'read'),
  ('inventory.manage', 'inventory', 'manage'),
  ('inventory.delete', 'inventory', 'delete'),
  ('asset.read', 'asset', 'read'),
  ('asset.create', 'asset', 'create'),
  ('asset.update', 'asset', 'update'),
  ('asset.delete', 'asset', 'delete'),
  ('vendor.read', 'vendor', 'read'),
  ('vendor.create', 'vendor', 'create'),
  ('vendor.update', 'vendor', 'update'),
  ('vendor.delete', 'vendor', 'delete'),
  ('procurement.read', 'procurement', 'read'),
  ('procurement.create', 'procurement', 'create'),
  ('procurement.update', 'procurement', 'update'),
  ('procurement.receive', 'procurement', 'receive'),
  ('procurement.delete', 'procurement', 'delete')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- catalog (org-wide master: read broad @ 'all', write admin/manager @ 'all')
      ('catalog.read',   'Super Admin',        'all'),
      ('catalog.read',   'Organization Admin', 'all'),
      ('catalog.read',   'Branch Manager',     'all'),
      ('catalog.read',   'Vertical Manager',   'all'),
      ('catalog.read',   'Team Leader',        'all'),
      ('catalog.read',   'Counsellor',         'all'),
      ('catalog.create', 'Super Admin',        'all'),
      ('catalog.create', 'Organization Admin', 'all'),
      ('catalog.create', 'Branch Manager',     'all'),
      ('catalog.update', 'Super Admin',        'all'),
      ('catalog.update', 'Organization Admin', 'all'),
      ('catalog.update', 'Branch Manager',     'all'),
      ('catalog.delete', 'Super Admin',        'all'),
      ('catalog.delete', 'Organization Admin', 'all'),
      -- inventory (branch-scoped)
      ('inventory.read',   'Super Admin',        'all'),
      ('inventory.read',   'Organization Admin', 'all'),
      ('inventory.read',   'Branch Manager',     'branch'),
      ('inventory.read',   'Vertical Manager',   'vertical'),
      ('inventory.read',   'Team Leader',        'branch'),
      ('inventory.read',   'Counsellor',         'branch'),
      ('inventory.manage', 'Super Admin',        'all'),
      ('inventory.manage', 'Organization Admin', 'all'),
      ('inventory.manage', 'Branch Manager',     'branch'),
      ('inventory.manage', 'Vertical Manager',   'vertical'),
      ('inventory.delete', 'Super Admin',        'all'),
      ('inventory.delete', 'Organization Admin', 'all'),
      ('inventory.delete', 'Branch Manager',     'branch'),
      -- assets (branch-scoped)
      ('asset.read',   'Super Admin',        'all'),
      ('asset.read',   'Organization Admin', 'all'),
      ('asset.read',   'Branch Manager',     'branch'),
      ('asset.read',   'Vertical Manager',   'vertical'),
      ('asset.read',   'Team Leader',        'branch'),
      ('asset.read',   'Counsellor',         'branch'),
      ('asset.create', 'Super Admin',        'all'),
      ('asset.create', 'Organization Admin', 'all'),
      ('asset.create', 'Branch Manager',     'branch'),
      ('asset.create', 'Vertical Manager',   'vertical'),
      ('asset.update', 'Super Admin',        'all'),
      ('asset.update', 'Organization Admin', 'all'),
      ('asset.update', 'Branch Manager',     'branch'),
      ('asset.update', 'Vertical Manager',   'vertical'),
      ('asset.delete', 'Super Admin',        'all'),
      ('asset.delete', 'Organization Admin', 'all'),
      ('asset.delete', 'Branch Manager',     'branch'),
      -- vendors (org-wide master)
      ('vendor.read',   'Super Admin',        'all'),
      ('vendor.read',   'Organization Admin', 'all'),
      ('vendor.read',   'Branch Manager',     'all'),
      ('vendor.read',   'Vertical Manager',   'all'),
      ('vendor.read',   'Team Leader',        'all'),
      ('vendor.read',   'Counsellor',         'all'),
      ('vendor.create', 'Super Admin',        'all'),
      ('vendor.create', 'Organization Admin', 'all'),
      ('vendor.create', 'Branch Manager',     'all'),
      ('vendor.update', 'Super Admin',        'all'),
      ('vendor.update', 'Organization Admin', 'all'),
      ('vendor.update', 'Branch Manager',     'all'),
      ('vendor.delete', 'Super Admin',        'all'),
      ('vendor.delete', 'Organization Admin', 'all'),
      -- procurement / PO (branch-scoped)
      ('procurement.read',    'Super Admin',        'all'),
      ('procurement.read',    'Organization Admin', 'all'),
      ('procurement.read',    'Branch Manager',     'branch'),
      ('procurement.read',    'Vertical Manager',   'vertical'),
      ('procurement.read',    'Team Leader',        'branch'),
      ('procurement.create',  'Super Admin',        'all'),
      ('procurement.create',  'Organization Admin', 'all'),
      ('procurement.create',  'Branch Manager',     'branch'),
      ('procurement.create',  'Vertical Manager',   'vertical'),
      ('procurement.update',  'Super Admin',        'all'),
      ('procurement.update',  'Organization Admin', 'all'),
      ('procurement.update',  'Branch Manager',     'branch'),
      ('procurement.update',  'Vertical Manager',   'vertical'),
      ('procurement.receive', 'Super Admin',        'all'),
      ('procurement.receive', 'Organization Admin', 'all'),
      ('procurement.receive', 'Branch Manager',     'branch'),
      ('procurement.receive', 'Vertical Manager',   'vertical'),
      ('procurement.delete',  'Super Admin',        'all'),
      ('procurement.delete',  'Organization Admin', 'all'),
      ('procurement.delete',  'Branch Manager',     'branch')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
