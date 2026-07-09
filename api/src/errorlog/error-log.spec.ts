import {
  classify, fingerprintOf, MAX_STACK, normalizeMessage, normalizePath, truncStack, ErrorLogService,
} from './error-log.service';
import { redact } from '../common/redact';
import { DatabaseService } from '../database/database.service';

describe('error-log classify (capture policy)', () => {
  it('logs every 5xx as error', () => {
    expect(classify(500)).toBe('error');
    expect(classify(502)).toBe('error');
    expect(classify(503)).toBe('error');
  });

  it('logs 409 and 400 as warning (issues)', () => {
    expect(classify(409)).toBe('warning');
    expect(classify(400)).toBe('warning');
  });

  it('never logs 401 / 403 / 404 (noise)', () => {
    expect(classify(401)).toBeNull();
    expect(classify(403)).toBeNull();
    expect(classify(404)).toBeNull();
  });

  it('never logs 2xx/3xx', () => {
    expect(classify(200)).toBeNull();
    expect(classify(201)).toBeNull();
    expect(classify(302)).toBeNull();
  });
});

describe('error-log fingerprint (grouping)', () => {
  it('is stable for identical source+path+message', () => {
    expect(fingerprintOf('api', '/api/leads', 'boom')).toBe(fingerprintOf('api', '/api/leads', 'boom'));
  });

  it('collapses numeric ids in the path so occurrences group', () => {
    expect(fingerprintOf('api', '/api/leads/12/notes', 'x')).toBe(fingerprintOf('api', '/api/leads/9910/notes', 'x'));
    expect(normalizePath('/api/leads/12/notes?limit=5')).toBe('/api/leads/:id/notes');
  });

  it('collapses digits and quoted values in the message', () => {
    expect(fingerprintOf('api', '/api/masters/course', "Duplicate value: name 'Python' already exists"))
      .toBe(fingerprintOf('api', '/api/masters/course', "Duplicate value: name 'Java 101' already exists"));
    expect(normalizeMessage("Key (id)=(42) 'abc' \"def\"")).toBe('key (id)=(#) \'*\' "*"');
  });

  it('differs across sources, paths and messages', () => {
    expect(fingerprintOf('api', '/a', 'x')).not.toBe(fingerprintOf('web', '/a', 'x'));
    expect(fingerprintOf('api', '/a', 'x')).not.toBe(fingerprintOf('api', '/b', 'x'));
    expect(fingerprintOf('api', '/a', 'x')).not.toBe(fingerprintOf('api', '/a', 'y'));
  });
});

describe('error-log stack truncation', () => {
  it('keeps short stacks intact and nulls empty ones', () => {
    expect(truncStack('Error: x\n  at y')).toBe('Error: x\n  at y');
    expect(truncStack(null)).toBeNull();
    expect(truncStack(undefined)).toBeNull();
  });

  it('truncates long stacks to ~4000 chars with a marker', () => {
    const long = 'x'.repeat(MAX_STACK + 500);
    const out = truncStack(long)!;
    expect(out.length).toBeLessThanOrEqual(MAX_STACK + 20);
    expect(out.endsWith('[truncated]')).toBe(true);
  });
});

describe('error-log redaction (shared with audit interceptor)', () => {
  it('redacts sensitive keys, case-insensitive substring match', () => {
    const out = redact({ password: 'p', NEW_PASSWORD: 'n', api_key: 'k', name: 'ok' }) as any;
    expect(out.password).toBe('[redacted]');
    expect(out.NEW_PASSWORD).toBe('[redacted]');
    expect(out.api_key).toBe('[redacted]');
    expect(out.name).toBe('ok');
  });

  it('redacts nested payloads (error_log meta.body)', () => {
    const out = redact({ body: { email: 'a@b.c', password: 'secret1', token: 't' } }) as any;
    expect(out.body.password).toBe('[redacted]');
    expect(out.body.token).toBe('[redacted]');
    expect(out.body.email).toBe('a@b.c');
  });

  it('passes through primitives and arrays safely', () => {
    expect(redact('x')).toBe('x');
    expect(redact(null)).toBeNull();
    expect((redact([{ secret: 's' }]) as any)[0].secret).toBe('[redacted]');
  });
});

describe('error-log capture fail-safety', () => {
  const svc = (db: Partial<DatabaseService>) => new ErrorLogService(db as DatabaseService);

  it('resolves null instead of throwing when the insert rejects', async () => {
    const s = svc({ query: jest.fn().mockRejectedValue(new Error('db down')) as any });
    await expect(
      s.capture({ source: 'api', level: 'error', message: 'x' }),
    ).resolves.toBeNull();
  });

  it('resolves null instead of throwing when the db call throws synchronously', async () => {
    const s = svc({ query: (() => { throw new Error('sync boom'); }) as any });
    await expect(
      s.capture({ source: 'api', level: 'error', message: 'x' }),
    ).resolves.toBeNull();
  });

  it('persists a redacted meta and truncated fields on success', async () => {
    const query = jest.fn().mockResolvedValue([{ id: '7' }]);
    const s = svc({ query: query as any });
    const id = await s.capture({
      source: 'api', level: 'warning', statusCode: 409, method: 'POST',
      path: '/api/masters/course/15', message: 'dup', stack: 'y'.repeat(9000),
      meta: { body: { name: 'X', password: 'nope' } },
    });
    expect(id).toBe(7);
    const params = query.mock.calls[0][1] as unknown[];
    expect(params[4]).toBe('/api/masters/course/:id');          // path normalised
    expect((params[6] as string).length).toBeLessThanOrEqual(MAX_STACK + 20); // stack truncated
    expect(params[11]).toContain('[redacted]');                 // meta redacted
    expect(params[11]).not.toContain('nope');
  });
});
