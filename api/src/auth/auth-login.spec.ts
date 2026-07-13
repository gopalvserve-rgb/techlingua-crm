import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

/**
 * Client update #1 — identifier login matrix: identifier = mobile OR email,
 * with backward-compatible behaviour, against a mocked DatabaseService.
 */
describe('AuthService.login (identifier = mobile OR email)', () => {
  const hash = bcrypt.hashSync('Secret@123', 4);
  const USER = { id: '7', name: 'Asha', email: 'asha@techlingua.in', phone: '+919811100001', password_hash: hash, status: 'active' };

  const makeService = (row: any) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      one: jest.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return row;
      }),
    };
    const jwt = { signAsync: jest.fn(async () => 'jwt.token.here') };
    const svc = new AuthService(db as any, jwt as any, null as any);
    return { svc, db, calls };
  };

  it('logs in by email (case-insensitive) — backward compatible', async () => {
    const { svc, calls } = makeService(USER);
    const res = await svc.login('ASHA@techlingua.in', 'Secret@123');
    expect(res.token).toBe('jwt.token.here');
    expect(calls[0].sql).toContain('lower(email)');
  });

  it.each([
    ['+919811100001'],
    ['+91 98111 00001'],
    ['9811100001'],
    ['09811100001'],
    ['0091 98111 00001'],
  ])('logs in by mobile %s (normalised to canonical E.164)', async (identifier) => {
    const { svc, calls } = makeService(USER);
    const res = await svc.login(identifier, 'Secret@123');
    expect(res.user.id).toBe(7);
    expect(calls[0].sql).toContain('phone = $1');
    expect(calls[0].params[0]).toBe('+919811100001');
  });

  it('rejects a wrong password for a mobile identifier', async () => {
    const { svc } = makeService(USER);
    await expect(svc.login('9811100001', 'nope')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects unknown identifiers and disabled users', async () => {
    const { svc } = makeService(null);
    await expect(svc.login('9999999999', 'Secret@123')).rejects.toBeInstanceOf(UnauthorizedException);
    const disabled = makeService({ ...USER, status: 'disabled' });
    await expect(disabled.svc.login('asha@techlingua.in', 'Secret@123')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects users without a password hash (OTP-only) on password login', async () => {
    const { svc } = makeService({ ...USER, password_hash: null });
    await expect(svc.login('9811100001', 'Secret@123')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
