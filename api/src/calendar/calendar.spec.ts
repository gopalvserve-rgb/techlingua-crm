import { CalendarService } from './calendar.service';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { makeSprint4Db } from '../messaging/sprint4.testkit';
import { encryptSecret } from '../common/crypto.util';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';
import { isNotConfigured } from '../common/not-configured.exception';

/**
 * CALENDAR. The in-app calendar must work fully; Google/Outlook sync is
 * CREDENTIAL-BLOCKED and must degrade cleanly — the Google-Sheet-channel pattern:
 * a 503 that names what is missing, is NOT captured by the Error Log, and lights up the
 * moment the credentials are pasted into Settings.
 */

const scope = (over: Partial<ResolvedScope>): ResolvedScope => ({
  permissionKey: 'calendar.read', allowed: true, all: false, filters: [],
  allowedFields: null, deniedFields: [], ...over,
});
const OWN = scope({ filters: [{ kind: 'own', userId: 3 }] });
const ADMIN = scope({ all: true });

/**
 * The OAuth credentials moved from the plain `app_setting` blob into the ENCRYPTED
 * `channel_config` store (migration 028) — an OAuth client secret must not sit in
 * clear text next to the business hours. `build()` takes the same shape it always
 * did, so every assertion below still means exactly what it meant; only the place
 * the credential lives has changed, and it is now exercised through the REAL
 * ChannelConfigService (so the encryption is on the path, not stubbed out).
 */
function build(settingValue: Record<string, unknown> | null = null) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
    one: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return {}; },
  } as unknown as DatabaseService;
  const settings = {
    get: async (_k: string, fallback: Record<string, unknown>) => ({ ...fallback }),
    set: async () => undefined,
  } as any;
  const enforcer = { assertRefInScope: async () => undefined } as any;

  const rows: any[] = [];
  if (settingValue?.provider) {
    const secrets: Record<string, string> = {};
    if (settingValue.client_secret) secrets.client_secret = encryptSecret(String(settingValue.client_secret));
    if (settingValue.refresh_token) secrets.refresh_token = encryptSecret(String(settingValue.refresh_token));
    rows.push({
      id: 1, channel: 'calendar',
      provider: settingValue.provider === 'outlook' ? 'outlook_oauth' : 'google_oauth',
      vertical_id: null, is_active: true,
      config: settingValue.client_id ? { client_id: settingValue.client_id } : {},
      secrets,
    });
  }
  const configs = new ChannelConfigService(makeSprint4Db({ channelConfigs: rows }).db);
  return { svc: new CalendarService(db, new ScopeResolverService(), enforcer, settings, configs), calls };
}

describe('Google / Outlook sync — NOT CONFIGURED (credential-blocked, by design)', () => {
  it('reports "not configured" and names EXACTLY what is missing', async () => {
    const { svc } = build();
    const s = await svc.syncStatus();
    expect(s.configured).toBe(false);
    expect(s.provider).toBeNull();
    expect(s.missing).toContain('Calendar provider (Google or Outlook)');
    expect(s.note).toMatch(/in-app calendar works fully/i);
  });

  it('"Sync now" raises NotConfigured (a 503) — never a 500, never an Error-Log entry', async () => {
    const { svc } = build();
    await expect(svc.syncNow()).rejects.toThrow(/not configured/i);
    const err = await svc.syncNow().catch((e) => e);
    expect(isNotConfigured(err)).toBe(true);            // the Error Log filter skips it
    expect(err.getStatus()).toBe(503);
    expect(err.message).toMatch(/Calendar provider \(Google or Outlook\)/);
  });

  it('a PARTIALLY configured provider names only the remaining gaps', async () => {
    const { svc } = build({ provider: 'google', client_id: 'abc', enabled: true });
    const s = await svc.syncStatus();
    expect(s.configured).toBe(false);
    expect(s.missing).toEqual(['OAuth client secret', 'A connected account (OAuth consent)']);
    expect(s.missing).not.toContain('OAuth client id');
  });

  it('once every credential is present it reports CONFIGURED — no deploy, no code change', async () => {
    const { svc } = build({
      provider: 'google', client_id: 'a', client_secret: 'b', refresh_token: 'c', enabled: true,
    });
    const s = await svc.syncStatus();
    expect(s.configured).toBe(true);
    expect(s.missing).toEqual([]);
  });

  it('THE IN-APP CALENDAR STILL WORKS with no credentials at all', async () => {
    const { svc } = build();
    const feed = await svc.feed(OWN, OWN, { from: '2026-07-01', to: '2026-07-31' });
    expect(feed.range).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    expect(feed.events).toEqual([]);
    expect(feed.follow_ups).toEqual([]);
    expect(feed.sync.configured).toBe(false);          // surfaced, not thrown
  });
});

describe('the calendar feed is SCOPED through the central resolver', () => {
  it("a counsellor's events are narrowed to their own", async () => {
    const { svc, calls } = build();
    await svc.feed(OWN, OWN, {});
    const ev = calls.find((c) => /FROM calendar_event e/.test(c.sql))!;
    expect(ev.sql).toContain('e.owner_id = $1');
    expect(ev.params[0]).toBe(3);
  });

  it('a TEAM-scoped user filters on the denormalised team_id (not an empty 1=0 calendar)', async () => {
    const { svc, calls } = build();
    const team = scope({ filters: [{ kind: 'team', teamIds: [2, 5] }] });
    await svc.feed(team, team, {});
    const ev = calls.find((c) => /FROM calendar_event e/.test(c.sql))!;
    expect(ev.sql).toContain('e.team_id = ANY($1::bigint[])');
    expect(ev.sql).not.toMatch(/WHERE \(1=0\)/);
  });

  it('follow-ups on the calendar use the FOLLOW-UP permission scope, not the calendar one', async () => {
    const { svc, calls } = build();
    const calendarScope = ADMIN;                                    // calendar.read = all
    const followUpScope = scope({ filters: [{ kind: 'own', userId: 7 }] });   // followup.read = own
    await svc.feed(calendarScope, followUpScope, {});
    const ev = calls.find((c) => /FROM calendar_event e/.test(c.sql))!;
    const fu = calls.find((c) => /FROM follow_up f/.test(c.sql))!;
    expect(ev.sql).toContain('1=1');            // calendar: unrestricted
    expect(fu.sql).toContain('f.owner_id = $1'); // follow-ups: still their own
    expect(fu.params[0]).toBe(7);
  });

  it('rejects a malformed window instead of scanning everything', async () => {
    const { svc } = build();
    await expect(svc.feed(OWN, OWN, { from: 'soon' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(svc.feed(OWN, OWN, { from: '2026-09-01', to: '2026-08-01' })).rejects.toThrow(/not be after/);
  });
});

describe('event validation', () => {
  const bad = async (dto: Record<string, unknown>, msg: RegExp) => {
    const { svc } = build();
    await expect(svc.create(dto as any, 1, ADMIN)).rejects.toThrow(msg);
  };
  it('requires a title', () => bad({ starts_at: '2026-07-20T10:00:00Z' }, /title is required/));
  it('requires a valid start', () => bad({ title: 'Demo', starts_at: 'whenever' }, /valid date/));
  it('rejects an unknown event type', () =>
    bad({ title: 'Demo', starts_at: '2026-07-20T10:00:00Z', type: 'seance' }, /type must be one of/));
  it('rejects an end before the start', () =>
    bad({ title: 'Demo', starts_at: '2026-07-20T10:00:00Z', ends_at: '2026-07-20T09:00:00Z' }, /after starts_at/));
});
