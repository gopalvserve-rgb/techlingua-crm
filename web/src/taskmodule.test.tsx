/**
 * MY TASK overhaul (dev/133) — unit coverage for the client "My task" docx items:
 *  - Related-To type list (13) + display↔key maps
 *  - Task Status label map (incl derived Overdue)
 *  - timeline label = "Task" for a task, "Follow-up" for a follow-up (BUG FIX #8)
 */
import { describe, expect, it } from 'vitest';
import { TASK_ENTITY_OPTS, TASK_ENTITY_KEY, TASK_STATUS_KEY, TASK_STATUS_LABEL } from './forms';
import { activityTitle } from './leadsheet';

describe('MY TASK — Related-To types (dev/133)', () => {
  it('offers the 13 client entity types', () => {
    expect(TASK_ENTITY_OPTS).toHaveLength(13);
    expect(TASK_ENTITY_OPTS).toEqual([
      'Lead', 'Student', 'Admission', 'Enrollment', 'Course', 'Batch', 'Payment',
      'Invoice', 'Follow-up', 'Employer', 'Placement', 'Trainer', 'Staff',
    ]);
  });
  it('maps each display label to a backend key (Follow-up → followup)', () => {
    for (const lbl of TASK_ENTITY_OPTS) expect(TASK_ENTITY_KEY[lbl]).toBeTruthy();
    expect(TASK_ENTITY_KEY['Follow-up']).toBe('followup');
    expect(TASK_ENTITY_KEY['Lead']).toBe('lead');
  });
});

describe('MY TASK — Task Status labels (dev/133)', () => {
  it('round-trips the three user-set statuses and shows derived Overdue', () => {
    expect(TASK_STATUS_KEY['In Progress']).toBe('in_progress');
    expect(TASK_STATUS_KEY['On Hold']).toBe('on_hold');
    expect(TASK_STATUS_KEY['Completed']).toBe('completed');
    expect(TASK_STATUS_LABEL['overdue']).toBe('Overdue');
    expect(TASK_STATUS_LABEL['in_progress']).toBe('In Progress');
  });
});

describe('MY TASK — timeline label reflects the real type (BUG FIX #8)', () => {
  const base = { id: 1, type: 'follow_up', from_value: null, note: null, occurred_at: '', actor_name: null };
  it('labels a TASK activity as "Task", not "Follow-up"', () => {
    expect(activityTitle({ ...base, to_value: { action: 'scheduled', kind: 'task', scheduled_at: '2026-08-24T10:00:00Z' } } as any).tt)
      .toMatch(/^Task scheduled/);
    expect(activityTitle({ ...base, to_value: { action: 'completed', kind: 'task' } } as any).tt).toBe('Task completed');
    expect(activityTitle({ ...base, to_value: { action: 'updated', kind: 'task' } } as any).tt).toBe('Task updated');
  });
  it('still labels a genuine follow-up as "Follow-up"', () => {
    expect(activityTitle({ ...base, to_value: { action: 'completed', kind: 'follow_up' } } as any).tt).toBe('Follow-up completed');
    // legacy activities without a kind marker default to Follow-up
    expect(activityTitle({ ...base, to_value: { action: 'updated' } } as any).tt).toBe('Follow-up updated');
  });
});
