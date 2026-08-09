/**
 * Shared secret-redaction for anything persisted from request payloads
 * (audit_log `before/after`, error_log `meta`). Key-name based, case-insensitive
 * substring match, applied recursively (depth-limited) so nested payloads are
 * covered too. Never throws — persistence sinks must be fail-safe.
 */

/** Body keys never persisted to audit/error trails (substring match, lowercase). */
export const SENSITIVE_KEYS = [
  'password', 'password_hash', 'new_password', 'csv',
  'token', 'secret', 'authorization', 'api_key', 'apikey',
  // Government ID proofs (student profile) — never persisted to audit_log/error_log trails.
  'aadhaar', 'pan', 'passport', 'id_proof_number',
];

const MAX_DEPTH = 4;

export function redact(obj: unknown, depth = 0): unknown {
  try {
    if (!obj || typeof obj !== 'object' || depth >= MAX_DEPTH) return obj;
    if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
    const clone: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
    for (const k of Object.keys(clone)) {
      if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s))) clone[k] = '[redacted]';
      else if (clone[k] && typeof clone[k] === 'object') clone[k] = redact(clone[k], depth + 1);
    }
    return clone;
  } catch {
    return undefined; // fail-safe: drop rather than risk persisting secrets
  }
}
