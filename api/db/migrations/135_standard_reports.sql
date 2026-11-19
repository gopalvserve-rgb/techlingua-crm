-- Client 12 Nov 2026 — "Analytics & Reports: complete on priority".
-- Ready-made STANDARD reports so the Reports list is useful on day one. A standard report is
-- nobody's to edit (report.service mayEdit) and every run uses the RUNNER's own scope, so a
-- counsellor running "Leads by counsellor" sees only their own row. Config keys are keys into
-- reports/entities.ts — never SQL. Idempotent: re-running inserts only what is missing.
WITH org AS (SELECT id FROM organisation ORDER BY id LIMIT 1),
defs(name, description, entity, config) AS (VALUES
  ('Leads by source', 'How many leads each source brought in this month.', 'leads',
   '{"columns":["source"],"group_by":["source"],"filters":[],"sort":[],"date_field":"created_at","date_preset":"this_month","chart":{"type":"pie","measure":"_count"}}'),
  ('Leads by counsellor', 'Leads created this month, per counsellor.', 'leads',
   '{"columns":["owner"],"group_by":["owner"],"filters":[],"sort":[],"date_field":"created_at","date_preset":"this_month","chart":{"type":"bar","measure":"_count"}}'),
  ('Leads by campaign', 'Leads created this month, per campaign.', 'leads',
   '{"columns":["campaign"],"group_by":["campaign"],"filters":[],"sort":[],"date_field":"created_at","date_preset":"this_month","chart":{"type":"bar","measure":"_count"}}'),
  ('Daily lead inflow (last 30 days)', 'New leads per day over the last 30 days.', 'leads',
   '{"columns":["created_day"],"group_by":["created_day"],"filters":[],"sort":[{"col":"created_day","dir":"asc"}],"date_field":"created_at","date_preset":"last_30","limit":60,"chart":{"type":"line","measure":"_count"}}'),
  ('Enrolments & revenue by counsellor', 'Sales closed this month: count, booked fee and cash collected, per counsellor.', 'enrolments',
   '{"columns":["counsellor","net_fee","collected"],"group_by":["counsellor"],"filters":[],"sort":[],"date_field":"created_at","date_preset":"this_month","chart":{"type":"bar","measure":"net_fee"}}'),
  ('Monthly collections', 'Fees received per month this year.', 'receipts',
   '{"columns":["received_month","amount"],"group_by":["received_month"],"filters":[],"sort":[{"col":"received_month","dir":"asc"}],"date_field":"received_at","date_preset":"this_year","chart":{"type":"line","measure":"amount"}}'),
  ('Fee dues ageing', 'Outstanding instalments by how overdue they are.', 'fee_dues',
   '{"columns":["ageing","outstanding"],"group_by":["ageing"],"filters":[],"sort":[{"col":"ageing","dir":"asc"}],"date_field":"due_date","date_preset":"all","chart":{"type":"bar","measure":"outstanding"}}'),
  ('Overdue instalments', 'Every instalment past its due date with money still to collect.', 'fee_dues',
   '{"columns":["student","phone","enrolment_no","course","counsellor","label","due_date","outstanding","days_overdue"],"group_by":[],"filters":[{"col":"is_overdue","op":"is_true"}],"sort":[{"col":"due_date","dir":"asc"}],"date_field":"due_date","date_preset":"all"}'),
  ('Calls by counsellor', 'Calls this month per counsellor, with talk time.', 'calls',
   '{"columns":["counsellor","talk_minutes"],"group_by":["counsellor"],"filters":[],"sort":[],"date_field":"call_start_at","date_preset":"this_month","chart":{"type":"bar","measure":"_count"}}'),
  ('Daily calls (last 30 days)', 'Calls made and received per day over the last 30 days.', 'calls',
   '{"columns":["call_day","talk_minutes"],"group_by":["call_day"],"filters":[],"sort":[{"col":"call_day","dir":"asc"}],"date_field":"call_start_at","date_preset":"last_30","limit":60,"chart":{"type":"line","measure":"_count"}}'),
  ('Call outcomes this month', 'Connected, not connected and missed calls this month.', 'calls',
   '{"columns":["outcome"],"group_by":["outcome"],"filters":[],"sort":[],"date_field":"call_start_at","date_preset":"this_month","chart":{"type":"pie","measure":"_count"}}'),
  ('Walk-ins by counsellor', 'Centre visitors this month per counsellor.', 'walk_ins',
   '{"columns":["counsellor"],"group_by":["counsellor"],"filters":[],"sort":[],"date_field":"visited_at","date_preset":"this_month","chart":{"type":"bar","measure":"_count"}}')
)
INSERT INTO report_definition (org_id, name, description, entity, config, owner_id, is_standard)
SELECT org.id, d.name, d.description, d.entity, d.config::jsonb, NULL, TRUE
  FROM defs d CROSS JOIN org
 WHERE NOT EXISTS (SELECT 1 FROM report_definition r
                    WHERE r.is_standard AND r.deleted_at IS NULL AND lower(r.name) = lower(d.name));
