/**
 * BUTTON AUDIT — the automated equivalent of "click every button".
 *
 * The embarrassing bug: read-only dashboards (Today's Follow-ups, Quick Stats,
 * Fee Collection, every report) were given a phantom "Add X" header button that
 * dead-ended on a "later sprint" placeholder toast. Root cause: the shell
 * auto-injected an Add onto ANY screen with a table/form block or a `dyn` view.
 *
 * This walks the SAME two functions the shell uses to render and route header
 * buttons — `headerActions()` and `resolveAdd()` — for EVERY module/sub, and
 * asserts that no rendered Add/New button can ever resolve to a placeholder,
 * and that every genuine Phase-1 (non-later-phase) Add opens a WIRED form.
 */
import { describe, it, expect } from 'vitest';
import { APP, findScreen, ScreenSpec } from './specs';
import { headerActions, resolveAdd, isWiredForm, addLike, SPEC_FORMS } from './forms';

/** A screen whose backend is explicitly a later project phase may legitimately
 *  carry a design-final (unwired) Add form; a genuine Phase-1 screen may not. */
const laterPhase = (spec: ScreenSpec): boolean =>
  spec.tag === 'p2' ||
  (!!spec.sprintNote && /Phase 2|Phase 3|Basic HR|out of scope|before go-live|being authored/i.test(spec.sprintNote));

const everyScreen: Array<{ key: string; label: string; spec: ScreenSpec }> = [];
for (const m of APP) for (const s of m.subs) everyScreen.push({ key: `${m.id}.${s.id}`, label: s.label, spec: s.spec });

describe('button audit — no screen dead-ends on a placeholder', () => {
  it('has screens to audit', () => { expect(everyScreen.length).toBeGreaterThan(120); });

  for (const { key, spec } of everyScreen) {
    const [mod, sub] = key.split('.');
    const acts = headerActions(mod, sub);
    const adds = acts.filter(([, label]) => addLike(label));

    for (const [, label] of adds) {
      it(`${key} · "${label}" opens something real (never a placeholder)`, () => {
        const t = resolveAdd(key, label);
        // The old dead-end returned no form at all -> placeholder toast. Forbidden.
        expect(t.kind, `"${label}" on ${key} resolved to a placeholder dead-end`).not.toBe('none');
        if (t.kind === 'form') {
          expect(SPEC_FORMS[t.formKey], `${key} -> missing SPEC_FORMS[${t.formKey}]`).toBeTruthy();
          // A LIVE Phase-1 screen must open a wired form (a real save), not a design-final shell.
          if (!laterPhase(spec)) {
            expect(isWiredForm(t.formKey), `${key} is Phase-1 but "${label}" opens the unwired form ${t.formKey}`).toBe(true);
          }
        }
      });
    }
  }
});

describe('button audit — the client-reported read-only screens have NO Add', () => {
  const readOnly = [
    'dash.todayfollowups', 'dash.quickstats', 'dash.calendar', 'dash.aiinsights',
    'finance.collection', 'perf.quotes', 'perf.closure', 'perf.targets', 'perf.counsellor',
    'analytics.standard', 'analytics.builder', 'analytics.tat', 'analytics.funnel', 'analytics.activity',
    'admin.audit', 'admin.settings', 'admin.integrations', 'admin.api', 'admin.errorlogs', 'admin.deleted',
    'leads.scoring', 'leads.sla', 'engage.templates', 'engage.journeys', 'work.notes', 'work.kb', 'work.announce',
  ];
  for (const key of readOnly) {
    it(`${key} shows no add-like header button`, () => {
      const scr = findScreen(key.split('.')[0], key.split('.')[1]);
      expect(scr, `${key} not found`).toBeTruthy();
      const acts = headerActions(key.split('.')[0], key.split('.')[1]);
      expect(acts.filter(([, l]) => addLike(l)), `${key} still has a phantom Add`).toHaveLength(0);
    });
  }
  it('Quick Stats and Today\'s Follow-ups have NO header buttons at all', () => {
    expect(headerActions('dash', 'quickstats')).toHaveLength(0);
    expect(headerActions('dash', 'todayfollowups')).toHaveLength(0);
  });
});

describe('button audit — the wired list screens KEEP a working Add', () => {
  const wired: Array<[string, string]> = [
    ['leads.all', 'leads.all'], ['leads.pipeline', 'leads.pipeline'], ['leads.followups', 'leads.followups'],
    ['leads.vertical', 'leads.vertical'], ['leads.pipelinemaster', 'leads.pipelinemaster'], ['leads.sources', 'leads.sources'],
    ['dash.overview', 'leads.all'], ['dash.mytasks', 'dash.mytasks'], ['dash.walkins', 'dash.walkins'], ['dash.referrals', 'dash.referrals'],
    ['admin.branches', 'admin.branches'], ['admin.verticalmgmt', 'admin.verticalmgmt'], ['admin.pipelines', 'admin.pipelines'],
    ['admin.users', 'admin.users'], ['admin.courseconfig', 'admin.courseconfig'], ['students.courses', 'students.courses'],
    ['work.tasks', 'dash.mytasks'],
  ];
  for (const [key, expectForm] of wired) {
    it(`${key} still opens the wired ${expectForm} form`, () => {
      const acts = headerActions(key.split('.')[0], key.split('.')[1]);
      const add = acts.find(([, l]) => addLike(l));
      expect(add, `${key} lost its Add button`).toBeTruthy();
      const t = resolveAdd(key, add![1]);
      expect(t.kind).toBe('form');
      if (t.kind === 'form') {
        expect(t.formKey).toBe(expectForm);
        expect(isWiredForm(t.formKey)).toBe(true);
      }
    });
  }
  it('campaign and roles Add open their dedicated modals', () => {
    expect(resolveAdd('leads.campaigns', 'New campaign').kind).toBe('campaign');
    expect(resolveAdd('admin.roles', 'New role').kind).toBe('roles');
  });
});
