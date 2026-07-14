import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

/**
 * "Notify the owner's MANAGER" — who is that, exactly?
 *
 * The escalation policy says "notify the owner's manager". The org chart is not a
 * tree of users, it is the RBAC assignment graph, so the manager is resolved by
 * WALKING UP the lead's own hierarchy path, most specific first:
 *
 *   1. the TEAM LEADER of the lead's team (team.leader_id)
 *   2. a user assigned as VERTICAL MANAGER on the lead's vertical
 *   3. a user assigned as BRANCH MANAGER on the lead's branch
 *   4. an ORGANIZATION ADMIN (the backstop — an escalation must never go nowhere)
 *
 * Only ACTIVE, non-deleted users, and never the owner themselves (escalating a lead
 * to the person who is already late on it would be theatre).
 */
@Injectable()
export class ManagerResolverService {
  constructor(private readonly db: DatabaseService) {}

  async managersFor(leadId: number, ownerId: number | null, client?: PoolClient): Promise<number[]> {
    const q = async (sql: string, params: unknown[]) =>
      client ? (await client.query(sql, params as any[])).rows : this.db.query(sql, params);

    const rows = await q(
      `WITH l AS (
         SELECT id, branch_id, vertical_id, team_id FROM lead WHERE id = $1
       )
       -- 1) team leader
       SELECT u.id, 1 AS rank FROM l
         JOIN team t ON t.id = l.team_id AND t.deleted_at IS NULL
         JOIN "user" u ON u.id = t.leader_id AND u.status = 'active' AND u.deleted_at IS NULL
       UNION ALL
       -- 2) vertical manager on THIS vertical
       SELECT u.id, 2 FROM l
         JOIN user_assignment a ON a.vertical_id = l.vertical_id
         JOIN role r ON r.id = a.role_id AND r.name = 'Vertical Manager'
         JOIN "user" u ON u.id = a.user_id AND u.status = 'active' AND u.deleted_at IS NULL
       UNION ALL
       -- 3) branch manager on THIS branch
       SELECT u.id, 3 FROM l
         JOIN user_assignment a ON a.branch_id = l.branch_id
         JOIN role r ON r.id = a.role_id AND r.name = 'Branch Manager'
         JOIN "user" u ON u.id = a.user_id AND u.status = 'active' AND u.deleted_at IS NULL
       UNION ALL
       -- 4) backstop: an org admin — an escalation must never be delivered to nobody
       SELECT u.id, 4 FROM user_assignment a
         JOIN role r ON r.id = a.role_id AND r.name IN ('Organization Admin', 'Super Admin')
         JOIN "user" u ON u.id = a.user_id AND u.status = 'active' AND u.deleted_at IS NULL
       ORDER BY rank`,
      [leadId],
    );

    const owner = Number(ownerId ?? 0);
    const seen = new Set<number>();
    const out: number[] = [];
    let bestRank: number | null = null;
    for (const r of rows) {
      const id = Number(r.id);
      const rank = Number(r.rank);
      if (id === owner || seen.has(id)) continue;
      // take every manager at the MOST SPECIFIC level that yielded anyone, and stop.
      if (bestRank === null) bestRank = rank;
      if (rank !== bestRank) break;
      seen.add(id);
      out.push(id);
    }
    return out;
  }
}
