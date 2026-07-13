-- 017 — DEF-2: fields the Add forms have always shown but the schema never stored.
-- Because they had no column, the Edit modals dumped them into the read-only `lock`
-- list, so "Edit Branch" rendered mostly grey, non-editable boxes (client UAT bug).
-- Give them real columns so Add persists them and Edit can render editable inputs.
-- Idempotent: safe to re-run on boot.

-- branch: Branch Type, Contact Number, Branch Email, Branch Head
ALTER TABLE branch ADD COLUMN IF NOT EXISTS branch_type     VARCHAR(20);
ALTER TABLE branch ADD COLUMN IF NOT EXISTS contact_number  VARCHAR(24);
ALTER TABLE branch ADD COLUMN IF NOT EXISTS email           VARCHAR(255);
ALTER TABLE branch ADD COLUMN IF NOT EXISTS head_user_id    BIGINT;

DO $$ BEGIN
  ALTER TABLE branch ADD CONSTRAINT branch_head_user_fk
    FOREIGN KEY (head_user_id) REFERENCES "user"(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE branch ADD CONSTRAINT branch_type_chk
    CHECK (branch_type IS NULL OR branch_type IN ('company', 'franchise'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- vertical: Vertical Head, Description
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS head_user_id BIGINT;
ALTER TABLE vertical ADD COLUMN IF NOT EXISTS description  TEXT;

DO $$ BEGIN
  ALTER TABLE vertical ADD CONSTRAINT vertical_head_user_fk
    FOREIGN KEY (head_user_id) REFERENCES "user"(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- pipeline: Pipeline Owner
ALTER TABLE pipeline ADD COLUMN IF NOT EXISTS owner_user_id BIGINT;

DO $$ BEGIN
  ALTER TABLE pipeline ADD CONSTRAINT pipeline_owner_user_fk
    FOREIGN KEY (owner_user_id) REFERENCES "user"(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- source: Cost per Lead
ALTER TABLE source ADD COLUMN IF NOT EXISTS cost_per_lead NUMERIC(14,2) NOT NULL DEFAULT 0;
