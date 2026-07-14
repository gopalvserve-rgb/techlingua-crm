import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY, IS_PUBLIC_KEY, SCOPED_ENTITY_KEY } from './rbac.decorators';
import { PERMISSION_CATALOG } from './permission-catalog';
import { MessagingController, WhatsAppWebhookController } from '../messaging/messaging.controller';
import { TemplateController } from '../templates/template.controller';
import { JourneyController } from '../journeys/journey.controller';
import { SettingsController } from '../settings/settings.controller';

/**
 * RBAC ON EVERY SPRINT-4 ENDPOINT — enforced mechanically, exactly as Sprint 3 did.
 *
 * A route that forgets @RequirePermission has no `request.scope`, so any scoped query it
 * builds either throws or (worse) falls open. This walks the real controller prototypes
 * via reflect-metadata, so it cannot go stale: add a route without a permission and the
 * build goes red.
 *
 * Sprint 4 raises the stakes: these endpoints hold the client's CREDENTIALS and can
 * message every lead in the database.
 */

const CONTROLLERS = [
  ['MessagingController', MessagingController],
  ['TemplateController', TemplateController],
  ['JourneyController', JourneyController],
  ['SettingsController', SettingsController],
] as const;

interface Route { controller: string; handler: string; permission?: string; public: boolean; scopedEntity?: string }

function routesOf(name: string, ctrl: new (...a: any[]) => unknown): Route[] {
  const proto = ctrl.prototype;
  return Object.getOwnPropertyNames(proto)
    .filter((m) => m !== 'constructor' && typeof proto[m] === 'function')
    .filter((m) => Reflect.getMetadata(METHOD_METADATA, proto[m]) !== undefined
      || Reflect.getMetadata(PATH_METADATA, proto[m]) !== undefined)
    .map((m) => ({
      controller: name,
      handler: m,
      permission: Reflect.getMetadata(PERMISSION_KEY, proto[m]) as string | undefined,
      public: Reflect.getMetadata(IS_PUBLIC_KEY, proto[m]) === true,
      scopedEntity: (Reflect.getMetadata(SCOPED_ENTITY_KEY, proto[m]) as { kind?: string } | undefined)?.kind,
    }));
}

const ALL_ROUTES = CONTROLLERS.flatMap(([n, c]) => routesOf(n, c as new (...a: any[]) => unknown));
const WEBHOOK_ROUTES = routesOf('WhatsAppWebhookController', WhatsAppWebhookController);
const CATALOG_KEYS = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));

