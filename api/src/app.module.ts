import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { RbacModule } from './rbac/rbac.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TeamsModule } from './teams/teams.module';
import { RolesModule } from './roles/roles.module';
import { AssignmentsModule } from './assignments/assignments.module';
import { HierarchyModule } from './hierarchy/hierarchy.module';
import { MastersModule } from './masters/masters.module';
import { AuditModule } from './audit/audit.module';
import { ErrorLogModule } from './errorlog/error-log.module';
import { LeadsModule } from './leads/leads.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { SoftDeleteModule } from './softdelete/softdelete.module';
import { ScoringModule } from './scoring/scoring.module';
import { SlaModule } from './sla/sla.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { CalendarModule } from './calendar/calendar.module';
import { CaptureModule } from './capture/capture.module';
import { MessagingModule } from './messaging/messaging.module';
import { StorageModule } from './storage/storage.module';
import { TemplatesModule } from './templates/templates.module';
import { SmsTemplatesModule } from './smstemplates/sms-templates.module';
import { JourneysModule } from './journeys/journeys.module';
import { SettingsModule } from './settings/settings.module';
import { NumberingModule } from './numbering/numbering.module';
import { QuotationsModule } from './quotations/quotations.module';
import { EnrolmentsModule } from './enrolments/enrolments.module';
import { FeesModule } from './fees/fees.module';
import { InvoicesModule } from './invoices/invoices.module';
import { PlansModule } from './paymentplans/plans.module';
import { PaymentsModule } from './payments/payments.module';
import { RefundsModule } from './refunds/refunds.module';
import { RevenueModule } from './revenue/revenue.module';
import { PerformanceModule } from './performance/performance.module';
import { ReportsModule } from './reports/reports.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { ApiAccessModule } from './apiaccess/api-access.module';
import { SupportModule } from './support/support.module';
import { CrossSellModule } from './crosssell/crosssell.module';
import { CustomFieldsModule } from './customfields/custom-fields.module';
import { StudentsModule } from './students/students.module';
import { FinanceModule } from './finance/finance.module';
import { AcademicsModule } from './academics/academics.module';
import { LearningModule } from './learning/learning.module';
import { AdmissionsModule } from './admissions/admissions.module';
import { AiModule } from './ai/ai.module';
import { OperationsModule } from './operations/operations.module';
import { HrModule } from './hr/hr.module';
import { SupportExtrasModule } from './supportextras/supportextras.module';
import { AssessmentsModule } from './assessments/assessments.module';
import { NotificationEventsModule } from './notificationevents/notification-events.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PermissionsGuard } from './rbac/permissions.guard';
import { RecordScopeGuard } from './rbac/record-scope.guard';
import { AuditInterceptor } from './common/audit.interceptor';
import { PgExceptionFilter } from './common/pg-exception.filter';

