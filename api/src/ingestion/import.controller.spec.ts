import { ImportController } from './import.controller';
import { LeadsController } from '../leads/leads.controller';

/**
 * LIVE-SMOKE REGRESSION (14 Jul 2026): the import collection was first mounted at
 * `leads/import`, where `GET /leads/:id` (ParseIntPipe) shadowed it and answered
 * 400 for the Import History call. Import lives on its own collection now; this
 * test fails if anyone moves it back under `leads/`.
 */
describe('ImportController routing', () => {
  const prefix = (c: unknown) => Reflect.getMetadata('path', c as object);

  it('is mounted on its own collection, not under leads/', () => {
    expect(prefix(ImportController)).toBe('lead-imports');
    expect(prefix(LeadsController)).toBe('leads');
    expect(String(prefix(ImportController)).startsWith('leads/')).toBe(false);
  });
});
