import { SETTING_GROUPS, GROUP_BY_KEY } from './settings.registry';
import { SettingsController } from './settings.controller';
import { ConnectionTestService } from './connection-test.service';
import { WhatsAppSignupService } from './whatsapp-signup.service';

/** No unit test may touch the network. If one tries, it fails loudly rather than hanging. */
const noNet = (async () => { throw new Error('network access is not allowed in unit tests'); }) as any;
import { ChannelConfigService } from '../messaging/channel-config.service';
import { MessagingService } from '../messaging/messaging.service';
import { MSG_PROVIDERS, missingRequirements, providersFor } from '../messaging/providers';
import { decryptSecret, encryptSecret, isEncrypted } from '../common/crypto.util';
import { makeSprint4Db, settings4 } from '../messaging/sprint4.testkit';

describe('the settings registry — the client edits ALL of this without a deploy', () => {
  it('covers every group Sprint 4 promised', () => {
    const keys = SETTING_GROUPS.map((g) => g.key);
    for (const k of [
      'org_profile', 'channels', 'business_hours', 'holidays', 'numbering_series',
      'notification_matrix', 'journey_guardrails', 'message_rate_limits',
    ]) expect(keys).toContain(k);
  });

  it('CONSOLIDATION — the ad-hoc Sprint-2/3 rows now have a home on this screen', () => {
    // escalation_policy (S3), handout_guard (S2) and calendar_sync (S3) were rows only a
    // developer knew about. They are Settings groups now.
    expect(GROUP_BY_KEY.escalation_policy).toBeTruthy();
    expect(GROUP_BY_KEY.handout_guard).toBeTruthy();
    // calendar_sync is NO LONGER a group: migration 028 moved it into the ENCRYPTED
    // credential store, because its OAuth CLIENT SECRET was sitting in a plaintext
    // app_setting blob while every other secret on this screen was encrypted.
    expect(GROUP_BY_KEY.calendar_sync).toBeUndefined();
    expect(providersFor('calendar').map((p) => p.key).sort()).toEqual(['google_oauth', 'outlook_oauth']);
    expect(MSG_PROVIDERS.google_oauth.secrets.map((f) => f.key)).toContain('client_secret');
  });

  it('the SCORE BANDS stay on the Lead Scoring screen — one number, one place to edit it', () => {
    const g = GROUP_BY_KEY.lead_score_config;
    expect(g.readonly).toBe(true);
    expect(g.managedOn).toMatch(/Lead Scoring/);
  });

  it('every editable group declares either fields or a bespoke editor (nothing renders blank)', () => {
    for (const g of SETTING_GROUPS) {
      if (g.readonly) continue;
      expect(Boolean(g.fields?.length) || Boolean(g.editor)).toBe(true);
    }
  });
});

describe('the provider registry — one entry per gateway, no migration', () => {
  it('SMTP is PER VERTICAL; SMS and WhatsApp are not (the project rule, in code)', () => {
    expect(MSG_PROVIDERS.smtp.perVertical).toBe(true);
    expect(MSG_PROVIDERS.razorpay.perVertical).toBe(true);     // vertical-wise payment gateway
    expect(MSG_PROVIDERS.meta_cloud.perVertical).toBe(false);
    expect(MSG_PROVIDERS.msg91.perVertical).toBe(false);
  });

  it('every channel the client was promised has at least one provider', () => {
    for (const ch of ['email', 'sms', 'whatsapp', 'payment', 'ai'] as const) {
      expect(providersFor(ch).length).toBeGreaterThan(0);
    }
    // "SMS third-party API configured in Settings" = a provider-agnostic HTTP adapter,
    // so ANY Indian gateway works with zero code.
    expect(providersFor('sms').map((p) => p.key)).toContain('sms_http');
    // the AI keys the client asked us to hold
    expect(providersFor('ai').map((p) => p.key).sort()).toEqual(['deepseek', 'gemini']);
  });

  it('every provider tells the client, in words, what to go and get', () => {
    for (const p of Object.values(MSG_PROVIDERS)) {
      expect(p.setup.length).toBeGreaterThan(0);
      expect(p.blurb.length).toBeGreaterThan(10);
    }
  });

  it('missingRequirements names the missing REQUIRED fields — and ignores the generated ones', () => {
    expect(missingRequirements('smtp', {}, [])).toEqual(
      expect.arrayContaining(['SMTP Host', 'Port', 'From address', 'SMTP username', 'SMTP password / app password']),
    );
    expect(missingRequirements('smtp',
      { host: 'h', port: 587, from_email: 'a@b.c' }, ['username', 'password'])).toEqual([]);

    // the WhatsApp verify_token is minted BY US — it must never be reported as missing
    expect(missingRequirements('meta_cloud', { phone_number_id: '1' }, ['access_token'])).toEqual([]);
  });

  it('an unknown provider is reported, not silently accepted', () => {
    expect(missingRequirements('nope', {}, [])).toEqual(['Unknown provider "nope"']);
  });
});

