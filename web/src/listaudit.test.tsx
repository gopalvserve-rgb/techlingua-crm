/**
 * LIST-AUDIT — the automated equivalent of "check every module for the full list treatment".
 *
 * WHY THIS EXISTS. Multi-select filters were added to Leads but silently NOT to Campaigns and
 * other module lists, despite the standing rule "full list treatment on EVERY list". This test
 * makes that omission a BUILD FAILURE: every registered list screen must render a multi-select
 * filter control (FilterMulti / EnumMulti / a shared ScopeFilters / useBatches picker) plus, where
 * applicable, Export, a Column chooser, Refresh and a Bulk action bar. Add a new list → add it
 * here; drop multi-select from a list → this test goes red.
 *
 * It scans the component's SOURCE (brace-matched slice) for the wiring tokens, so it needs no DOM,
 * no providers and no network mocks — it can never silently pass because a mock hid a missing
 * control.
 */
import { describe, it, expect } from 'vitest';

// Load every module source as a raw string via Vite (no node:fs — keeps the production
// `tsc --noEmit` build green, since it typechecks test files too).
const RAW = (import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> }).glob('./*.tsx', { query: '?raw', import: 'default', eager: true });
// The five controls and the source tokens that prove each is wired.
const TOKENS = {
  multiFilter: /FilterMulti|EnumMulti|ScopeFilters|useBatches/,
  export: /onExport|list-export/,
  refresh: /onRefresh|list-refresh/,
  colChooser: /listKey=|\bfill\b/,       // TableCard column chooser: explicit listKey, or fill+title
  bulkDelete: /useBulkDelete|BulkBar/,
} as const;
type Ctrl = keyof typeof TOKENS;
const ALL: Ctrl[] = ['multiFilter', 'export', 'refresh', 'colChooser', 'bulkDelete'];

/** Brace-match a top-level `function Name(...) { ... }` so nested arrows don't truncate the slice. */
function sliceComponent(src: string, name: string): string | null {
  const m = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index + m[0].length);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { if (--depth === 0) return src.slice(m.index, j + 1); }
  }
  return src.slice(m.index);
}

const read = (f: string): string => {
  const src = RAW[`./${f}`];
  if (src == null) throw new Error(`source not found for ${f}`);
  return src;
};

// Capability profiles — the controls each list is EXPECTED to render. A list where a control is
// genuinely N/A (a top-level list with no parent to filter by; a derived/log list you cannot
// bulk-delete) declares a reduced profile, documented per entry — never a silent omission.
const FULL: Ctrl[] = ALL;
const NO_BULK: Ctrl[] = ['multiFilter', 'export', 'refresh', 'colChooser'];  // batch-scoped / derived-from-students
const NO_MULTIFILTER: Ctrl[] = ['export', 'refresh', 'colChooser', 'bulkDelete']; // top-level (search+status only)
const DERIVED: Ctrl[] = ['multiFilter', 'export', 'refresh'];  // computed suggestions / attempt log
const LOG: Ctrl[] = ['export', 'refresh', 'colChooser'];       // audit / error / follow-up feed

