import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * DEF-R3-01 / DEF-1 — the ONE shared "target must be an active user" guard.
 *
 * The deactivation flag on "user" is `status` ('active' | 'disabled') — that is what
 * Users > deactivate writes and what auth.service.ts checks at login. The legacy
 * `is_active` boolean is never written to FALSE, so guarding on it is a no-op and would
 * let a disabled user be assigned/reassigned. Guard on `status`; the soft-delete check
 * stays (deleted_at IS NULL). Anything else (missing, unknown, soft-deleted, disabled)
 * is a 400 that NAMES the field, so a caller can tell "no such user" from "that user is
 * disabled" instead of a generic rejection.
 *
 * Reused by every owner-setting path so the rule lives in exactly one place:
 * lead reassign/owner update, follow-up owner + report_to.
 */
export async function assertActiveUser(
  db: DatabaseService,
  id: number,
  field: string,
): Promise<void> {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException(`invalid ${field}`);
  const u = await db.one<{ id: string }>(
    `SELECT id FROM "user" WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
    [n],
  );
  if (!u) throw new BadRequestException(`${field} must be an active user`);
}
