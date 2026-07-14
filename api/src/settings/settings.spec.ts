import { SETTING_GROUPS, GROUP_BY_KEY } from './settings.registry';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { MSG_PROVIDERS, missingRequirements, providersFor } from '../messaging/providers';
import { decryptSecret, encryptSecret, isEncrypted } from '../common/crypto.util';
import { makeSprint4Db } from '../messaging/sprint4.testkit';

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
    expect(GROUP_BY_KEY.calendar_sync).toBeTruthy();
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
