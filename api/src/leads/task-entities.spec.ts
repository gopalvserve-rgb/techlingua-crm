import { BadRequestException } from '@nestjs/common';
import {
  TASK_ENTITY_TYPES, assertEntityType, ENTITY_SOURCES, entityLabelCaseSql,
  assertTaskStatus, deriveTaskStatus, taskCardSql, TASK_CARDS, USER_SET_TASK_STATUSES,
} from './task-entities';

describe('MY TASK — Related-To entity types (dev/133)', () => {
  it('has exactly the 13 client entity types', () => {
    expect(TASK_ENTITY_TYPES).toHaveLength(13);
    expect([...TASK_ENTITY_TYPES]).toEqual([
      'lead', 'student', 'admission', 'enrollment', 'course', 'batch', 'payment',
      'invoice', 'followup', 'employer', 'placement', 'trainer', 'staff',
    ]);
  });
  it('every type has a source (table/label/search/where)', () => {
    for (const t of TASK_ENTITY_TYPES) {
      const s = ENTITY_SOURCES[t];
      expect(s.from && s.label && s.search && s.where).toBeTruthy();
    }
  });
  it('assertEntityType accepts each valid type and rejects junk', () => {
    for (const t of TASK_ENTITY_TYPES) expect(assertEntityType(t)).toBe(t);
    expect(assertEntityType(undefined)).toBeUndefined();
    expect(assertEntityType('')).toBeUndefined();
    expect(() => assertEntityType('teacher')).toThrow(BadRequestException);
  });
  it('entityLabelCaseSql references every type + the id column', () => {
    const sql = entityLabelCaseSql('f.entity_type', 'f.entity_id');
    for (const t of TASK_ENTITY_TYPES) expect(sql).toContain(`WHEN '${t}'`);
    expect(sql).toContain('f.entity_id');
  });
});

describe('MY TASK — Task Status (dev/133)', () => {
  it('accepts the three user-set statuses, rejects overdue (derived) + junk', () => {
    for (const s of USER_SET_TASK_STATUSES) expect(assertTaskStatus(s)).toBe(s);
    expect(() => assertTaskStatus('overdue')).toThrow(BadRequestException);
    expect(() => assertTaskStatus('done')).toThrow(BadRequestException);
  });

  const NOW = new Date('2026-08-24T10:00:00Z');
  it('derives completed from task_status or legacy done', () => {
    expect(deriveTaskStatus({ task_status: 'completed' }, NOW)).toBe('completed');
    expect(deriveTaskStatus({ status: 'done', task_status: 'in_progress' }, NOW)).toBe('completed');
  });
  it('derives overdue for a pending task past its due day', () => {
    expect(deriveTaskStatus({ task_status: 'in_progress', status: 'pending', scheduled_at: '2026-08-20T10:00:00Z' }, NOW)).toBe('overdue');
  });
  it('keeps the user-set status when not past due / not completed', () => {
    expect(deriveTaskStatus({ task_status: 'on_hold', status: 'pending', scheduled_at: '2026-08-30T10:00:00Z' }, NOW)).toBe('on_hold');
    expect(deriveTaskStatus({ task_status: 'in_progress', status: 'pending', scheduled_at: '2026-08-24T23:00:00Z' }, NOW)).toBe('in_progress');
  });
});

describe('MY TASK — the 6 cards (dev/133)', () => {
  it('exposes the 6 client cards', () => {
    expect([...TASK_CARDS]).toEqual(['open', 'due_today', 'overdue', 'in_progress', 'completed', 'next7']);
  });
  it('every card yields a SQL predicate; unknown returns null', () => {
    for (const c of TASK_CARDS) expect(typeof taskCardSql(c)).toBe('string');
    expect(taskCardSql('bogus')).toBeNull();
  });
  it('open excludes completed; completed folds legacy done; next7 uses a 7-day window', () => {
    expect(taskCardSql('open')).toContain("f.task_status <> 'completed'");
    expect(taskCardSql('completed')).toContain("f.status = 'done'");
    expect(taskCardSql('next7')).toContain('+ 7');
    expect(taskCardSql('overdue')).toContain('<');
  });
});
