import { markerKinds, resolveDltBody, triggerAliases } from './sms-template.engine';
import { SmsTemplateService } from './sms-template.service';
import { NotificationEventService } from '../notificationevents/notification-event.service';
import { OtpService } from '../auth/otp.service';

/**
 * 23 Nov 2026 — the client's 23 DLT-approved SMS templates ("templateDumpReport (2).xlsx"),
 * made the dynamic source of every event's SMS. The texts below are the client's own.
 */
const LEAD_ASSIGNED = 'Dear {#var#}, Thank you for your interest in Insta Infotech. Your enquiry for {#var#} Course has been assigned to our Admission Counsellor {#var#}. Our counsellor will contact you shortly. For assistance, call {#cbn#} or visit www.instainfotech.in.';
const DEMO = 'Dear {#var#}, your Demo Class for {#var#} Course at BCL is scheduled on {#var#} at {#var#}. Our Trainer will guide you during the session. Please be available at the scheduled time. For any assistance, call {#num#} or visit www.britishcollegeoflanguage.com.';
const OTP = 'Dear {#var#}, \nYour One-Time Password (OTP) for account login is {#num#} .\nThis OTP is valid for {#num#} minutes. Tech Lingua';

describe('DLT markers of every kind', () => {
  it('fills {#var#}, {#cbn#} and {#num#} positionally and leaves the approved words untouched', () => {
    expect(markerKinds(LEAD_ASSIGNED)).toEqual(['var', 'var', 'var', 'cbn']);
    const r = resolveDltBody(LEAD_ASSIGNED, ['name', 'course', 'counsellor', 'callback'],
      { name: 'Riya', course: 'Python', counsellor: 'Asha', callback: '+918506067041' });
    expect(r.text).toBe('Dear Riya, Thank you for your interest in Insta Infotech. Your enquiry for Python Course has been assigned to our Admission Counsellor Asha. Our counsellor will contact you shortly. For assistance, call +918506067041 or visit www.instainfotech.in.');
    expect(r.count).toBe(4);
    expect(r.missing).toEqual([]);
    expect(r.text).not.toMatch(/\{#/);
  });

  it('a missing value is reported (and left blank), never sent as a marker', () => {
    const r = resolveDltBody(DEMO, ['name', 'course', 'date', 'time', 'callback'], { name: 'Riya', course: 'German A1', callback: '+918506067041' });
    expect(r.missing).toEqual(['date', 'time']);
    expect(r.text).not.toMatch(/\{#/);
  });

  it('the old "lead_created" trigger and "new_lead_created" are the same', () => {
    expect(triggerAliases('lead_created')).toEqual(['lead_created', 'new_lead_created']);
    expect(triggerAliases('new_lead_created')).toEqual(['lead_created', 'new_lead_created']);
    expect(triggerAliases('lead_assigned')).toEqual(['lead_assigned']);
  });
});

describe('sending the DLT template for an event', () => {
  const TPL = { id: 3, header: 'lNSTAI', name: 'Insta Lead Assigned', body: LEAD_ASSIGNED, branch_id: 40, vertical_id: 39,
    dlt_template_id: '1777179080395849705', var_mapping: ['name', 'course', 'counsellor', 'callback'], trigger_event: 'lead_assigned', is_active: true };
  const LEAD = { id: 5, full_name: 'Riya Sharma', phone: '+919811111111', whatsapp_phone: null, branch_id: '40', vertical_id: '39',
    course: 'Python', counsellor: 'Asha', counsellor_phone: '+919800000000', vertical_phone: '+918506067041', institute: 'Insta Infotech',
    branch_name: 'Vikaspuri', branch_phone: null };
  function mk(templates: any[] = [TPL], seen = false) {
    const calls: any[] = [];
    const db: any = {
      one: async (sql: string) => {
        if (/FROM organisation/.test(sql)) return { id: '1' };
        if (/FROM lead l/.test(sql)) return LEAD;
        if (/FROM message_log WHERE dedupe_key/.test(sql)) return seen ? { id: '9' } : null;
        return null;
      },
      query: async (sql: string, p: any[]) => {
        calls.push({ sql, p });
        if (/FROM sms_template/.test(sql)) return templates.filter((t) => p[1].includes(t.trigger_event));
        return [];
      },
    };
    const queued: any[] = [];
    const messaging: any = { queue: async (m: any) => { queued.push(m); return { id: 77, status: 'queued' }; } };
    return { svc: new SmsTemplateService(db, messaging, {} as any), queued, calls };
  }

  it('picks the event\'s template for the lead\'s Branch + Vertical and queues it with the DLT header and template id', async () => {
    const { svc, queued } = mk();
    const r = await svc.sendForEvent('lead_assigned', 5, { dedupe_key: 'evt:lead_assigned:sms:5' });
    expect(r).toMatchObject({ status: 'queued', template_id: 3, missing: [] });
    expect(queued[0]).toMatchObject({
      channel: 'sms', to: '+919811111111', sms_sender_id: 'lNSTAI', sms_dlt_template_id: '1777179080395849705',
      dedupe_key: 'evt:lead_assigned:sms:5', guarded: true,
    });
    expect(queued[0].body).toContain('assigned to our Admission Counsellor Asha');
    expect(queued[0].body).toContain('call +918506067041 or visit');
  });

  it('event values (date, time …) fill their markers; no template -> null so the caller falls back; a repeat is not re-sent', async () => {
    const demo = { ...TPL, id: 10, body: DEMO, trigger_event: 'demo_scheduled', var_mapping: ['name', 'course', 'date', 'time', 'callback'] };
    const a = mk([demo]);
    await a.svc.sendForEvent('demo_scheduled', 5, { dedupe_key: 'k', vars: { date: '25 Nov 2026', time: '11:00 AM' } });
    expect(a.queued[0].body).toContain('scheduled on 25 Nov 2026 at 11:00 AM');
    expect(await mk([]).svc.sendForEvent('lead_assigned', 5, { dedupe_key: 'k' })).toBeNull();
    const b = mk([TPL], true);
    expect(await b.svc.sendForEvent('lead_assigned', 5, { dedupe_key: 'k' })).toMatchObject({ status: 'duplicate' });
    expect(b.queued).toHaveLength(0);
  });
});

describe('notification events use the DLT template first', () => {
  function mk(dltResult: any) {
    const dlt: any = { sendForEvent: jest.fn(async () => dltResult) };
    const templates: any = { build: jest.fn(async () => ({ channel: 'sms', to: 'x', body: 'old template' })) };
    const messaging: any = { queue: jest.fn(async () => ({ id: 1, status: 'queued' })) };
    const db: any = { one: async () => null, query: async () => [] };
    const svc = new NotificationEventService(db, templates, messaging, dlt);
    jest.spyOn(svc, 'resolve').mockResolvedValue({ sms_enabled: true, email_enabled: false, whatsapp_enabled: false, sms_template_id: 2 } as any);
    return { svc, dlt, templates, messaging };
  }

  it('an event with a DLT template sends it, and never the older template', async () => {
    const { svc, dlt, templates } = mk({ status: 'queued', template_id: 3 });
    const out = await svc.fire('lead_assigned', { lead_id: 5, vertical_id: 39 } as any);
    expect(dlt.sendForEvent).toHaveBeenCalledWith('lead_assigned', 5, expect.objectContaining({ dedupe_key: 'evt:lead_assigned:sms:5' }));
    expect(templates.build).not.toHaveBeenCalled();
    expect(out.sent).toBe(1);
  });

  it('a new lead shares the auto-send key, so it can never get two SMS', async () => {
    const { svc, dlt } = mk({ status: 'duplicate' });
    await svc.fire('new_lead_created', { lead_id: 8 } as any);
    expect(dlt.sendForEvent).toHaveBeenCalledWith('new_lead_created', 8, expect.objectContaining({ dedupe_key: 'sms_creation:8' }));
  });

  it('no DLT template for the event -> the older mapped template, as before', async () => {
    const { svc, templates, messaging } = mk(null);
    await svc.fire('batch_changed', { lead_id: 5 } as any);
    expect(templates.build).toHaveBeenCalled();
    expect(messaging.queue).toHaveBeenCalled();
  });
});

describe('Login OTP', () => {
  const USER = { id: '7', name: 'Asha', email: 'a@x.in', phone: '+919811100001', status: 'active' };
  const run = async (tpl: any) => {
    const sent: any[] = [];
    const provider = { name: 'nimbus', send: jest.fn(async (...a: any[]) => { sent.push(a); }) };
    const db: any = {
      one: jest.fn(async (sql: string) => (sql.includes('FROM "user"') ? USER : sql.includes("trigger_event = 'login_otp'") ? tpl : null)),
      query: jest.fn(async () => []),
    };
    await new OtpService(db, { provider: async () => provider } as any).request('98111 00001');
    return sent[0];
  };

  it('uses the client\'s DLT "Login OTP" template: its header, its id, its words', async () => {
    const [to, text, opts] = await run({ header: 'TECHLN', body: OTP, var_mapping: ['name', 'otp', 'otp_minutes'], dlt_template_id: '1777179517625448668' });
    expect(to).toBe('+919811100001');
    expect(text).toMatch(/^Dear Asha, \nYour One-Time Password \(OTP\) for account login is \d{6} \.\nThis OTP is valid for 5 minutes\. Tech Lingua$/);
    expect(opts).toEqual({ sender: 'TECHLN', dlt_template_id: '1777179517625448668' });
  });

  it('no active Login OTP template -> the plain message, as before', async () => {
    const [, text, opts] = await run(null);
    expect(text).toMatch(/is your Tech Lingua CRM login code/);
    expect(opts).toBeUndefined();
  });
});
