import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

/** QA DEF-QA4-01 — a valid JWT must be rejected once its user is deactivated. */

function makeContext(authHeader?: string) {
  const req: any = { headers: authHeader ? { authorization: authHeader } : {} };
  return {
    req,
    ctx: {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req }),
    } as any,
  };
}

function makeGuard(opts: { isPublic?: boolean; payload?: any; verifyFails?: boolean; userRow?: any }) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(!!opts.isPublic) } as any;
  const jwt = {
    verifyAsync: opts.verifyFails
      ? jest.fn().mockRejectedValue(new Error('bad token'))
      : jest.fn().mockResolvedValue(opts.payload ?? { sub: 7, email: 'a@b.c', name: 'A' }),
  } as any;
  const db = { one: jest.fn().mockResolvedValue(opts.userRow) } as any;
  return { guard: new JwtAuthGuard(reflector, jwt, db), db, jwt };
}

describe('JwtAuthGuard', () => {
  it('lets public routes through without touching the DB', async () => {
    const { guard, db } = makeGuard({ isPublic: true });
    const { ctx } = makeContext();
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(db.one).not.toHaveBeenCalled();
  });

  it('401s when the bearer token is missing', async () => {
    const { guard } = makeGuard({});
    const { ctx } = makeContext();
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401s on an invalid/expired signature', async () => {
    const { guard } = makeGuard({ verifyFails: true });
    const { ctx } = makeContext('Bearer not.a.jwt');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a valid token for an ACTIVE user and sets request.user', async () => {
    const { guard, db } = makeGuard({ userRow: { status: 'active' } });
    const { ctx, req } = makeContext('Bearer good.jwt.token');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(db.one.mock.calls[0][1]).toEqual([7]); // status looked up for sub=7
    expect(req.user).toEqual({ id: 7, email: 'a@b.c', name: 'A' });
  });

  it('REJECTS a still-valid token once the user is deactivated (DEF-QA4-01)', async () => {
    const { guard } = makeGuard({ userRow: { status: 'disabled' } });
    const { ctx } = makeContext('Bearer good.jwt.token');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('REJECTS a valid token whose user no longer exists', async () => {
    const { guard } = makeGuard({ userRow: null });
    const { ctx } = makeContext('Bearer good.jwt.token');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
