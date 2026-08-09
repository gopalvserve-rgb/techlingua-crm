import { LeadsService } from './leads.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';

/**
 * EXPORT shows VALUES, not IDs (client, Aug 2026). GET /leads/export must emit the human-readable
 * names/labels the user sees (owner NAME, branch/vertical/…/source NAME, status/stage NAME, course
 * NAME, temperature label, Yes/No, formatted dates) and expand custom fields by their label —
 * never a bare foreign-key id.
 */
const ALL: ResolvedScope = {
  permissionKey: 'lead.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [],
};

const LEAD_ROW = {
  id: '101', full_name: 'Ravi Kumar', phone: '+919000000009', alt_phone: null, whatsapp_phone: null,
  email: 'ravi@example.com', temperature: 'cold', priority: 'high', score: 42,
  branch_id: '10', vertical_id: '3', pipeline_id: '2', campaign_id: '2', source_id: '62',
  stage_id: '7', status_id: '1', owner_id: '12', course_id: null, city_id: '4',
  branch_name: 'Janakpuri', vertical_name: 'BCL', pipeline_name: 'BCL', campaign_name: 'Just Dial',
  source_name: 'Transferred in', stage_name: 'New Lead', status_name: 'New', owner_name: 'PRIYANKA',
  course_name: null, city_name: 'New Delhi', is_duplicate: false, is_red_flagged: true, paused: false,
  next_follow_up_at: '2026-08-10T09:30:00.000Z', last_activity_at: null,
  created_at: '2026-08-01T05:00:00.000Z', updated_at: '2026-08-02T05:00:00.000Z',
  custom_fields: { referred_by: 'Neha' },
};

function build() {
  const db = {
    query: async (sql: string) => {
      if (/FROM custom_field_def/.test(sql)) return [{ field_key: 'referred_by', label: 'Referred By', data_type: 'text' }];
      if (/FROM lead l\s+JOIN branch/.test(sql)) return [LEAD_ROW];
      return [];
    },
    one: async () => ({}),
  } as unknown as DatabaseService;
  const svc = new LeadsService(db, new ScopeResolverService(), { assertRefInScope: async () => undefined } as any,
    {} as any, { safeRescore: async () => undefined } as any, { safe: async () => undefined } as any);
  return svc;
}

describe('exportRows — names not ids', () => {
  it('projects each lead onto readable display columns (names/labels), dropping bare ids', async () => {
    const svc = build();
    const { rows, count } = await svc.exportRows(ALL, {} as any);
    expect(count).toBe(1);
    const r = rows[0] as Record<string, unknown>;
    // NAMES, not ids
    expect(r['Owner']).toBe('PRIYANKA');
    expect(r['Branch']).toBe('Janakpuri');
    expect(r['Status']).toBe('New');
    expect(r['Stage']).toBe('New Lead');
    expect(r['Source']).toBe('Transferred in');
    // no raw foreign-key id column leaks into the export
    expect(r).not.toHaveProperty('owner_id');
    expect(r).not.toHaveProperty('branch_id');
    expect(r).not.toHaveProperty('status_id');
    // labels / formatting
    expect(r['Temperature']).toBe('Cold');
    expect(r['Priority']).toBe('High');
    expect(r['Red Flagged']).toBe('Yes');
    expect(String(r['Created At'])).toMatch(/2026/);
    // custom field expanded by its label
    expect(r['Referred By']).toBe('Neha');
  });
});
