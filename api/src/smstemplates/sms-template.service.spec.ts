import { ChannelConfigService } from '../messaging/channel-config.service';
import { MessagingService } from '../messaging/messaging.service';
import { makeSprint4Db, settings4 } from '../messaging/sprint4.testkit';
import { encryptSecret } from '../common/crypto.util';
import { SmsTemplateService } from './sms-template.service';
import { DatabaseService } from '../database/database.service';

const NIMBUS = {
  id: 9, channel: 'sms', provider: 'nimbus', vertical_id: null, is_active: true,
  config: { user: 'techlingua', entityid: '1101234567890', sender_id: 'BRTISC' },
  secrets: { authkey: encryptSecret('92wgQ8noCHyY') },
};

const BCL_TPL = {
  id: 1, org_id: 1, header: 'BRTISC', name: 'BCL Lead Creation II',
  body: 'Dear {#var#}, thank you for your interest in {#var#}. - BCL',
  branch_id: 9, vertical_id: 1, dlt_template_id: '1707160000000000001', entity_id: null,
  var_mapping: ['name', 'course'], unicode: null, trigger_event: 'lead_created',
  is_active: true, deleted_at: null,
};

/** A DB double for both MessagingService (via the sprint4 kit) and SmsTemplateService's
 *  own three statements (lead vars, sms_template candidates, dedupe check). */
function makeDb(opts: { templates?: any[]; leads?: Record<number, any> } = {}) {
  const { db: base, st } = makeSprint4Db({ channelConfigs: [] });
  const templates = opts.templates ?? [BCL_TPL];
  const leads = opts.leads ?? {};
  const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      const s = norm(sql);
      if (/FROM sms_template WHERE org_id = \$1/.test(s)) {
        const [, trigger, branch, vertical] = params as any[];
        return templates.filter((t) => !t.deleted_at && t.is_active && t.trigger_event === trigger
          && (t.branch_id === branch || t.branch_id == null)
          && (t.vertical_id === vertical || t.vertical_id == null));
      }
      return base.query(sql, params);
    },
    one: async (sql: string, params: unknown[] = []) => {
      const s = norm(sql);
      if (/FROM lead l LEFT JOIN m_course/.test(s)) return leads[Number(params[0])] ?? null;
      if (/SELECT id FROM message_log WHERE dedupe_key/.test(s)) {
        const hit = st.messages.find((m: any) => m.dedupe_key === params[0]);
        return hit ? { id: String(hit.id) } : null;
      }
      return base.one(sql, params);
    },
    tx: (base as any).tx,
  } as unknown as DatabaseService;
  return { db, st };
}

const build = (opts?: Parameters<typeof makeDb>[0]) => {
  const { db, st } = makeDb(opts);
  const configs = new ChannelConfigService(db);
  const messaging = new MessagingService(db, configs, settings4());
  const svc = new SmsTemplateService(db, messaging, configs);
  return { db, st, svc, configs, messaging };
};

const LEAD_BCL = { id: 50, full_name: 'Priya Sharma', phone: '+919810000001', whatsapp_phone: null, branch_id: 9, vertical_id: 1, course: 'IELTS' };

describe('Nimbus SMS creation auto-send', () => {
  it('NOT CONFIGURED degrades cleanly: no crash, one logged not_configured row', async () => {
    const { svc, st } = build({ leads: { 50: LEAD_BCL } });      // no nimbus config
    const r = await svc.autoSendCreation(50);
    expect(r.status).toBe('failed');
    const rows = st.messages.filter((m) => m.dedupe_key === 'sms_creation:50');
    expect(rows).toHaveLength(1);
    expect(rows[0].not_configured).toBe(true);      // logged, amber, not an Error-Log incident
    expect(rows[0].body).toBe('Dear Priya Sharma, thank you for your interest in IELTS. - BCL');
  });

  it('IDEMPOTENT: a second creation fire sends nothing more (exactly one row ever)', async () => {
    const { svc, st } = build({ leads: { 50: LEAD_BCL } });
    await svc.autoSendCreation(50);
    const second = await svc.autoSendCreation(50);
    expect(second.reason).toBe('already_sent');
    expect(st.messages.filter((m) => m.dedupe_key === 'sms_creation:50')).toHaveLength(1);
  });

  it('OPT-OUT is respected — the creation SMS is skipped, transport never reached', async () => {
    const { svc, st } = build({ leads: { 50: LEAD_BCL } });
    st.channelConfigs.push({ ...NIMBUS });
    st.optOuts.push({ id: 1, channel: 'sms', identifier: '+919810000001', lead_id: 50 });
    const r = await svc.autoSendCreation(50);
    expect(r.status).toBe('skipped');
    const row = st.messages.find((m) => m.dedupe_key === 'sms_creation:50')!;
    expect(row.status).toBe('skipped');
    expect(String(row.error)).toMatch(/opted out/i);
  });

  it('NO MATCHING TEMPLATE => no send at all', async () => {
    const other = { ...BCL_TPL, branch_id: 99, vertical_id: 88 };
    const { svc, st } = build({ leads: { 50: LEAD_BCL }, templates: [other] });
    const r = await svc.autoSendCreation(50);
    expect(r.reason).toBe('no_matching_template');
    expect(st.messages).toHaveLength(0);
  });

  it('a lead with no phone is skipped, nothing logged', async () => {
    const { svc, st } = build({ leads: { 51: { ...LEAD_BCL, id: 51, phone: null, whatsapp_phone: null } } });
    const r = await svc.autoSendCreation(51);
    expect(r.reason).toBe('no_phone');
    expect(st.messages).toHaveLength(0);
  });

  it('safeAutoSend never throws (best-effort, must not lose a stored lead)', async () => {
    const { svc } = build({ leads: {} });          // lead 999 absent -> varsForLead null
    await expect(svc.safeAutoSend('lead_created', 999)).resolves.toBeUndefined();
  });
});
