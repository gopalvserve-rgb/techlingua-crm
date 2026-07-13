/**
 * THE INGESTION CONTRACT — every lead capture channel (bulk CSV today; webhook,
 * website form and Google-Sheet pull next) calls LeadIngestionService.ingest()
 * with exactly this shape. Nothing else may create a lead from an external
 * record: normalisation, hierarchy resolution, E.164 phones, NeoDove duplicate
 * rules, campaign distribution, audit and idempotency all live behind it.
 */

/** Mappable lead fields (the CSV column-mapping targets, and the webhook JSON keys). */
export interface IngestPayload {
  full_name?: string;
  phone?: string;
  email?: string;
  alt_phone?: string;
  /** master values may arrive as a NAME ("IELTS") or a numeric id — both resolve */
  state?: string | number;
  city?: string | number;
  course?: string | number;
  qualification?: string | number;
  budget?: string | number;
  status?: string | number;
  stage?: string | number;
  priority?: string;
  temperature?: string;
  score?: string | number;
  next_follow_up_at?: string;
  note?: string;
  /** comma-separated or array of tag names */
  tags?: string | string[];
  /** the source system's own record id — becomes the idempotency key when present */
  external_id?: string;
  /** custom_field_def.field_key -> value */
  custom_fields?: Record<string, unknown>;
}

export type IngestChannel = 'csv' | 'webhook' | 'form' | 'sheet' | 'api' | 'manual';

/**
 * Duplicate policy:
 *  - 'campaign'      : obey the campaign's duplicacy_config.on_duplicate
 *                      (ignore | create | merge* | merge_and_reopen*) — used by
 *                      every AUTOMATED channel.
 *  - 'always_create' : always create the lead, flag is_duplicate — the existing,
 *                      client-verified behaviour of the interactive "Add lead"
 *                      form (a human typing a lead is an explicit act and must
 *                      never be silently swallowed by an `ignore` rule).
 * (*) merge / merge_and_reopen are the NEXT workstream. Today they behave as
 *     `create + flag` and the intended action is recorded on the ingest record
 *     (pending_action) so the merge engine can pick these up — see DuplicateDecision.
 */
export type DuplicatePolicy = 'campaign' | 'always_create';

export interface IngestContext {
  channel: IngestChannel;
  campaign_id: number;
  source_id: number;
  /** who is credited in lead_activity / audit_log (null for anonymous webhooks) */
  actor_id: number | null;
  /** CSV/import batch this record belongs to (null for live webhooks) */
  batch_id?: number | null;
  /** provider-supplied record id; when absent a content hash is used */
  external_key?: string | null;
  duplicate_policy?: DuplicatePolicy;
  /** manual path only: an explicitly chosen owner wins over distribution */
  owner_id?: number | null;
  /** manual path only: extra columns the interactive form sets directly */
  extra?: Record<string, unknown>;
}

export type IngestStatus =
  | 'created'    // a new lead exists
  | 'duplicate'  // matched an existing lead; campaign action applied (no new lead)
  | 'skipped'    // idempotent replay: this exact record was already ingested
  | 'failed';    // validation / resolution error — lands in import_error, never dropped

export interface IngestOutcome {
  status: IngestStatus;
  lead_id?: number | null;
  duplicate_of?: number | null;
  /** the duplicacy action that WOULD apply once merge lands (seam, not executed) */
  pending_action?: string | null;
  owner_id?: number | null;
  reason?: string | null;
}

/** Thrown for a row that can never succeed (bad data) — the worker does NOT retry it. */
export class IngestValidationError extends Error {
  readonly permanent = true;
  constructor(message: string) { super(message); this.name = 'IngestValidationError'; }
}
