/**
 * THE SETTINGS REGISTRY — every non-credential setting the client may change, declared
 * once. The Settings screen is GENERATED from this, so adding a setting is one entry, and
 * a setting that exists in the DB but not here is invisible (which is the point: the
 * ad-hoc `app_setting` rows Sprints 2–3 created are now either listed here or deliberately
 * hidden as internal machinery).
 *
 * CONSOLIDATION (Sprint 4). What used to be scattered rows read by whoever needed them:
 *   · lead_score_config    (Sprint 3) -> stays where the client already edits it, on the
 *                                        Lead Scoring screen. Surfaced here READ-ONLY as a
 *                                        link, because two places to edit one number is how
 *                                        you get two different numbers.
 *   · escalation_policy    (Sprint 3) -> Settings › Notifications (it IS a notification rule)
 *   · notification_channels(Sprint 3) -> ABSORBED into `notification_matrix`, which says
 *                                        which EVENT goes to which CHANNEL. The old row is
 *                                        still honoured as a master on/off switch.
 *   · calendar_sync        (Sprint 3) -> RETIRED by migration 028: the OAuth client
 *                           secret belongs in the ENCRYPTED channel_config store, not in a
 *                           plaintext app_setting blob. Now Settings › Channels › Calendar.
 *   · handout_guard        (Sprint 2) -> Settings › Leads
 *   · sms_provider         (Sprint 2) -> SUPERSEDED by channel_config(channel='sms').
 *                                        SmsService reads the new store first and falls
 *                                        back to the old row, so OTP login keeps working
 *                                        and lights up from the same Settings screen.
 */

export interface SettingField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'bool' | 'select' | 'time' | 'json' | 'textarea';
  hint?: string;
  opts?: string[];
}

export interface SettingGroup {
  key: string;                 // the app_setting row key
  label: string;
  blurb: string;
  icon?: string;
  fields?: SettingField[];     // flat fields; groups with a bespoke editor omit them
  /** rendered by a purpose-built editor in the UI rather than the generic field list */
  editor?: 'business_hours' | 'holidays' | 'numbering' | 'matrix' | 'channels' | 'approvals';
  readonly?: boolean;
  /** where the client edits it instead, when it lives on another screen */
  managedOn?: string;
}

