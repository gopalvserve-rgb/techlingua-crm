import { CoursesService } from './courses.service';
import { DatabaseService } from '../database/database.service';

/**
 * Course catalogs (client feedback #13) — the seeded dropdown sets behind Course Type / Level /
 * Delivery Mode. Mirrors batches/type-catalog. Uses a fake db that echoes the seeded rows so the
 * test proves each endpoint reads its own *_def table in ordering order.
 */
function build(rows: Record<string, unknown[]>) {
  const calls: string[] = [];
  const db = {
    query: async (sql: string) => {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      const key = ['m_course_type', 'course_level_def', 'course_delivery_def'].find((k) => sql.includes(k))!;
      return rows[key] ?? [];
    },
  } as unknown as DatabaseService;
  return { svc: new CoursesService(db), calls };
}

describe('CoursesService catalogs', () => {
  const seed = {
    m_course_type: [{ code: 'Diploma', label: 'Diploma', ordering: 10 }, { code: 'Certificate', label: 'Certificate', ordering: 20 }],
    course_level_def: [{ code: 'A1', label: 'A1', ordering: 10 }, { code: 'A2', label: 'A2', ordering: 20 }],
    course_delivery_def: [{ code: 'Offline', label: 'Offline', ordering: 10 }, { code: 'Online', label: 'Online', ordering: 20 }, { code: 'Hybrid', label: 'Hybrid', ordering: 30 }],
  };

  it('typeCatalog reads the m_course_type master ordered (dev/106)', async () => {
    const { svc, calls } = build(seed);
    const out = await svc.typeCatalog();
    expect(calls[0]).toContain('FROM m_course_type');
    expect(out.map((r: any) => r.code)).toEqual(['Diploma', 'Certificate']);
  });

  it('levelCatalog reads course_level_def', async () => {
    const { svc, calls } = build(seed);
    const out = await svc.levelCatalog();
    expect(calls[0]).toContain('FROM course_level_def');
    expect(out.map((r: any) => r.code)).toEqual(['A1', 'A2']);
  });

  it('deliveryCatalog reads course_delivery_def with the three modes', async () => {
    const { svc, calls } = build(seed);
    const out = await svc.deliveryCatalog();
    expect(calls[0]).toContain('FROM course_delivery_def');
    expect(out.map((r: any) => r.code)).toEqual(['Offline', 'Online', 'Hybrid']);
  });
});
