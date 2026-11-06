import { META_LEAD_FIELDS, metaAdInfo } from './fb-pages.util';

/** Facebook / Instagram ad details on a lead (client, 6 Nov 2026). */
describe('metaAdInfo', () => {
  it('asks Meta for the answers and the ad they came from', () => {
    for (const f of ['field_data', 'campaign_name', 'adset_name', 'ad_name', 'platform']) {
      expect(META_LEAD_FIELDS.split(',')).toContain(f);
    }
  });

  it('folds a real leadgen object and the known Page / form into the bag', () => {
    const lead = {
      ad_id: '120252980665070257', ad_name: 'New Leads ad – Copy',
      adset_id: '120252980665080257', adset_name: 'Diploma October',
      campaign_id: '120252980516240257', campaign_name: 'Foreign-Langauge-Degree/Diploma Ads',
      form_id: '1505177794892363', platform: 'ig', is_organic: false,
    };
    expect(metaAdInfo(lead, { page: 'British College of Language', page_id: '1418092348302183', form: 'BCL-DIPLOMA-FORM' })).toEqual({
      page: 'British College of Language', page_id: '1418092348302183',
      campaign: 'Foreign-Langauge-Degree/Diploma Ads', campaign_id: '120252980516240257',
      adset: 'Diploma October', adset_id: '120252980665080257',
      ad: 'New Leads ad – Copy', ad_id: '120252980665070257',
      form: 'BCL-DIPLOMA-FORM', form_id: '1505177794892363',
      platform: 'Instagram', organic: false,
    });
  });

  it('drops blanks, names Facebook, and is null when nothing is known', () => {
    expect(metaAdInfo({ platform: 'fb', campaign_name: '  ' }, { page: '' })).toEqual({ platform: 'Facebook' });
    expect(metaAdInfo({}, {})).toBeNull();
    expect(metaAdInfo(null)).toBeNull();
  });
});
