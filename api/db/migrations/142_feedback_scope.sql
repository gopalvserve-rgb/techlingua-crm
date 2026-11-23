-- 142 — FEEDBACK: OUT OF SCOPE (23 Nov 2026).
--
-- "While adding a feedback, if it's new or out of scope, show the message: we can't take this
-- because it's out of scope — refer the document, this task is not available."
--
-- The scope list holds what the agreed documents leave out (the Client Requirements Discovery
-- Document, the CRM/ERP Form Field Specification, the "CRM more update" list and the Assessment
-- module specification — as named in the Additional Scope Statement of 18 Oct 2026), each with
-- WHERE the document says so. A note that names an item (by its words) or is left on one of its
-- screens is saved as OUT_OF_SCOPE, with the document reference as its outcome. The team can also
-- mark any note Out of scope — against an item, or as a new request no document mentions.
--
-- The seed below is the client's own answers in the Requirements Discovery Document, limited to
-- what is ALSO not available on the live system (e.g. Forecasting was answered "Not required" but
-- was built, so it is not listed). Phrases are specific on purpose: a bug on a screen the client
-- already has must never be turned away by a loose word. The team edits the list in
-- Help & Support › Feedback › Scope list.

CREATE TABLE IF NOT EXISTS feedback_scope_item (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title        VARCHAR(160) NOT NULL,
  reference    VARCHAR(300) NOT NULL,                 -- the document, section and question
  doc_says     VARCHAR(300) NULL,                     -- what it says there: answered "Not required"
  phrases      TEXT[] NOT NULL DEFAULT '{}',          -- words in a note that mean this item
  page_paths   TEXT[] NOT NULL DEFAULT '{}',          -- the screens that belong to it
  is_active    BOOLEAN NOT NULL DEFAULT true,
  sort_order   INT NOT NULL DEFAULT 0,
  created_by   BIGINT NULL REFERENCES "user"(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_scope_item_title ON feedback_scope_item (lower(title));

-- the new status, and which item a note fell under (NULL = a new request in no document)
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'feedback'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%WONT_FIX%' LOOP
    EXECUTE format('ALTER TABLE feedback DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE feedback ADD CONSTRAINT feedback_status_check
  CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'ANSWERED', 'RESOLVED', 'WONT_FIX', 'OUT_OF_SCOPE'));
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS scope_item_id BIGINT NULL REFERENCES feedback_scope_item(id);
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS scope_auto BOOLEAN NOT NULL DEFAULT false;   -- set by itself when filed

INSERT INTO feedback_scope_item (title, reference, doc_says, phrases, page_paths, sort_order)
SELECT v.title, v.reference, v.doc_says, v.phrases, v.page_paths, v.sort_order
  FROM (VALUES
  ('Call transfer, conference calling and call routing',
   'Client Requirements Discovery Document, §7 Calls (Telephony) › Transfer / Conference / Routing',
   'answered "Not required"',
   ARRAY['call transfer', 'transfer call', 'transfer the call', 'transfer a call', 'transfer this call', 'call forwarding',
         'forward the call', 'conference call', 'conference calling', 'call conference', 'merge call', 'merge the call',
         'call routing', 'route the call', 'route calls', 'skill based routing'],
   ARRAY['/m/calls/transfer', '/m/calls/conference', '/m/calls/routing'], 10),

  ('Live call analysis while the call is going on',
   'Client Requirements Discovery Document, §8 Communication Intelligence › Timing (real-time or post-call)',
   'answered "Not required" — calls are analysed after they end',
   ARRAY['real time call analysis', 'realtime call analysis', 'live call analysis', 'real time transcription',
         'realtime transcription', 'live transcription', 'live call transcription', 'real time call coaching',
         'live call coaching', 'live coaching'],
   ARRAY[]::text[], 20),

  ('Social Inbox (Facebook, Instagram, LinkedIn and Google Business messages)',
   'Client Requirements Discovery Document, §10 Workspace & Productivity › Social Inbox',
   'answered "We use internal message platform only"',
   ARRAY['social inbox', 'unified inbox', 'instagram dm', 'instagram direct message', 'instagram messages', 'instagram inbox',
         'facebook messenger', 'messenger inbox', 'messenger messages', 'facebook page messages', 'facebook inbox',
         'linkedin messages', 'linkedin inbox', 'google business messages', 'google my business messages', 'gmb messages'],
   ARRAY['/m/work/socialinbox'], 30),

  ('Social Comments (replying to comments on ads and posts)',
   'Client Requirements Discovery Document, §10 Workspace & Productivity › Social Comments',
   'answered "Not Available"',
   ARRAY['social comments', 'ad comments', 'comments on ads', 'comments on ad', 'comments on posts', 'comments on post',
         'post comments', 'facebook comments', 'instagram comments', 'youtube comments', 'comments into leads', 'commenter'],
   ARRAY['/m/work/socialcomments'], 40),

  ('Social Publisher (scheduling and publishing posts)',
   'Client Requirements Discovery Document, §10 Workspace & Productivity › Social Publisher',
   'answered "N/A"',
   ARRAY['social publisher', 'schedule posts', 'schedule a post', 'schedule post', 'post scheduling', 'post scheduler',
         'content calendar', 'publish posts', 'publish a post', 'social media posting', 'social media post',
         'post on facebook', 'post on instagram', 'post on linkedin', 'post to facebook', 'post to instagram', 'post to linkedin'],
   ARRAY['/m/work/socialpublisher'], 50),

  ('Staff hiring and recruitment (job posts, candidates, interviews)',
   'Client Requirements Discovery Document, §11 HR & Workforce › Hiring',
   'left unanswered, so not agreed (Placement Support for students is separate and available)',
   ARRAY['staff hiring', 'employee hiring', 'hiring module', 'hiring process', 'hire staff', 'hire employees', 'hire new staff',
         'staff recruitment', 'employee recruitment', 'recruitment module', 'candidate pipeline', 'candidate tracking'],
   ARRAY['/m/hr/hiring'], 60),

  ('Staff appraisals (appraisal cycles, KRAs and ratings)',
   'Client Requirements Discovery Document, §11 HR & Workforce › Performance',
   'left unanswered, so not agreed',
   ARRAY['appraisal', 'performance appraisal', 'appraisal cycle', 'kra', 'staff performance review', 'employee performance review'],
   ARRAY['/m/hr/performance'], 70),

  ('Operations: inventory, assets, vendors and procurement',
   'Client Requirements Discovery Document, §12 Operations › Inventory, Assets, Vendor Management, Procurement',
   'answered "Phase 2" — not part of the current phase',
   ARRAY['inventory', 'stock management', 'stock register', 'asset register', 'asset management', 'vendor management',
         'vendor master', 'procurement', 'purchase order', 'goods receipt', 'grn'],
   ARRAY['/m/ops/inventory', '/m/ops/assets', '/m/ops/vendors', '/m/ops/procure'], 80),

  ('Screens or messages in Hindi or other regional languages',
   'Client Requirements Discovery Document, Section A Foundation › Languages',
   'answered "english"',
   ARRAY['multi language', 'multilingual', 'multiple languages', 'language option', 'change language', 'change the language',
         'language change', 'language switch', 'hindi version', 'hindi interface', 'hindi menu', 'crm in hindi',
         'software in hindi', 'regional language'],
   ARRAY[]::text[], 90),

  ('A Region / Zone level above branches',
   'Client Requirements Discovery Document, Section A Foundation › Branch hierarchy',
   'answered "No direct with branches" — branches sit straight under the organisation',
   ARRAY['region wise', 'zone wise', 'region level', 'zone level', 'add region', 'add zone', 'region master', 'zone master',
         'regional manager', 'zonal manager', 'region hierarchy', 'zone hierarchy', 'regional head', 'zonal head'],
   ARRAY[]::text[], 100)
  ) AS v(title, reference, doc_says, phrases, page_paths, sort_order)
 WHERE NOT EXISTS (SELECT 1 FROM feedback_scope_item s WHERE lower(s.title) = lower(v.title));