describe('Sprint-4 RBAC coverage', () => {
  it('found every Sprint-4 route (the reflection actually works)', () => {
    expect(ALL_ROUTES.length).toBeGreaterThanOrEqual(20);
    for (const [name] of CONTROLLERS) expect(ALL_ROUTES.some((r) => r.controller === name)).toBe(true);
  });

  it('EVERY route requires a permission — none is unguarded', () => {
    const naked = ALL_ROUTES.filter((r) => !r.permission && !r.public);
    expect(naked.map((r) => `${r.controller}.${r.handler}`)).toEqual([]);
  });

  it('no Sprint-4 API route is @Public', () => {
    expect(ALL_ROUTES.filter((r) => r.public).map((r) => r.handler)).toEqual([]);
  });

  it('every required permission EXISTS in the catalog (a typo would deny everyone, silently)', () => {
    const unknown = ALL_ROUTES.map((r) => r.permission!).filter((k) => k && !CATALOG_KEYS.has(k));
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('MUTATIONS never sit behind a bare .read', () => {
    const mutators = ALL_ROUTES.filter((r) =>
      /^(create|update|remove|save|saveChannel|removeChannel|test|send|bulk|retry|optOut|optIn|setStatus|run)$/.test(r.handler));
    expect(mutators.length).toBeGreaterThanOrEqual(12);
    for (const r of mutators) {
      // `preview` is a POST but it is a READ (it renders what is on screen); it is not in
      // the list above precisely because of that.
      expect(r.permission).toMatch(/\.(manage|create|update|delete|send)$/);
    }
  });

  it('SETTINGS — where the credentials live — is ADMIN-ONLY, every single route', () => {
    const s = ALL_ROUTES.filter((r) => r.controller === 'SettingsController');
    expect(s.length).toBeGreaterThanOrEqual(6);
    for (const r of s) expect(r.permission).toMatch(/^settings\.(read|update)$/);
    // reading the channel list means reading which credentials exist: settings.read, not message.read
    expect(s.find((r) => r.handler === 'channels')!.permission).toBe('settings.read');
    // and every write — including "send test message", which USES a credential — is settings.update
    for (const h of ['save', 'saveChannel', 'removeChannel', 'test']) {
      expect(s.find((r) => r.handler === h)!.permission).toBe('settings.update');
    }
  });

  it('SENDING is separate from MANAGING: a counsellor may message their lead, not edit the opt-out list', () => {
    const m = Object.fromEntries(
      ALL_ROUTES.filter((r) => r.controller === 'MessagingController').map((r) => [r.handler, r.permission]),
    );
    expect(m.list).toBe('message.read');
    expect(m.summary).toBe('message.read');
    expect(m.optOuts).toBe('message.read');
    expect(m.send).toBe('message.send');
    expect(m.bulk).toBe('message.send');
    // the opt-out list and retrying a send are privileged
    expect(m.optOut).toBe('message.manage');
    expect(m.optIn).toBe('message.manage');
    expect(m.retry).toBe('message.manage');
  });

  it('TEMPLATES: read is wide, write is not', () => {
    const t = Object.fromEntries(
      ALL_ROUTES.filter((r) => r.controller === 'TemplateController').map((r) => [r.handler, r.permission]),
    );
    expect(t).toMatchObject({
      list: 'template.read', get: 'template.read', catalog: 'template.read', preview: 'template.read',
      create: 'template.create', update: 'template.update', remove: 'template.delete',
    });
  });

  it('JOURNEYS: activating/pausing/running one is a MUTATION (journey.update), not a read', () => {
    const j = Object.fromEntries(
      ALL_ROUTES.filter((r) => r.controller === 'JourneyController').map((r) => [r.handler, r.permission]),
    );
    expect(j).toMatchObject({
      list: 'journey.read', get: 'journey.read', runs: 'journey.read', triggers: 'journey.read',
      create: 'journey.create', update: 'journey.update',
      setStatus: 'journey.update',    // the kill switch is a privileged act
      run: 'journey.update',          // firing a journey by hand messages real people
      remove: 'journey.delete',
    });
  });
});

describe('the WhatsApp delivery webhook is the ONLY public Sprint-4 route', () => {
  it('both of its routes are @Public — Meta cannot send a JWT', () => {
    expect(WEBHOOK_ROUTES).toHaveLength(2);
    for (const r of WEBHOOK_ROUTES) expect(r.public).toBe(true);
  });

  it('...and it is therefore verified by SIGNATURE instead (see transports.spec.ts)', () => {
    // the GET handshake checks hub.verify_token; the POST checks X-Hub-Signature-256.
    expect(WEBHOOK_ROUTES.map((r) => r.handler).sort()).toEqual(['receive', 'verify']);
  });
});

describe('the permission catalog covers the Sprint-4 modules', () => {
  it.each(['template', 'journey', 'message', 'settings'])('module "%s" is in the catalog', (mod) => {
    expect(PERMISSION_CATALOG.some((m) => m.module === mod)).toBe(true);
  });

  it('the migration grants exactly the keys the controllers ask for', () => {
    const used = new Set(ALL_ROUTES.map((r) => r.permission!).filter(Boolean));
    for (const key of used) expect(CATALOG_KEYS.has(key)).toBe(true);
    // a key nobody uses is dead weight the client would see in Roles & Permissions
    for (const key of ['template.read', 'journey.read', 'message.read', 'message.send', 'settings.read', 'settings.update']) {
      expect(used.has(key)).toBe(true);
    }
  });
});