export const SETTING_GROUPS: SettingGroup[] = [
  {
    key: 'org_profile', label: 'Organisation', icon: 'admin',
    blurb: 'Name, currency, timezone and date format — used across every screen, export and message.',
    fields: [
      { key: 'name', label: 'Organisation name', type: 'text' },
      { key: 'currency', label: 'Currency', type: 'select', opts: ['INR', 'USD', 'GBP', 'AED'] },
      { key: 'timezone', label: 'Timezone', type: 'select', opts: ['Asia/Kolkata', 'Asia/Dubai', 'UTC'] },
      { key: 'date_format', label: 'Date format', type: 'select', opts: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] },
    ],
  },
  {
    key: 'channels', label: 'Channels & credentials', icon: 'bolt', editor: 'channels',
    blurb: 'WhatsApp (Meta Cloud API), SMS gateway, SMTP PER VERTICAL, the Razorpay payment gateway per vertical, and the AI keys. Every secret is encrypted at rest and masked on read.',
  },
  {
    key: 'business_hours', label: 'Business hours', icon: 'clock', editor: 'business_hours',
    blurb: 'Automation never messages a lead outside these hours — it waits for the next working window rather than dropping the message.',
  },
  {
    key: 'holidays', label: 'Holidays', icon: 'cal', editor: 'holidays',
    blurb: 'Whole closed days. A journey due on a holiday goes out on the next working morning.',
  },
  {
    key: 'journey_guardrails', label: 'Automation guardrails', icon: 'bolt',
    blurb: 'The limits every automated message obeys — however many journeys the client builds.',
    fields: [
      { key: 'respect_business_hours', label: 'Respect business hours', type: 'bool', hint: 'Defer automated sends to the next working window' },
      { key: 'max_sends_per_lead_per_day', label: 'Max automated messages per lead per day', type: 'number', hint: '0 = no cap' },
      { key: 'honour_opt_out', label: 'Honour opt-out', type: 'bool', hint: 'Always on in practice — an opt-out a counsellor can click past is not an opt-out' },
    ],
  },
  {
    key: 'notification_matrix', label: 'Notification matrix', icon: 'bell', editor: 'matrix',
    blurb: 'Which event notifies people on which channel. In-app is always on: the bell is the system of record.',
  },
  {
    key: 'escalation_policy', label: 'Follow-up reminders & escalation', icon: 'clock',
    blurb: 'When to remind the owner, and what happens when a follow-up goes overdue. (Consolidated here in Sprint 4 — it is a notification rule.)',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool' },
      { key: 'reminder_lead_minutes', label: 'Remind this many minutes before due', type: 'number' },
      { key: 'overdue_after_minutes', label: 'Escalate after overdue by (minutes)', type: 'number' },
      { key: 'repeat_every_minutes', label: 'Repeat escalation every (minutes)', type: 'number', hint: '0 = once' },
    ],
  },
  {
    key: 'message_rate_limits', label: 'Sending rate limits', icon: 'perf',
    blurb: 'Messages per minute, per channel. Exceeding a provider\'s limit gets the account suspended.',
    fields: [
      { key: 'email', label: 'Email / minute', type: 'number' },
      { key: 'sms', label: 'SMS / minute', type: 'number' },
      { key: 'whatsapp', label: 'WhatsApp / minute', type: 'number' },
    ],
  },
  {
    key: 'numbering_series', label: 'Numbering series', icon: 'doc', editor: 'numbering',
    blurb: 'Prefix and next number for quotations, enrolments and fee receipts (and invoices, which Phase 3 uses). '
      + 'A branch or vertical series overrides the org-wide one — most specific wins, the same rule the SLA policies use.',
  },
  {
    // Client ID re-model (dev/97). The FIXED org/centre code that prefixes every Student ID
    // (`<CENTRE_CODE>-<YEAR>-<NNN>`, e.g. VP001-2026-001). A single value set once here — NOT
    // derived per branch. Changing it affects NEW Student IDs only; existing IDs are stable.
    key: 'student_centre_code', label: 'Student ID centre code', icon: 'doc',
    blurb: 'The fixed centre code that prefixes every Student ID, e.g. VP001 → VP001-2026-001. '
      + 'One value for the whole organisation. Changing it changes only Student IDs minted afterwards.',
    fields: [
      { key: 'code', label: 'Centre code', type: 'text', hint: 'Uppercase, e.g. VP001 (no spaces). Used as the Student ID prefix.' },
    ],
  },
  {
    // Sprint 5. Its value lives in `app_setting.enrolment_approvals`, but the card is a
    // purpose-built editor: this is the one switch that changes how every sale closes,
    // and a JSON textarea is not the place for it.
    key: 'enrolment_approvals', label: 'Enrolment approvals', icon: 'check', editor: 'approvals',
    blurb: 'Optional approval per step on sale closure. OFF by default — a counsellor closes a sale and it is closed. '
      + 'Switched on, the same closure goes to an approval queue and cannot take a fee or count towards a target until approved.',
  },
  {
    key: 'handout_guard', label: 'Start Calling guardrail', icon: 'target',
    blurb: 'The anti-hoarding limit on the on-demand hand-out. OFF by default. (Sprint-2 row, consolidated here.)',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool' },
      { key: 'max_open_per_agent', label: 'Max un-worked leads an agent may hold', type: 'number' },
    ],
  },
  {
    key: 'lead_score_config', label: 'Lead score bands', icon: 'perf', readonly: true,
    managedOn: 'Marketing & Lead Management › Lead Scoring',
    blurb: 'Hot / Warm thresholds and the 15 scoring rules are edited on the Lead Scoring screen — one place, so the numbers cannot disagree.',
    fields: [
      { key: 'hot', label: 'Hot at score ≥', type: 'number' },
      { key: 'warm', label: 'Warm at score ≥', type: 'number' },
    ],
  },
];

export const GROUP_BY_KEY: Record<string, SettingGroup> = Object.fromEntries(SETTING_GROUPS.map((g) => [g.key, g]));
