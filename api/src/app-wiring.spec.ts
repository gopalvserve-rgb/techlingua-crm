import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { DatabaseService } from './database/database.service';

/**
 * THE DEPENDENCY-INJECTION GUARD — boot the REAL Nest container.
 *
 * =============================================================================
 * WHY THIS EXISTS: Sprint 5 shipped a build that CRASHED ON BOOT.
 * =============================================================================
 *     Nest can't resolve dependencies of the ApprovalService
 *     (DatabaseService, ?, ScopeResolverService, NotifierService).
 *     Please make sure that the argument SettingsService at index [1]
 *     is available in the EnrolmentsModule context.
 *
 * `SettingsService` is not global — every module that uses it must provide it
 * (scoring.module, calendar.module, messaging.module all do). EnrolmentsModule did not.
 *
 * ALL 1025 UNIT TESTS PASSED, and `tsc` passed, because EVERY spec constructs its
 * service by hand — `new ApprovalService(db, settings, resolver)` — with doubles. The
 * INJECTOR, which is the thing that was broken, was never exercised by any of them.
 * The API then failed on the deployed container, which is the same lesson Sprints 3, 4
 * and 5 have each taught once: green unit tests do not catch what only the running
 * application can.
 *
 * This closes that gap for EVERY module, not just this one. It compiles the whole
 * AppModule — every provider, every import, every controller — against a stubbed
 * DatabaseService, so no Postgres is needed. Any future module that forgets a provider
 * goes red HERE, in seconds, instead of on the client's live URL.
 */

// `new Pool()` is lazy (it opens no socket until a query), but stubbing the whole service
// keeps this test honest about what it checks: WIRING, not data.
const dbStub = {
  pool: { end: async () => undefined },
  query: async () => [],
  one: async () => null,
  tx: async (fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [] }) }),
  onModuleDestroy: async () => undefined,
};

describe('the Nest container actually boots', () => {
  // Workers must not tick in a test; app.module honours these the same way main.ts does.
  const prevEnv = process.env.NODE_ENV;
  beforeAll(() => { process.env.NODE_ENV = 'test'; process.env.DISABLE_WORKERS = '1'; });
  afterAll(() => { process.env.NODE_ENV = prevEnv; });

  it('EVERY provider in EVERY module resolves — no missing dependency', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService).useValue(dbStub)
      .compile();
    expect(moduleRef).toBeTruthy();
    await moduleRef.close();
  }, 30_000);

  /**
   * The Sprint-5 services by name — so a failure says WHICH one, rather than making
   * somebody read a container trace. These are the four that hold money.
   */
  it('the Sprint-5 services are resolvable by the injector', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService).useValue(dbStub)
      .compile();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { QuotationService } = require('./quotations/quotation.service');
    const { EnrolmentService } = require('./enrolments/enrolment.service');
    const { ApprovalService } = require('./enrolments/approval.service');
    const { FeeService } = require('./fees/fee.service');
    const { NumberingService } = require('./numbering/numbering.service');
    const { TargetService } = require('./performance/target.service');
    const { PerformanceService } = require('./performance/performance.service');

    const unresolved: string[] = [];
    for (const [name, token] of [
      ['QuotationService', QuotationService], ['EnrolmentService', EnrolmentService],
      ['ApprovalService', ApprovalService], ['FeeService', FeeService],
      ['NumberingService', NumberingService], ['TargetService', TargetService],
      ['PerformanceService', PerformanceService],
    ] as Array<[string, never]>) {
      try {
        if (!moduleRef.get(token, { strict: false })) unresolved.push(name);
      } catch (e) { unresolved.push(`${name}: ${(e as Error).message.split('\n')[0]}`); }
    }
    // the failure NAMES the service, rather than making somebody read a container trace
    expect(unresolved).toEqual([]);
    await moduleRef.close();
  }, 30_000);

  /**
   * THE EXACT CRASH, pinned. ApprovalService takes SettingsService at index [1]; if
   * EnrolmentsModule stops providing it, this is the test that names the reason.
   */
  it('ApprovalService gets its SettingsService (the boot crash, pinned)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService).useValue(dbStub)
      .compile();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ApprovalService } = require('./enrolments/approval.service');
    const svc = moduleRef.get(ApprovalService, { strict: false });
    // it must be able to READ THE POLICY — which is what needs SettingsService
    await expect(svc.policy()).resolves.toMatchObject({ enabled: false });
    await moduleRef.close();
  }, 30_000);
});
