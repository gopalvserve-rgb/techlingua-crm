import { BadRequestException, HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { OTP_GENERIC_MESSAGE, OtpService } from './otp.service';
import { SMS_NOT_CONFIGURED_MSG, SmsService } from './sms.provider';

/**
 * Client update #1 — OTP login flow: request/verify with 5-min expiry,
 * 3-attempt limit, 60s resend throttle and the not-configured 503 path.
 * DatabaseService + SmsService mocked; audit inserts captured.
 */

const USER = { id: '7', name: 'Asha', email: 'asha@techlingua.in', phone: '+919811100001', status: 'active' };

type Row = Record<string, any> | null;

function makeDb(handlers: { onOne?: (sql: string, p: unknown[]) => Row; queries?: Array<{ sql: string; params: unknown[] }> }) {
  const queries = handlers.queries ?? [];
  return {
    queries,
    one: jest.fn(async (sql: string, p: unknown[] = []) => (handlers.onOne ? handlers.onOne(sql, p) : null)),
    query: jest.fn(async (sql: string, p: unknown[] = []) => { queries.push({ sql, params: p }); return []; }),
  };
}

const devSms = { provider: jest.fn(async () => ({ name: 'dev', send: jest.fn(async () => undefined) })) } as unknown as SmsService;
const notConfiguredSms = {
  provider: jest.fn(async () => ({
    name: 'not_configured',
    send: async () => { throw new ServiceUnavailableException(SMS_NOT_CONFIGURED_MSG); },
  })),
} as unknown as SmsService;

describe('OtpService.request', () => {
  it('generates + stores a bcrypt-hashed OTP with 5-min expiry (dev provider)', async () => {
    const db = makeDb({ onOne: (sql) => (sql.includes('FROM "user"') ? USER : null) });
    const svc = new OtpService(db as any, devSms);
    const res = await svc.request('98111 00001');
    expect(res.ok).toBe(true);
    expect(res.message).toBe(OTP_GENERIC_MESSAGE);
    expect(res.expires_in_sec).toBe(300);
    const ins = db.queries.find((q) => q.sql.includes('INSERT INTO auth_otp'))!;
    expect(ins).toBeDefined();
    expect(String(ins.params[2])).toMatch(/^\$2[aby]\$/); // bcrypt hash, never the raw code
    expect(ins.sql).toContain("interval '5 minutes'");
    const audit = db.queries.find((q) => q.sql.includes('audit_log'))!;
    expect(String(audit.params[2])).toContain('otp_requested');
  });

  // Backlog (c) — user-enumeration hardening: with a configured gateway the
  // response is IDENTICAL for registered and unregistered mobiles.
  it('unregistered mobile -> generic 200, same shape as registered, nothing persisted', async () => {
    const db = makeDb({ onOne: () => null });
    const svc = new OtpService(db as any, devSms);
    const res = await svc.request('9999999999');
    expect(res).toEqual({ ok: true, message: OTP_GENERIC_MESSAGE, expires_in_sec: 300 });
    expect(db.queries.some((q) => q.sql.includes('INSERT INTO auth_otp'))).toBe(false);
    expect(db.queries.some((q) => q.sql.includes('audit_log'))).toBe(true); // rejection audited server-side
  });

  it('registered vs unregistered responses are byte-identical (no oracle)', async () => {
    const reg = new OtpService(makeDb({ onOne: (sql) => (sql.includes('FROM "user"') ? USER : null) }) as any, devSms);
    const unreg = new OtpService(makeDb({ onOne: () => null }) as any, devSms);
    const a = await reg.request('9811100001');
    const b = await unreg.request('9999999999');
    expect(JSON.stringify(Object.keys(a).sort())).toBe(JSON.stringify(Object.keys(b).sort()));
    expect(a.message).toBe(b.message);
    expect(a.ok).toBe(b.ok);
  });

  it('unregistered mobile is throttled like a registered one (60s, in-memory)', async () => {
    const svc = new OtpService(makeDb({ onOne: () => null }) as any, devSms);
    await svc.request('9999999998');
    const err = await svc.request('9999999998').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('resend inside 60s -> 429 throttle', async () => {
    const db = makeDb({
      onOne: (sql) => sql.includes('FROM "user"') ? USER
        : sql.includes('FROM auth_otp') ? { created_at: new Date(Date.now() - 20_000).toISOString() } : null,
    });
    const svc = new OtpService(db as any, devSms);
    const err = await svc.request('9811100001').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('resend after 60s is allowed', async () => {
    const db = makeDb({
      onOne: (sql) => sql.includes('FROM "user"') ? USER
        : sql.includes('FROM auth_otp') ? { created_at: new Date(Date.now() - 61_000).toISOString() } : null,
    });
    const svc = new OtpService(db as any, devSms);
    await expect(svc.request('9811100001')).resolves.toMatchObject({ ok: true });
  });

  it('no SMS gateway configured -> 503 with the settings message, nothing persisted', async () => {
    const db = makeDb({ onOne: (sql) => (sql.includes('FROM "user"') ? USER : null) });
    const svc = new OtpService(db as any, notConfiguredSms);
    const err = await svc.request('9811100001').catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).message).toBe(SMS_NOT_CONFIGURED_MSG);
    expect(db.queries.some((q) => q.sql.includes('INSERT INTO auth_otp'))).toBe(false);
  });

  // Backlog (c): the 503 must be uniform — an unregistered mobile gets the SAME
  // 503 while the gateway is unconfigured (registration is never consulted first).
  it('no gateway + UNREGISTERED mobile -> the same uniform 503', async () => {
    const svc = new OtpService(makeDb({ onOne: () => null }) as any, notConfiguredSms);
    const err = await svc.request('9999999997').catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).message).toBe(SMS_NOT_CONFIGURED_MSG);
  });

  it('rejects junk mobile input with 400', async () => {
    const svc = new OtpService(makeDb({}) as any, devSms);
    await expect(svc.request('12')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('OtpService.verify', () => {
  const CODE = '123456';
  const otpRow = (over: Partial<Record<string, any>> = {}) => ({
    id: '55', code_hash: bcrypt.hashSync(CODE, 4),
    expires_at: new Date(Date.now() + 200_000).toISOString(),
    attempts: 0, consumed_at: null, ...over,
  });
  const dbWith = (otp: Row) => makeDb({
    onOne: (sql) => sql.includes('FROM "user"') ? USER : sql.includes('FROM auth_otp') ? otp : null,
  });

  it('correct code -> user returned, OTP consumed, audit written', async () => {
    const db = dbWith(otpRow());
    const svc = new OtpService(db as any, devSms);
    const user = await svc.verify('98111 00001', CODE);
    expect(Number(user.id)).toBe(7);
    expect(db.queries.some((q) => q.sql.includes('consumed_at = now()'))).toBe(true);
    expect(db.queries.some((q) => String(q.params[2] ?? '').includes('otp_verified'))).toBe(true);
  });

  it('wrong code -> 401, attempt counter bumped, failure audited', async () => {
    const db = dbWith(otpRow());
    const svc = new OtpService(db as any, devSms);
    await expect(svc.verify('9811100001', '000000')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.queries.some((q) => q.sql.includes('attempts = attempts + 1'))).toBe(true);
    expect(db.queries.some((q) => String(q.params[2] ?? '').includes('otp_verify_failed'))).toBe(true);
  });

  it('expired code -> 401', async () => {
    const svc = new OtpService(dbWith(otpRow({ expires_at: new Date(Date.now() - 1000).toISOString() })) as any, devSms);
    await expect(svc.verify('9811100001', CODE)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attempt limit (3) reached -> 401 even with the right code', async () => {
    const svc = new OtpService(dbWith(otpRow({ attempts: 3 })) as any, devSms);
    await expect(svc.verify('9811100001', CODE)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('already-consumed code cannot be replayed', async () => {
    const svc = new OtpService(dbWith(otpRow({ consumed_at: new Date().toISOString() })) as any, devSms);
    await expect(svc.verify('9811100001', CODE)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('no OTP requested / unknown mobile -> 401 (no oracle)', async () => {
    const svc = new OtpService(dbWith(null) as any, devSms);
    await expect(svc.verify('9811100001', CODE)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('missing code -> 400', async () => {
    const svc = new OtpService(dbWith(otpRow()) as any, devSms);
    await expect(svc.verify('9811100001', '')).rejects.toBeInstanceOf(BadRequestException);
  });
});