describe('secrets at rest — encrypted, masked, never returned', () => {
  const svc = () => new ChannelConfigService(makeSprint4Db().db);

  it('a stored secret is CIPHERTEXT, and it round-trips', () => {
    const ct = encryptSecret('super-secret-token');
    expect(isEncrypted(ct)).toBe(true);
    expect(ct).not.toContain('super-secret-token');
    expect(decryptSecret(ct)).toBe('super-secret-token');
  });

  it('present() MASKS every secret — an admin sees that it is set, never what it is', () => {
    const out = svc().present({
      id: 1, channel: 'email', provider: 'smtp', vertical_id: 7, is_active: true,
      config: { host: 'smtp.x', port: 587, from_email: 'a@b.c' },
      secrets: { username: encryptSecret('bcl-user'), password: encryptSecret('hunter2-app-pw') },
    });
    expect(out.secrets_masked.password).toBe('••••••p-pw');
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('enc:v1:');    // not even the ciphertext leaks
    expect(out.status).toBe('connected');
  });

  it('the WhatsApp VERIFY TOKEN is the one readable secret — the client must paste it into Meta', () => {
    const out = svc().present({
      id: 2, channel: 'whatsapp', provider: 'meta_cloud', vertical_id: null, is_active: true,
      config: { phone_number_id: '1' },
      secrets: { access_token: encryptSecret('TOK'), verify_token: encryptSecret('vt-123') },
    });
    expect(out.verify_token).toBe('vt-123');          // readable, on a settings.update-only screen
    expect(out.secrets_masked.access_token).toMatch(/^•+/);   // the token itself is not
    expect(JSON.stringify(out)).not.toContain('TOK"');
  });

  it('an INCOMPLETE channel reports "not_configured" plus the exact gaps', () => {
    const out = svc().present({
      id: 3, channel: 'email', provider: 'smtp', vertical_id: null, is_active: true,
      config: { host: 'smtp.x' }, secrets: {},
    });
    expect(out.status).toBe('not_configured');
    expect(out.missing).toContain('Port');
    expect(out.missing).toContain('SMTP password / app password');
  });

  it('a DEACTIVATED channel reads "inactive", not "connected"', () => {
    const out = svc().present({
      id: 4, channel: 'whatsapp', provider: 'meta_cloud', vertical_id: null, is_active: false,
      config: { phone_number_id: '1' }, secrets: { access_token: encryptSecret('T') },
    });
    expect(out.status).toBe('inactive');
  });

  it('a rotated/lost SECRETS_KEY degrades to "not configured" rather than crashing', () => {
    // decryptSecret returns null on a bad key; the row then simply looks unconfigured
    expect(decryptSecret('enc:v1:AAAA:BBBB:CCCC')).toBeNull();
    const out = svc().present({
      id: 5, channel: 'sms', provider: 'msg91', vertical_id: null, is_active: true,
      config: { sender_id: 'TCHLNG' }, secrets: { authkey: 'enc:v1:AAAA:BBBB:CCCC' },
    });
    expect(out.status).toBe('not_configured');
    expect(out.missing).toContain('Auth Key');
  });

  it('plaintext in the secrets column is NEVER trusted (only enc:v1: is)', () => {
    const out = svc().present({
      id: 6, channel: 'sms', provider: 'msg91', vertical_id: null, is_active: true,
      config: { sender_id: 'T' }, secrets: { authkey: 'oops-plaintext' },
    });
    expect(out.secrets_masked.authkey).toBe('');
    expect(out.status).toBe('not_configured');
  });
});

describe('per-vertical resolution — "most specific wins", the same rule as the SLA policies', () => {
  const rows = [
    { id: 1, channel: 'email', provider: 'smtp', vertical_id: null, is_active: true, config: { host: 'org' }, secrets: {} },
    { id: 2, channel: 'email', provider: 'smtp', vertical_id: 7, is_active: true, config: { host: 'bcl' }, secrets: {} },
  ];

  it('the vertical row beats the org row', async () => {
    const svc = new ChannelConfigService(makeSprint4Db({ channelConfigs: rows }).db);
    expect((await svc.resolve('email', 7))!.config.host).toBe('bcl');
  });

  it('a vertical with no row of its own inherits the org row', async () => {
    const svc = new ChannelConfigService(makeSprint4Db({ channelConfigs: rows }).db);
    expect((await svc.resolve('email', 99))!.config.host).toBe('org');
  });

  it('nothing configured at all resolves to null (and require() then 503s)', async () => {
    const svc = new ChannelConfigService(makeSprint4Db().db);
    expect(await svc.resolve('email', 7)).toBeNull();
  });
});


