import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * FRANCHISE ACCESS (Phase 4 Batch 3).
 *
 * Resolves whether the current user is a FRANCHISE OWNER (linked to a franchise via
 * franchise.owner_user_id or the franchise_user mapping) and, if so, WHICH franchise_ids
 * they may see. Used to:
 *   · scope the Franchise module LIST endpoints to an owner's own franchise(s), and
 *   · guard every franchise :id endpoint so an owner cannot read ANOTHER franchise by id
 *     (returns 404 — same no-existence-oracle policy as the RBAC record-scope guard).
 *
 * The RBAC branch-level narrowing (buildScopeWhere) already restricts operational data
 * (leads/students/finance) to the owner's branches; this service adds the parallel guard
 * for the franchise-entity endpoints themselves, which key off franchise_id, not branch_id.
 * A NON-owner (head office / admin) is unrestricted here (returns isOwner=false).
 */
@Injectable()
export class FranchiseAccessService {
  constructor(private readonly db: DatabaseService) {}

  /** The franchise_ids this user owns / is mapped to (empty for a non-owner). */
  async ownerFranchiseIds(userId: number): Promise<number[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT DISTINCT f.id
         FROM franchise f
         LEFT JOIN franchise_user fu ON fu.franchise_id = f.id AND fu.user_id = $1
        WHERE f.deleted_at IS NULL AND (f.owner_user_id = $1 OR fu.user_id = $1)
        ORDER BY f.id`,
      [userId],
    );
    return rows.map((r) => Number(r.id));
  }

  async isOwner(userId: number): Promise<boolean> {
    return (await this.ownerFranchiseIds(userId)).length > 0;
  }

  /**
   * Throw 404 if the user is a franchise owner and `franchiseId` is not one of theirs.
   * A non-owner (admin) is allowed. Callers pass this on every franchise :id read/action.
   */
  async assertCanAccess(userId: number, franchiseId: number): Promise<void> {
    const ids = await this.ownerFranchiseIds(userId);
    if (ids.length === 0) return; // non-owner (admin) — unrestricted
    if (!ids.includes(Number(franchiseId))) throw new NotFoundException('Franchise not found');
  }

  /** If the user is an owner, return their franchise_ids to constrain a list query; else null. */
  async listConstraint(userId: number): Promise<number[] | null> {
    const ids = await this.ownerFranchiseIds(userId);
    return ids.length ? ids : null;
  }
}
