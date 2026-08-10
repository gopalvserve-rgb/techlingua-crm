import { NotificationEventService } from './notification-event.service';

/**
 * NOTIFICATION EVENTS — the firing contract, with lightweight stubs for db / templates /
 * messaging (no SQL emulation): an ENABLED channel with a MAPPED template sends the mapped
 * template on the right channel; a DISABLED channel does NOT send; firing is idempotent per
 * event-instance; an unconfigured channel degrades to a counted skip, never a throw; an
 * opted-out recipient is skipped; an enabled channel with NO template maps to nothing.
 */

type Cfg = {
  sms_enabled?: boolean; email_enabled?: boolean; whatsapp_enabled?: boolean;
  sms_template_id?: number | null; email_template_id?: number | null; whatsapp_template_id?: number | null;
};

function build(cfg: Cfg, opts: { dupKeys?: Set<string>; queueImpl?: (m: any) => any } = {}) {
  const queued: any[] = [];
  const dupKeys = opts.dupKeys ?? new Set<string>();

  const db: any = {
    async one(sql: string, params: any[]) {
      if (sql.includes('FROM organisation')) return { id: '1' };
      if (sql.includes('FROM student')) return { lead_id: '7', vertical_id: '2' };
      if (sql.includes('FROM message_template')) return { channel: 'sms' };
      if (sql.includes('FROM message_log') && sql.includes('dedupe_key')) {
        return dupKeys.has(params[0]) ? { id: '999' } : null;
      }
      if (sql.includes('FROM notification_event WHERE event_key')) {
        return { default_sms: false, default_email: false, default_whatsapp: false };
      }
      return null;
    },
    async query(sql: string) {
      if (sql.includes('notification_event_config') && sql.includes('LEFT JOIN')) {
        // resolve(): one effective row
        return [{
          recipient: 'lead',
          sms_enabled: cfg.sms_enabled ?? false, default_sms: false,
          email_enabled: cfg.email_enabled ?? false, default_email: false,
          whatsapp_enabled: cfg.whatsapp_enabled ?? false, default_whatsapp: false,
          sms_template_id: cfg.sms_template_id ?? null,
          email_template_id: cfg.email_template_id ?? null,
          whatsapp_template_id: cfg.whatsapp_template_id ?? null,
        }];
      }
      return [];
    },
  };

  const templates: any = {
    async build({ lead_id, template_id }: any) {
      // pretend template_id 100=sms,101=email,102=whatsapp
      const channel = template_id === 101 ? 'email' : template_id === 102 ? 'whatsapp' : 'sms';
      return { channel, to: channel === 'email' ? 'x@y.com' : '+919810000001', body: 'hi', lead_id, template_id };
    },
  };

  const messaging: any = {
    async queue(m: any) {
      queued.push(m);
      if (opts.queueImpl) return opts.queueImpl(m);
      return { id: queued.length, status: 'queued' };
    },
  };

  const svc = new NotificationEventService(db, templates, messaging);
  return { svc, queued };
}

describe('NotificationEventService.fire', () => {
  it('sends the mapped template on each ENABLED channel and NOT on disabled ones', async () => {
    const { svc, queued } = build({
      sms_enabled: true, sms_template_id: 100,
      email_enabled: false, email_template_id: 101,   // mapped but DISABLED
      whatsapp_enabled: true, whatsapp_template_id: 102,
    });
    const out = await svc.fire('new_lead_created', { lead_id: 7 });
    expect(out.sent).toBe(2);
    const channels = queued.map((m) => m.channel).sort();
    expect(channels).toEqual(['sms', 'whatsapp']);
    // never the disabled email channel
    expect(queued.find((m) => m.channel === 'email')).toBeUndefined();
    // every send is guarded (automation) and carries a deterministic dedupe key
    expect(queued.every((m) => m.guarded === true && String(m.dedupe_key).startsWith('evt:new_lead_created:'))).toBe(true);
  });

  it('does NOT send on an enabled channel that has no template mapped', async () => {
    const { svc, queued } = build({ sms_enabled: true, sms_template_id: null });
    const out = await svc.fire('new_lead_created', { lead_id: 7 });
    expect(out.sent).toBe(0);
    expect(queued.length).toBe(0);
    expect(out.results.find((r: any) => r.channel === 'sms')?.status).toBe('no_template');
  });

  it('is idempotent — a duplicate event-instance is skipped, not re-sent', async () => {
    const dupKeys = new Set<string>(['evt:new_lead_created:whatsapp:7']);
    const { svc, queued } = build(
      { sms_enabled: true, sms_template_id: 100, whatsapp_enabled: true, whatsapp_template_id: 102 },
      { dupKeys },
    );
    const out = await svc.fire('new_lead_created', { lead_id: 7 });
    expect(queued.map((m) => m.channel)).toEqual(['sms']);   // whatsapp already fired
    expect(out.results.find((r: any) => r.channel === 'whatsapp')?.status).toBe('duplicate');
  });

  it('degrades cleanly when a channel is unconfigured (failed/not_configured) — counted, never thrown', async () => {
    const { svc } = build(
      { sms_enabled: true, sms_template_id: 100 },
      { queueImpl: () => ({ id: 1, status: 'failed', reason: 'not configured' }) },
    );
    const out = await svc.fire('new_lead_created', { lead_id: 7 });
    expect(out.sent).toBe(1);   // it was queued; delivery marks it failed/amber later
    expect(out.results[0].status).toBe('failed');
  });

  it('respects opt-out — a skipped queue result counts as skipped, not sent', async () => {
    const { svc } = build(
      { whatsapp_enabled: true, whatsapp_template_id: 102 },
      { queueImpl: () => ({ id: 1, status: 'skipped', reason: 'Opted out of whatsapp — not sent' }) },
    );
    const out = await svc.fire('new_lead_created', { lead_id: 7 });
    expect(out.sent).toBe(0);
    expect(out.skipped).toBe(1);
  });

  it('resolves a student to its lead and vertical, then fires', async () => {
    const { svc, queued } = build({ sms_enabled: true, sms_template_id: 100 });
    const out = await svc.fire('enrollment_created', { student_id: 5 });
    expect(out.sent).toBe(1);
    expect(queued[0].lead_id).toBe(7);   // student.lead_id from the stub
  });
});
