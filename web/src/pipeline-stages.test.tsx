/**
 * UAT-R2 #9 — the Pipeline "Add row" stage editor.
 *
 * The old `table` field rendered a dead "+ Add row" label with no click handler and no
 * state, so clicking it did nothing and no stage was ever collected — the bug the client
 * hit. This test drives the REAL editor: Add row appends an editable stage, reorder and
 * delete change the payload, the Add saver POSTs the stages, and the Edit reconcile
 * creates / patches / deletes / reorders against the live pipeline.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { AddModal, SAVERS, parseStageRows, reconcilePipelineStages, StageRow } from './forms';

vi.mock('./auth', () => ({
  useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }),
}));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [], campaigns: [], sources: [], masterSources: [], courses: [],
  statuses: [], followupTypes: [], dispositions: [], budgets: [],
  trainings: [], visitPurposes: [], walkinStatuses: [],
  users: [{ id: 3, name: 'Asha Rao', status: 'active' }],
  states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

let postId = 900;
const post = vi.fn(async (..._a: unknown[]) => ({ id: ++postId, name: 'x' }));
const patch = vi.fn(async (..._a: unknown[]) => ({ id: 1 }));
const del = vi.fn(async (..._a: unknown[]) => ({ deleted: true }));
const put = vi.fn(async (..._a: unknown[]) => ([] as unknown[]));
vi.mock('./api', () => ({
  ApiError: class extends Error { status = 409; },
  api: {
    get: async () => [],
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    del: (...a: unknown[]) => del(...a),
    put: (...a: unknown[]) => put(...a),
  },
}));

const flush = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const fldByLabel = (label: string): HTMLElement => {
  const el = [...document.querySelectorAll('.add-modal .fld')].find(
    (f) => (f.querySelector('label')?.textContent ?? '').replace(/\*/g, '').trim().startsWith(label),
  );
  if (!el) throw new Error(`field "${label}" not found`);
  return el as HTMLElement;
};
const setText = (label: string, v: string) =>
  fireEvent.change(fldByLabel(label).querySelector('input, textarea') as HTMLElement, { target: { value: v } });
const setSelect = (label: string, v: string) =>
  fireEvent.change(fldByLabel(label).querySelector('select') as HTMLElement, { target: { value: v } });
const stageEditor = () => document.querySelector('[data-stage-editor]') as HTMLElement;
const stageInputs = () => [...stageEditor().querySelectorAll('.sc-row input[type=text], .sc-row input:not([type])')] as HTMLInputElement[];
const clickAddRow = () => fireEvent.click(stageEditor().querySelector('.sc-addrow') as HTMLElement);
const submit = async () => {
  const btn = (document.querySelector('.add-modal .af .btn.primary')
    ?? document.querySelector('.add-modal .btn.primary')) as HTMLButtonElement;
  fireEvent.click(btn);
  await flush(); await flush(5);
};

const fillRequired = () => {
  setText('Pipeline Name', 'QA Pipeline C');
  setSelect('Branch', '9');
  setSelect('Vertical', '1');
  setText('Pipeline Code', 'QAC');
};

beforeEach(() => { post.mockClear(); patch.mockClear(); del.mockClear(); put.mockClear(); postId = 900; cleanup(); });

describe('parseStageRows', () => {
  it('parses valid rows, drops junk, defaults stage_type to open', () => {
    expect(parseStageRows(JSON.stringify([{ name: 'A' }, { id: 5, name: 'B', stage_type: 'won', is_default: true }, { x: 1 }])))
      .toEqual([
        { id: undefined, name: 'A', stage_type: 'open', is_default: false, is_active: true },
        { id: 5, name: 'B', stage_type: 'won', is_default: true, is_active: true },
      ]);
    expect(parseStageRows('')).toEqual([]);
    expect(parseStageRows('not json')).toEqual([]);
  });
});

