import { BadRequestException, HttpException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import {
  MIN_PASSWORD_LENGTH,
  PasswordResetService,
  RESET_GENERIC_MESSAGE,
} from './password-reset.service';
import { sha256Hex } from '../common/crypto.util';

/**
 * Forgot-password / reset flow. DatabaseService, MessagingService and
 * ChannelConfigService are mocked; audit + password_reset writes are captured.
 * Mirrors the OTP spec's fake-db style.
 */

const USER = { id: '7', name: 'Asha', email: 'asha@techlingua.in', phone: '+919811100001', status: 'active' };

type Row = Record<string, any> | null;

function makeDb(handlers: { onOne?: (sql: string, p: unknown[]) => Row } = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db: any = {
    queries,
    one: jest.fn(async (sql: string, p: unknown[] = []) => (handlers.onOne ? handlers.onOne(sql, p) : null)),
    query: jest.fn(async (sql: string, p: unknown[] = []) => { queries.push({ sql, params: p }); return []; }),
    tx: jest.fn(async (fn: (c: any) => Promise<any>) => fn({
      query: async (sql: string, p: unknown[] = []) => { queries.push({ sql, params: p }); return { rows: [] }; },
    })),
  };
  return db;
}

// A ChannelConfigService that reports EMAIL as not configured (today's live state).
const smtpUnconfigured = { resolve: jest.fn(async () => null), list: jest.fn(async () => []) } as any;
// …and one that reports a working org-wide SMTP row.
const smtpConfigured = {
  resolve: jest.fn(async () => ({ provider: 'smtp', config: { host: 'smtp.x', port: 587, from_email: 'a@x' }, secrets: { username: 'u', password: 'p' } })),
  list: jest.fn(async () => []),
} as any;

const sentMailer = () => ({ sendNow: jest.fn(async () => ({ id: 1, status: 'sent' })) } as any);
const failedMailer = () => ({ sendNow: jest.fn(async () => ({ id: 1, status: 'failed', reason: 'Email (SMTP) is not configured — add it in Administration › Settings › Channels.' })) } as any);

describe('PasswordResetService.requestReset', () => {
  it('real user -> creates a hashed token + attempts a send, generic 200', async () => {
    const db = makeDb({ onOne: (sql) => (sql.includes('FROM "user"') ? USER : null) });
    const mail = sentMailer();
    const svc = new PasswordResetService(db, mail, smtpConfigured);
    const res = await svc.requestReset('asha@techlingua.in', undefined, '1.2.3.4', 'https://app.test');
    expect(res).toEqual({ ok: true, message: RESET_GENERIC_MESSAGE });
    const ins = db.queries.find((q: any) => q.sql.includes('INSERT INTO password_reset'))!;
    expect(ins).toBeDefined();
    // a 64-char sha-256 hex is stored — NEVER a raw token
    expect(String(ins.params[1])).toMatch(/^[a-f0-9]{64}$/);
    expect(ins.sql).toContain("interval '30 minutes'");
    expect(mail.sendNow).toHaveBeenCalledTimes(1);
    expect(mail.sendNow.mock.calls[0][0]).toMatchObject({ channel: 'email', to: USER.email });
    // the token / link is never written to the audit log
    const audits = db.queries.filter((q: any) => q.sql.includes('audit_log'));
    for (const a of audits) expect(String(a.params[2])).not.toContain('reset-password?token=');
  });

  it('unknown email -> generic 200, identical shape, NOTHING persisted (no enumeration)', async () => {
    const db = makeDb({ onOne: () => null });
    const svc = new PasswordResetService(db, sentMailer(), smtpConfigured);
    const res = await svc.requestReset('nobody@example.com', undefined, '1.2.3.4');
    expect(res).toEqual({ ok: true, message: RESET_GENERIC_MESSAGE });
    expect(db.queries.some((q: any) => q.sql.includes('INSERT INTO password_reset'))).toBe(false);
    // still audited server-side (server sees it; the caller does not)
    expect(db.queries.some((q: any) => q.sql.includes('audit_log'))).toBe(true);
  });

  it('real vs unknown responses are byte-identical (no oracle)', async () => {
    const real = new PasswordResetService(makeDb({ onOne: (sql) => (sql.includes('FROM "user"') ? USER : null) }), sentMailer(), smtpConfigured);
    const unknown = new PasswordResetService(makeDb({ onOne: () => null }), sentMailer(), smtpConfigured);
    const a = await real.requestReset('asha@techlingua.in', undefined, '9.9.9.9');
    const b = await unknown.requestReset('ghost@example.com', undefined, '9.9.9.9');
    expect(a).toEqual(b);
  });

  it('SMTP not configured -> generic 200, NO 500, reason recorded on the audit path', async () => {
    const db = makeDb({ onOne: (sql) => (sql.includes('FROM "user"') ? USER : null) });
    const mail = failedMailer();
    const svc = new PasswordResetService(db, mail, smtpUnconfigured);
    const res = await svc.requestReset('asha@techlingua.in', undefined, '1.2.3.4', 'https://app.test');
    expect(res).toEqual({ ok: true, message: RESET_GENERIC_MESSAGE }); // did NOT throw
    const sent = db.queries.find((q: any) => q.sql.includes('audit_log') && String(q.params[2]).includes('forgot_sent'))!;
    expect(sent).toBeDefined();
    expect(String(sent.params[2])).toContain('not configured');
  });

  it('rate limit fires after repeated requests (per key)', async () => {
    const db = makeDb({ onOne: (sql) => (sql.includes('FROM "user"') ? USER : null) });
    const svc = new PasswordResetService(db, sentMailer(), smtpConfigured);
    let last: any;
    for (let i = 0; i < 6; i++) last = await svc.requestReset('asha@techlingua.in', undefined, `10.0.0.${i}`).catch((e) => e);
    expect(last).toBeInstanceOf(HttpException);
    expect((last as HttpException).getStatus()).toBe(429);
  });
});

describe('PasswordResetService.performReset', () => {
  const TOKEN = 'a'.repeat(43); // stand-in token; hashed below
  const hash = sha256Hex(TOKEN);
  const validRow = { id: '11', user_id: '7', token_hash: hash, expires_at: new Date(Date.now() + 60_000).toISOString(), used_at: null };

  it('valid token -> sets a new bcrypt password + marks the token used', async () => {
    const db = makeDb({ onOne: (sql) => (sql.includes('FROM password_reset') ? { ...validRow } : null) });
    const svc = new PasswordResetService(db, sentMailer(), smtpConfigured);
    const res = await svc.performReset(TOKEN, 'NewPass123');
    expect(res.ok).toBe(true);
    const setPw = db.queries.find((q: any) => q.sql.includes('UPDATE "user" SET password_hash'))!;
    expect(setPw).toBeDefined();
    expect(String(setPw.params[1])).toMatch(/^\$2[aby]\$/); // bcrypt hash of the new password
    expect(await bcrypt.compare('NewPass123', String(setPw.params[1]))).toBe(true);
    expect(db.queries.some((q: any) => q.sql.includes('UPDATE password_reset SET used_at') )).toBe(true);
    // other outstanding tokens for the user are invalidated too
    expect(db.queries.some((q: any) => q.sql.includes('user_id = $1 AND used_at IS NULL'))).toBe(true);
  });

  it('unknown token -> rejected, no password change', async () => {
    const db = makeDb({ onOne: () => null });
    const svc = new PasswordResetService(db, sentMailer(), smtpConfigured);
    await expect(svc.performReset('deadbeef', 'NewPass123')).rejects.toBeInstanceOf(BadRequestException);
    expect(db.queries.some((q: any) => q.sql.includes('UPDATE "user" SET password_hash'))).toBe(false);
  });

  it('expired token -> rejected', async () => {
    const db = makeDb({ onOne: (sql) => (sql.includes('FROM password_reset') ? { ...validRow, expires_at: new Date(Date.now() - 1000).toISOString() } : null) });
    const svc = new PasswordResetService(db, sentMailer(), smtpConfigured);
    await expect(svc.performReset(TOKEN, 'NewPass123')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('already-used token -> rejected', async () => {
    const db = makeDb({ onOne: (sql) => (sql.includes('FROM password_reset') ? { ...validRow, used_at: new Date().toISOString() } : null) });
    const svc = new PasswordResetService(db, sentMailer(), smtpConfigured);
    await expect(svc.performReset(TOKEN, 'NewPass123')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('weak password -> rejected before any token lookup', async () => {
    const db = makeDb({ onOne: (sql) => (sql.includes('FROM password_reset') ? { ...validRow } : null) });
    const svc = new PasswordResetService(db, sentMailer(), smtpConfigured);
    await expect(svc.performReset(TOKEN, 'short')).rejects.toBeInstanceOf(BadRequestException);
    expect(String(MIN_PASSWORD_LENGTH)).toBe('8');
  });
});