// EVERY registered list screen in the app (CRM + ERP). Keep this exhaustive.
const LISTS: Array<{ name: string; file: string; req: Ctrl[] }> = [
  // ---- CRM hierarchy + core ----
  { name: 'LeadsAll', file: 'dyn.tsx', req: NO_BULK },       // Leads has its own bulk action bar (transfer/reassign/pause)
  { name: 'Campaigns', file: 'dyn.tsx', req: FULL },         // client's explicit example
  { name: 'Verticals', file: 'dyn.tsx', req: FULL },
  { name: 'Pipelines', file: 'dyn.tsx', req: FULL },
  { name: 'Sources', file: 'dyn.tsx', req: FULL },
  { name: 'Courses', file: 'dyn.tsx', req: FULL },
  { name: 'Users', file: 'dyn.tsx', req: FULL },
  { name: 'Branches', file: 'dyn.tsx', req: NO_MULTIFILTER },
  { name: 'StudentsList', file: 'dyn.tsx', req: FULL },
  { name: 'BatchesList', file: 'dyn.tsx', req: NO_BULK },
  { name: 'Followups', file: 'dyn.tsx', req: LOG },
  { name: 'Audit', file: 'dyn.tsx', req: LOG },
  { name: 'ErrorLogs', file: 'dyn.tsx', req: LOG },
  // ---- Finance · GST Invoices (Phase 3) ----
  { name: 'InvoicesScreen', file: 'invoices.tsx', req: FULL },
  // ---- Finance · Payment Plans + Fee Dues (Phase 3 Batch 2) ----
  { name: 'PaymentPlansScreen', file: 'paymentplans.tsx', req: FULL },
  // FeeDues is a DERIVED, read-only ageing VIEW — a "due" is cleared by collecting the
  // payment, never deleted — so it carries every control EXCEPT bulk-delete (declared).
  { name: 'FeeDuesScreen', file: 'paymentplans.tsx', req: NO_BULK },
  // ---- ERP · Operations ----
  { name: 'CatalogScreen', file: 'operations.tsx', req: FULL },
  { name: 'VendorsScreen', file: 'operations.tsx', req: FULL },
  { name: 'InventoryScreen', file: 'operations.tsx', req: FULL },
  { name: 'AssetsScreen', file: 'operations.tsx', req: FULL },
  { name: 'ProcurementScreen', file: 'operations.tsx', req: FULL },
  // ---- ERP · HR ----
  { name: 'EmployeeDirectoryScreen', file: 'hr.tsx', req: FULL },
  { name: 'StaffAttendanceScreen', file: 'hr.tsx', req: FULL },
  { name: 'LeavesScreen', file: 'hr.tsx', req: FULL },
  // ---- ERP · Learning ----
  { name: 'StudyMaterialScreen', file: 'learning.tsx', req: FULL },
  { name: 'CertificatesScreen', file: 'learning.tsx', req: FULL },
  { name: 'ReportCardsScreen', file: 'learning.tsx', req: FULL },
  // ---- ERP · Admissions ----
  { name: 'AdmissionsScreen', file: 'admissions.tsx', req: FULL },
  // ---- ERP · Academics (batch-scoped views) ----
  { name: 'AttendanceScreen', file: 'academics.tsx', req: NO_BULK },
  { name: 'TestsScreen', file: 'academics.tsx', req: NO_BULK },
  { name: 'AssignmentsScreen', file: 'academics.tsx', req: NO_BULK },
  // ---- ERP · AI + Support ----
  { name: 'AiIntelligence', file: 'ai.tsx', req: FULL },
  { name: 'SupportTickets', file: 'support.tsx', req: NO_BULK },
  { name: 'TrainingVideosScreen', file: 'supportextras.tsx', req: FULL },
  { name: 'ReleaseNotesScreen', file: 'supportextras.tsx', req: FULL },
  { name: 'AttemptsTab', file: 'crosssell.tsx', req: DERIVED },
  { name: 'CrossSell', file: 'crosssell.tsx', req: DERIVED },
];

describe('list-audit — every registered list screen renders the full treatment', () => {
  it('audits a meaningful number of lists', () => {
    expect(LISTS.length).toBeGreaterThanOrEqual(30);
  });

  for (const { name, file, req } of LISTS) {
    it(`${file} · ${name} renders: ${req.join(', ')}`, () => {
      const slice = sliceComponent(read(file), name);
      expect(slice, `list component ${name} not found in ${file}`).toBeTruthy();
      for (const ctrl of req) {
        expect(
          TOKENS[ctrl].test(slice as string),
          `${name} (${file}) is MISSING its "${ctrl}" control — every list must carry the full treatment`,
        ).toBe(true);
      }
    });
  }

  // The client's explicit complaint: Campaigns (and the other hierarchy lists) MUST be multi-select.
  it('the hierarchy lists all use a multi-select filter control', () => {
    for (const name of ['Campaigns', 'Verticals', 'Pipelines', 'Sources']) {
      const slice = sliceComponent(read('dyn.tsx'), name) as string;
      expect(/FilterMulti/.test(slice), `${name} must use FilterMulti (multi-select)`).toBe(true);
    }
  });
});