@Module({
  imports: [
    DatabaseModule,
    RbacModule,
    AuthModule,
    UsersModule,
    TeamsModule,
    RolesModule,
    AssignmentsModule,
    HierarchyModule,
    MastersModule,
    AuditModule,
    ErrorLogModule,
    LeadsModule,
    IngestionModule,
    SoftDeleteModule,
    // Sprint 3 — working the lead
    ScoringModule,      // rule-based, admin-configurable lead scoring (Hot/Warm/Cold)
    SlaModule,          // SLA policies, per-lead clocks, per-stage TAT
    NotificationsModule,// the bell + the channel-agnostic notifier + the reminder/escalation/SLA worker
    DashboardModule,    // role-based dashboards (scope-derived, never role-name-derived)
    CalendarModule,     // in-app calendar; Google/Outlook sync config-driven
    CaptureModule,      // walk-ins (assign-on-add) & referrals
    // Sprint 4 — engagement & automation
    MessagingModule,    // WhatsApp (Meta) · SMS (any gateway) · Email (per-vertical SMTP) + the send log/queue
    StorageModule,      // Cloudflare R2 — the SINGLE file/asset store (admission docs, generated PDFs, materials); nothing on disk / no DB blobs
    TemplatesModule,    // dynamic templates per channel, merge variables, live preview
    SmsTemplatesModule, // DLT SMS templates (Branch+Vertical) + Nimbus auto-send on new lead
    JourneysModule,     // trigger -> conditions -> actions, idempotent, guard-railed
    SettingsModule,     // Administration › Settings: credentials (encrypted), hours, holidays, matrix, numbering
    // Sprint 5 — conversion & money-lite
    NumberingModule,    // @Global: the numbering series quotations/enrolments/receipts allocate from
    QuotationsModule,   // line items, discounts, tax shown (NOT GST — Phase 3), PDF, send, revisions
    EnrolmentsModule,   // sale closure + the OPTIONAL per-step approval queue (default OFF)
    FeesModule,         // LITE fee receipt + collection entry (Razorpay capture = Phase 3)
    InvoicesModule,     // Phase 3 Batch 1 — GST tax invoices (CGST/SGST vs IGST, HSN, place of supply, FY numbering, PDF)
    PlansModule,        // Phase 3 Batch 2 — payment plans + installment schedule, fee dues & ageing (IST), auto reminders
    PaymentsModule,     // Phase 3 Batch 3 — Razorpay online collection (per vertical) + partial payments + auto-receipts + webhook
    RefundsModule,      // Phase 3 Batch 4 — refunds with an approval hierarchy (REF- voucher, net collected)
    RevenueModule,      // Phase 3 Batch 4 — revenue (collection vs accrual) + collection reports + Tally export
    PerformanceModule,  // monthly targets + counsellor performance, scoped by the ScopeResolver
    // Sprint 6 — reports, workspace, hardening (closes Phase 1)
    ReportsModule,      // the Report Builder + standard reports + exports + scheduled delivery
    WorkspaceModule,    // team messages, notes, knowledge base, announcements
                        // (TASKS are the follow-up module — reused, not forked)
    // UAT-R3b — the Developer / API module (Administration › API)
    ApiAccessModule,    // API keys (hashed), docs, request log, enable/disable; key-authed public create-lead
    // Post-Phase-1 client request — Help & Support › Support Tickets (internal, full lifecycle)
    SupportModule,      // support_ticket + comments, ticket.* RBAC, SLA, notify assignee
    CrossSellModule,
    CustomFieldsModule,  // client Aug 2026: DEFINE lead custom fields → render on Add/Edit lead form    // cross_sell_rule + cross_sell_attempt, crosssell.* RBAC, act via follow-up or LeadIngestionService
    // Phase 2 (CRM-level) — Students & Academics: lead->student conversion, students dir + dashboard, batches
    StudentsModule,
    // Client request — Finance Settings: discount / scholarship / capping limit (% AND ₹), enforced at discount points
    FinanceModule,
    // Phase 2 ERP Batch 1 — Academics core: batch transfer/waitlist, attendance, tests & scores, assignments
    AcademicsModule,
    // Phase 2 ERP Batch 2 — Learning: study material, certificates, report cards + parent view
    LearningModule,
    AdmissionsModule,  // ERP Batch 3 — online admission form (public intake + review→approve) + family/siblings
    AiModule,          // ERP Batch 4 — AI Communication Intelligence (DeepSeek/Gemini) over notes/transcripts
    // Phase 2 ERP Batch 5 — Operations: catalog, inventory, assets, vendors, procurement (PO→receive→stock)
    OperationsModule,
    HrModule,        // ERP Batch 6 — Basic HR: employee directory, staff attendance, leaves
    // ERP Batch 7 — Support extras: Training Videos + Release Notes (org-wide staff content under Help & Support)
    SupportExtrasModule,
    // Client request — Notification Events: 37-event catalog, per-channel enable + template mapping,
    // fired over the existing notifier/messaging send path.
    NotificationEventsModule,
    // Assessment / Test Module — Batch A: the Question Bank foundation (categories, questions,
    // options, media to R2, CSV import/export). Batches B/C/D build tests, attempts, results.
    AssessmentsModule,
  ],
  providers: [
    // guard order matters: authenticate, authorise (permission), then record scope
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // by-ID record-scope enforcement on @ScopedEntity routes (out-of-scope -> 404)
    { provide: APP_GUARD, useClass: RecordScopeGuard },
    // every successful mutation lands in audit_log
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // Postgres constraint violations -> readable 409/400 instead of 500
    { provide: APP_FILTER, useClass: PgExceptionFilter },
  ],
})
export class AppModule {}
