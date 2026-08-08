/**
 * LIST TOOLS (client request, Aug 2026) — Export CSV, Refresh, Bulk Delete, and the
 * engagement-menu change (Bulk WhatsApp only). Pure logic + a modal flow with a mocked api.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { objectsToCsv, downloadMatrixCsv, BulkDeleteModal } from './listtools';
import { APP } from './specs';

vi.mock('./api', () => {
  const post = vi.fn();
  return { api: { get: vi.fn(), post, patch: vi.fn(), put: vi.fn(), del: vi.fn() } };
});
import { api } from './api';

describe('objectsToCsv — CSV of the current (already filtered) rows', () => {
  it('emits a header row + one row per object, only scalar columns', () => {
    const csv = objectsToCsv([
      { id: 1, name: 'Alpha', owner: 'Ravi', tags: ['x'] },
      { id: 2, name: 'Beta', owner: 'Sita' },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('id,name,owner');     // `tags` (array) is skipped
    expect(lines[1]).toBe('1,Alpha,Ravi');
    expect(lines[2]).toBe('2,Beta,Sita');
  });

  it('quotes values containing commas/quotes/newlines', () => {
    const csv = objectsToCsv([{ a: 'x,y', b: 'he said "hi"' }]);
    expect(csv.split('\r\n')[1]).toBe('"x,y","he said ""hi"""');
  });
});

describe('downloadMatrixCsv triggers a browser download', () => {
  afterEach(() => vi.restoreAllMocks());
  it('creates and clicks an anchor with a .csv download', () => {
    const click = vi.fn();
    const orig = document.createElement.bind(document);
    const a: any = { click, remove: vi.fn(), set href(v: string) {}, set download(v: string) {} };
    const create = vi.spyOn(document, 'createElement').mockImplementation((tag: any) => (tag === 'a' ? a : orig(tag)));
    vi.spyOn(document.body, 'appendChild').mockImplementation((n: any) => n);
    (URL as any).createObjectURL = vi.fn(() => 'blob:x');
    (URL as any).revokeObjectURL = vi.fn();
    downloadMatrixCsv('leads.csv', ['id'], [[1]]);
    expect(create).toHaveBeenCalledWith('a');
    expect(click).toHaveBeenCalled();
  });
});

describe('Engagement menu — Bulk WhatsApp only (SMS + Email removed)', () => {
  it('keeps Bulk WhatsApp, drops Bulk SMS and Email Campaigns', () => {
    const engage = APP.find((m) => m.id === 'engage')!;
    const labels = engage.subs.map((sub) => sub.label);
    expect(labels).toContain('Bulk WhatsApp');
    expect(labels).not.toContain('Bulk SMS');
    expect(labels).not.toContain('Email Campaigns');
  });
});

describe('BulkDeleteModal — impact preview then bulk soft-delete', () => {
  beforeEach(() => { (api.post as any).mockReset(); });

  it('shows the aggregate impact, gates on the confirm checkbox, then posts the delete', async () => {
    (api.post as any)
      .mockResolvedValueOnce({ entity: 'campaign', label: 'Campaign', requested: 2, in_scope: 2, out_of_scope: 0, total_associations: 5, impact: [{ key: 'leads', label: 'Leads', count: 5 }] })
      .mockResolvedValueOnce({ deleted: 2, skipped: 0 });
    const onDone = vi.fn();
    render(<BulkDeleteModal entityLabel="Campaign" ids={[10, 11]} impactPath="/campaigns/bulk-delete/impact" deletePath="/campaigns/bulk-delete" onClose={() => {}} onDone={onDone} />);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/campaigns/bulk-delete/impact', { ids: [10, 11] }));
    await screen.findByText(/Child records affected \(5\)/);

    const del = screen.getByRole('button', { name: /Delete 2/ });
    expect((del as HTMLButtonElement).disabled).toBe(true);  // gated until confirmed
    fireEvent.click(screen.getByRole('checkbox'));
    expect((del as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(del);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/campaigns/bulk-delete', { ids: [10, 11] }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('leads use the lead_ids body key (mirrors the other /leads/bulk/* actions)', async () => {
    (api.post as any).mockResolvedValueOnce({ entity: 'lead', label: 'Lead', requested: 1, in_scope: 1, out_of_scope: 0, total_associations: 0, impact: [] });
    render(<BulkDeleteModal entityLabel="Lead" ids={[7]} idKey="lead_ids" impactPath="/leads/bulk/delete-impact" deletePath="/leads/bulk/delete" onClose={() => {}} onDone={() => {}} />);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leads/bulk/delete-impact', { lead_ids: [7] }));
  });
});