describe('Add Pipeline — Add row builds and persists stages', () => {
  it('the "Add row" button is a real control that appends an editable stage row', async () => {
    render(<AddModal formKey="leads.pipelinemaster" onClose={() => undefined} />);
    await flush();
    expect(stageInputs()).toHaveLength(0);            // starts empty
    clickAddRow(); await flush();
    expect(stageInputs()).toHaveLength(1);            // <-- the OLD dead label added nothing
    clickAddRow(); clickAddRow(); await flush();
    expect(stageInputs()).toHaveLength(3);
  });

  it('creates a pipeline with exactly the 3 stages added via Add row, in order, one default', async () => {
    render(<AddModal formKey="leads.pipelinemaster" onClose={() => undefined} />);
    await flush();
    fillRequired();
    clickAddRow(); clickAddRow(); clickAddRow(); await flush();
    const names = ['Enquiry', 'Counselling', 'Enrolled'];
    stageInputs().forEach((inp, i) => fireEvent.change(inp, { target: { value: names[i] } }));
    await flush();
    await submit();
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0] as unknown as [string, any];
    expect(path).toBe('/pipelines');
    expect(body.stages.map((s: any) => s.name)).toEqual(names);
    expect(body.stages.filter((s: any) => s.is_default)).toHaveLength(1);
    expect(body.stages[0].is_default).toBe(true);     // first row is default by default
  });

  it('reorder (move down) changes the persisted stage order', async () => {
    render(<AddModal formKey="leads.pipelinemaster" onClose={() => undefined} />);
    await flush(); fillRequired();
    clickAddRow(); clickAddRow(); await flush();
    const names = ['First', 'Second'];
    stageInputs().forEach((inp, i) => fireEvent.change(inp, { target: { value: names[i] } }));
    await flush();
    // move the first row DOWN
    fireEvent.click(stageEditor().querySelector('.sc-row .sc-row-btn[title="Move down"]') as HTMLElement);
    await flush();
    await submit();
    const body = (post.mock.calls[0] as unknown as [string, any])[1];
    expect(body.stages.map((s: any) => s.name)).toEqual(['Second', 'First']);
  });

  it('deleting a row drops it from the payload and keeps a default', async () => {
    render(<AddModal formKey="leads.pipelinemaster" onClose={() => undefined} />);
    await flush(); fillRequired();
    clickAddRow(); clickAddRow(); await flush();
    ['Keep', 'Drop'].forEach((n, i) => fireEvent.change(stageInputs()[i], { target: { value: n } }));
    await flush();
    // remove the FIRST row (the default) — the survivor must inherit default
    fireEvent.click(stageEditor().querySelector('.sc-row .sc-row-btn.danger') as HTMLElement);
    await flush();
    await submit();
    const body = (post.mock.calls[0] as unknown as [string, any])[1];
    expect(body.stages.map((s: any) => s.name)).toEqual(['Drop']);
    expect(body.stages[0].is_default).toBe(true);
  });

  it('an empty editor omits stages so the backend seeds its default set', async () => {
    render(<AddModal formKey="leads.pipelinemaster" onClose={() => undefined} />);
    await flush(); fillRequired();
    await submit();
    const body = (post.mock.calls[0] as unknown as [string, any])[1];
    expect(body.stages).toBeUndefined();
  });
});

describe('Edit Pipeline — stages prefill and reconcile', () => {
  it('the editor prefills the live stages so they are present and editable on reopen', async () => {
    const existing = [
      { id: 11, name: 'New Lead', stage_type: 'open', is_default: true, is_active: true },
      { id: 12, name: 'Contacted', stage_type: 'open', is_default: false, is_active: true },
      { id: 13, name: 'Enrolled', stage_type: 'won', is_default: false, is_active: true },
    ];
    render(<AddModal formKey="leads.pipelinemaster" onClose={() => undefined}
      edit={{
        title: 'Edit Pipeline', lock: ['Branch', 'Vertical'],
        initialVals: { 'Pipeline Name': 'P', 'Pipeline Code': 'P', 'Pipeline Stages': JSON.stringify(existing), 'Status': 'Active' },
        submit: async () => 'ok',
      }} />);
    await flush();
    const inputs = stageInputs();
    expect(inputs.map((i) => i.value)).toEqual(['New Lead', 'Contacted', 'Enrolled']);
    // editable: rename the middle stage
    fireEvent.change(inputs[1], { target: { value: 'Counselling' } });
    await flush();
    expect(stageInputs()[1].value).toBe('Counselling');
  });

  it('reconcilePipelineStages: creates new, patches changed, deletes removed, reorders', async () => {
    const original: StageRow[] = [
      { id: 11, name: 'New Lead', stage_type: 'open', is_default: true, is_active: true },
      { id: 12, name: 'Contacted', stage_type: 'open', is_default: false, is_active: true },
      { id: 13, name: 'Old', stage_type: 'open', is_default: false, is_active: true },
    ];
    const final: StageRow[] = [
      { id: 12, name: 'Contacted', stage_type: 'open', is_default: false, is_active: true },
      { id: 11, name: 'New Lead', stage_type: 'open', is_default: true, is_active: true },
      { name: 'Demo', stage_type: 'open', is_default: false, is_active: true },   // brand new
    ];
    const msg = await reconcilePipelineStages(7, original, final);
    // new row POSTed
    expect(post).toHaveBeenCalledWith('/pipelines/7/stages', expect.objectContaining({ name: 'Demo' }));
    // removed row (id 13) DELETEd
    expect(del).toHaveBeenCalledWith('/stages/13');
    // reorder sent with the final id sequence (new row's id came from post => 901)
    expect(put).toHaveBeenCalledWith('/pipelines/7/stages/order', { order: [12, 11, 901] });
    expect(msg).toContain('3 stages');
  });

  it('reconcile surfaces a blocked (409) delete and keeps that stage in the order', async () => {
    del.mockRejectedValueOnce(new Error('Cannot delete stage "Old" — 2 lead(s) are in it.'));
    const original: StageRow[] = [
      { id: 11, name: 'A', stage_type: 'open', is_default: true, is_active: true },
      { id: 13, name: 'Old', stage_type: 'open', is_default: false, is_active: true },
    ];
    const final: StageRow[] = [{ id: 11, name: 'A', stage_type: 'open', is_default: true, is_active: true }];
    await expect(reconcilePipelineStages(7, original, final)).rejects.toThrow(/Cannot delete/);
    // blocked stage retained at the tail of the order so the permutation stays valid
    expect(put).toHaveBeenCalledWith('/pipelines/7/stages/order', { order: [11, 13] });
  });
});
