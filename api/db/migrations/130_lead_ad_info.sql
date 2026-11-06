-- ============================================================================
-- 130 - FACEBOOK / INSTAGRAM AD DETAILS ON A LEAD (client, 6 Nov 2026)
--
-- A Lead Ads lead carries more than the form's answers: the Page, campaign, ad set, ad, form and
-- platform it came from. Meta returns them on the leadgen object; the CRM never asked for them,
-- so the client could not tell which ad produced a lead. Stored as one JSONB bag (names + ids)
-- because only Meta leads have it and its keys may grow:
--   { page, page_id, campaign, campaign_id, adset, adset_id, ad, ad_id, form, form_id,
--     platform ('Facebook' | 'Instagram'), organic }
-- ============================================================================

ALTER TABLE lead ADD COLUMN IF NOT EXISTS ad_info JSONB;
