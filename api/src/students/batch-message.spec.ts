import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BatchService } from './batch.service';
import { BatchController } from './batch.controller';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * BATCH MESSAGING (client feedback item 9) — POST /batches/:id/message.
 * Send an update to a batch's students in BULK (no student_ids) or INDIVIDUALLY (student_ids).
 * Mirrors the fee-reminder pattern: one message_log per recipient via the channel-agnostic
 * notifier, and an unconfigured channel DEGRADES to a logged attempt (never throws).
 */

const scopeAll: ResolvedScope = { permissionKey: 'batch.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const scopeNone: ResolvedScope = { permissionKey: 'batch.read', allowed: true, all: false, filters: [{ kind: 'own', userId: 7 }], allowedFields: null, deniedFields: [] };

const resolver = {
  buildScopeWhere: (scope: ResolvedScope, _cols: any, _params: unknown[]) => (scope.all ? '1=1' : '1=0'),
} as any;

const ROSTER = [
  { id: 101, full_name: 'Asha Rao', phone: '+919000000001', email: 'asha@example.com', lead_id: 11, branch_id: 1, vertical_id: 2 },
  { id: 102, full_name: 'Bharat Kumar', phone: '+919000000002', email: null, lead_id: 12, branch_id: 1, vertical_id: 2 },
  { id: 103, full_name: 'Chitra Nair', phone: null, email: null, lead_id: 13, branch_id: 1, vertical_id: 2 },
];

/** A capturing world: the batch lookup (null => out of scope), the roster, and the notifier. */
function make(opts: { batchRow?: any; queue?: (m: any) => Promise<any> } = {}) {
  const queued: any[] = [];
  const messaging = {
    queue: async (m: any) => {
      if (opts.queue) return opts.queue(m);         // custom (throw / skipped) — does NOT record a send
      queued.push(m);
      return { id: queued.length, status: 'queued' };
    },
  } as any;
  const db = {
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM batch bt/.test(sql)) return opts.batchRow === undefined ? { id: 5, name: 'ZZTEST Batch', branch_id: 1, vertical_id: 2 } : opts.batchRow;
      return null;
    },
    query: async (sql: string) => {
      if (/FROM student s/.test(sql)) return ROSTER;
      return [];
    },
    tx: async (fn: any) => fn({ query: async () => ({ rows: [] }) }),
  } as any;
  const svc = new BatchService(db, resolver, messaging);
  return { svc, queued };
}

const me = { id: 9, name: 'Admin' };

describe('BatchService.messageStudents', () => {
  it('BULK: omitting student_ids messages the whole batch roster (reachable ones)', async () => {
    const { svc, queued } = make();
    const r = await svc.messageStudents(5, { message: 'Class shifts to 6pm' }, me, scopeAll);
    // Asha (wa) + Bharat (wa) send; Chitra has no phone/email -> skipped no_contact.
    expect(r.sent).toBe(2);
    expect(r.skipped).toBe(1);
    expect(queued).toHaveLength(2);
    expect(r.recipients.find((x) => x.student_id === 103)?.reason).toBe('no_contact');
  });

  it('INDIVIDUAL: student_ids restricts the send to just those students', async () => {
    const { svc, queued } = make();
    const r = await svc.messageStudents(5, { message: 'Hi', student_ids: [101] }, me, scopeAll);
    expect(r.sent).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0].to).toBe('+919000000001');
  });

  it('a student NOT in the batch is skipped with reason not_in_batch', async () => {
    const { svc } = make();
    const r = await svc.messageStudents(5, { message: 'Hi', student_ids: [999] }, me, scopeAll);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.recipients[0].reason).toBe('not_in_batch');
  });

  it('email channel targets email + merges {name}; a student without email is skipped', async () => {
    const { svc, queued } = make();
    const r = await svc.messageStudents(5, { message: 'Hello {name}', channel: 'email' }, me, scopeAll);
    expect(r.sent).toBe(1);                       // only Asha has an email
    expect(queued[0].channel).toBe('email');
    expect(queued[0].to).toBe('asha@example.com');
    expect(queued[0].body).toContain('Asha Rao'); // merge variable resolved
    expect(r.recipients.find((x) => x.student_id === 102)?.reason).toBe('no_contact');
  });

  it('degrades cleanly: a queue that throws (unconfigured) is logged, not thrown', async () => {
    const { svc } = make({ queue: async () => { throw new Error('channel not configured'); } });
    const r = await svc.messageStudents(5, { message: 'Hi', student_ids: [101] }, me, scopeAll);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.recipients[0].status).toBe('skipped');
    expect(r.recipients[0].reason).toMatch(/not configured/);
  });

  it('an opt-out (queue returns skipped) counts as skipped, not sent', async () => {
    const { svc } = make({ queue: async () => ({ id: 1, status: 'skipped', reason: 'Opted out of whatsapp — not sent' }) });
    const r = await svc.messageStudents(5, { message: 'Hi', student_ids: [101] }, me, scopeAll);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.recipients[0].status).toBe('skipped');
  });

  it('empty message is rejected (400)', async () => {
    const { svc } = make();
    await expect(svc.messageStudents(5, { message: '  ' }, me, scopeAll)).rejects.toThrow(BadRequestException);
  });

  it('scope is enforced: a batch outside the caller\'s scope is 404', async () => {
    const { svc } = make({ batchRow: null });
    await expect(svc.messageStudents(5, { message: 'Hi' }, me, scopeNone)).rejects.toThrow(NotFoundException);
  });
});

describe('POST /batches/:id/message route metadata', () => {
  it('is a POST on :id/message gated by batch.update', () => {
    const proto = BatchController.prototype as any;
    expect(Reflect.getMetadata(PATH_METADATA, proto.message)).toBe(':id/message');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.message)).toBe(1); // RequestMethod.POST
    expect(Reflect.getMetadata(PERMISSION_KEY, proto.message)).toBe('batch.update');
  });
  it('exposes GET :id/students gated by batch.read', () => {
    const proto = BatchController.prototype as any;
    expect(Reflect.getMetadata(PATH_METADATA, proto.students)).toBe(':id/students');
    expect(Reflect.getMetadata(PERMISSION_KEY, proto.students)).toBe('batch.read');
  });
});
