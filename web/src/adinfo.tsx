/**
 * The Facebook / Instagram ad a lead came from (client, 6 Nov 2026).
 * lead.ad_info (API migration 130) — stamped by the Meta Lead Ads webhook from the leadgen object:
 *   { page, campaign, adset, ad, form, platform, organic, …_id }
 */
export interface AdInfo {
  page?: string; page_id?: string;
  campaign?: string; campaign_id?: string;
  adset?: string; adset_id?: string;
  ad?: string; ad_id?: string;
  form?: string; form_id?: string;
  platform?: string; organic?: boolean;
}

/** lead.ad_info as an object, whatever shape it arrived in; null when the lead has none. */
export function adInfoOf(lead: any): AdInfo | null {
  let a = lead?.ad_info;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  return a && typeof a === 'object' && Object.keys(a).length ? (a as AdInfo) : null;
}

/** The read-only rows the lead view shows, in reading order (blank ones dropped). */
export function adInfoRows(a: AdInfo | null): Array<[string, string]> {
  if (!a) return [];
  const rows: Array<[string, string | undefined]> = [
    ['Facebook Page', a.page],
    ['Ad campaign', a.campaign],
    ['Ad set', a.adset],
    ['Ad', a.ad],
    ['Lead form', a.form],
    ['Platform', a.platform ? `${a.platform}${a.organic ? ' (organic)' : ''}` : undefined],
  ];
  return rows.filter((r): r is [string, string] => !!r[1]);
}