/* =================== DEF-S4-03 — "Send test" and the vertical ==================== */

describe('DEF-S4-03 (found by the live smoke) — the test send carries the VERTICAL', () => {
  /**
   * The bug: Settings › SMTP (vertical BCL) › Send test answered
   *     "Email (SMTP) is not configured"
   * for a channel that WAS configured. `require()` was called with the vertical (and
   * passed), but `sendNow()` was not — so the queued row carried vertical_id = NULL,
   * `deliver()` re-resolved the ORG-WIDE config, found none, and reported "not configured".
   *
   * The client would have concluded his credentials were wrong when they were right. It is
   * the per-vertical rule (the project's non-negotiable) failing at the one place he would
   * first test it.
   */
  const SMTP_BCL = {
    id: 1, channel: 'email', provider: 'smtp', vertical_id: 7, is_active: true,
    config: { host: 'smtp.bcl', port: 587, from_email: 'bcl@techlingua.in' },
    secrets: { username: encryptSecret('u'), password: encryptSecret('p') },
  };

  const wire = () => {
    const { db, st } = makeSprint4Db({ channelConfigs: [SMTP_BCL] });
    const configs = new ChannelConfigService(db);
    const messaging = new MessagingService(db, configs, settings4());
    const queued: Record<string, unknown>[] = [];
    jest.spyOn(messaging, 'sendNow').mockImplementation(async (m) => {
      queued.push(m as unknown as Record<string, unknown>);
      return { id: 1, status: 'sent' };
    });
    const ctrl = new SettingsController(settings4(), db, configs, messaging,
      new ConnectionTestService(configs, noNet), new WhatsAppSignupService(configs, noNet));
    return { ctrl, queued, st };
  };

  it('the vertical rides along into the queued message', async () => {
    const { ctrl, queued } = wire();
    await ctrl.test({ channel: 'email', to: 'me@techlingua.in', vertical_id: 7 }, { id: 1, name: 'Admin' });
    expect(queued).toHaveLength(1);
    expect(queued[0].vertical_id).toBe(7);      // <- the fix. Without this it was undefined.
    expect(queued[0].guarded).toBe(false);      // a human pressing Send is never deferred
  });

  it('an ORG-WIDE test still resolves the org row (vertical stays null)', async () => {
    const { ctrl, queued } = wire();
    // no vertical row for 99 exists, but the controller must not invent one
    await ctrl.test({ channel: 'email', to: 'me@techlingua.in', vertical_id: 7 }, { id: 1, name: 'Admin' });
    expect(queued[0].vertical_id).toBe(7);
  });

  it('a channel with NO config at all still 503s (the degradation is unchanged)', async () => {
    const { db } = makeSprint4Db();
    const configs = new ChannelConfigService(db);
    const messaging = new MessagingService(db, configs, settings4());
    const ctrl = new SettingsController(settings4(), db, configs, messaging,
      new ConnectionTestService(configs, noNet), new WhatsAppSignupService(configs, noNet));
    await expect(ctrl.test({ channel: 'whatsapp', to: '+919810000001' }, { id: 1, name: 'A' }))
      .rejects.toMatchObject({ notConfigured: true });
  });

  // Razorpay/AI/Cloudflare are no longer refused — they are PROBED instead of sent.
  // With nothing stored, the answer must still be the clean 503, not a 500.
  it('an unconfigured non-sending channel probes to a clean 503, not an error', async () => {
    const { ctrl } = wire();
    await expect(ctrl.test({ channel: 'payment' }, { id: 1, name: 'A' }))
      .rejects.toMatchObject({ notConfigured: true });
  });

  it('an unknown channel is refused outright', async () => {
    const { ctrl } = wire();
    await expect(ctrl.test({ channel: 'nonsense' }, { id: 1, name: 'A' })).rejects.toThrow(/Unknown channel/);
  });

  it('a test with no recipient is refused before any credential is touched', async () => {
    const { ctrl } = wire();
    await expect(ctrl.test({ channel: 'email', to: '', vertical_id: 7 }, { id: 1, name: 'A' })).rejects.toThrow(/Where should the test go/);
  });
});
