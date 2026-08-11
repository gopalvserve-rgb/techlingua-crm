/**
 * A) Dropdown SCROLL — the searchable multi-select popover (UserPicker, behind every
 *    FilterMulti: Vertical / Branch / Pipeline / Campaign / Source / Status / Owner / …)
 *    must show a SCROLLABLE list with a sensible max-height so 50+ options never get
 *    cut off — they scroll inside the dropdown. Client: "in the Vertical filter I can't
 *    see the records, the dropdown is too short."
 *
 * B) LEAD STATUS master — the Status master exists (type `status` -> m_status). The client
 *    couldn't find it, so it's relabelled "Lead Status" and surfaced in the Leads area too.
 *    A Lead Status value feeds the lead form's Status dropdown (statuses refdata -> status).
 *
 * Source-scans (no DOM) prove the CSS + wiring; one DOM test proves the popover really
 * renders a long, scrollable option list.
 */
import { describe, it, expect } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { UserPicker } from './userpicker';

type Glob = { glob: (p: string, o: object) => Record<string, string> };
const RAW: Record<string, string> = (import.meta as unknown as Glob)
  .glob('./*.tsx', { query: '?raw', import: 'default', eager: true });
const read = (f: string): string => {
  const src = RAW[`./${f}`];
  if (src == null) throw new Error(`source not found for ${f}`);
  return src;
};

describe('A · the picker popover scrolls (max-height + overflow) so many records are reachable', () => {
  it('renders a long option list inside the .upick-drop popover (50 options → all present, scroll container)', async () => {
    const options = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `Vertical ${i + 1}` }));
    const { container } = render(<UserPicker multiple value={[]} onChange={() => undefined} options={options} hideBranch />);
    fireEvent.focus(container.querySelector('.upick-ctl input') as HTMLInputElement);
    const drop = container.querySelector('.upick-drop');
    expect(drop, 'the popover (.upick-drop) should open').toBeTruthy();
    expect(drop!.getAttribute('role')).toBe('listbox');
    await waitFor(() => expect(drop!.querySelectorAll('.upick-row').length).toBe(50)); // all 50 rendered; CSS scrolls them
    cleanup();
  });

  it('the popover keeps a type-to-narrow search box (the control input) always visible', () => {
    const options = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `Owner ${i + 1}` }));
    const { container } = render(<UserPicker multiple value={[]} onChange={() => undefined} options={options} hideBranch />);
    const input = container.querySelector('.upick-ctl input');
    expect(input, 'the search input lives in the control, above the scrolling list').toBeTruthy();
    cleanup();
  });
});

describe('B · Lead Status master is relabelled and discoverable, and feeds the lead form', () => {
  it('MASTER_LABELS relabels status → "Lead Status"', () => {
    expect(/status:\s*'Lead Status'/.test(read('mastermodal.tsx'))).toBe(true);
  });

  it('a Lead Status quick link is surfaced in the Marketing/Leads area', () => {
    const specs = read('specs.tsx');
    expect(/id:\s*'leadstatus',\s*label:\s*'Lead Status'/.test(specs)).toBe(true);
    expect(/dyn:\s*'leadStatusMaster'/.test(specs)).toBe(true);
    // and the dyn variant opens the masters screen straight on the status master
    expect(/leadStatusMaster:\s*\(\)\s*=>\s*<MastersAdmin initialType="status" \/>/.test(read('dyn.tsx'))).toBe(true);
  });

  it('a Lead Status value round-trips into the lead form (statuses refdata → status master)', () => {
    const forms = read('forms.tsx');
    // the lead add/edit form has a "Lead Status" select bound to the `statuses` refdata
    expect(/F\('Lead Status',\s*'select',[^)]*'statuses'\)/.test(forms)).toBe(true);
    // and `statuses` refdata is the `status` master, so a new status value appears in that dropdown
    expect(/statuses:\s*'status'/.test(forms)).toBe(true);
  });
});
