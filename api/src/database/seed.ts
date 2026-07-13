/**
 * Seed script (idempotent — refuses to run if the organisation already exists).
 * Seeds: org "Tech Lingua LLP", 2 branches (Delhi, Mumbai), sample verticals/pipelines/stages,
 * a sample campaign+source, all masters, the full permission catalog, all system roles
 * (PROJECT_DOCUMENTATION §3.2) with sensible default grants, and a Super Admin user.
 * Usage: npm run db:seed
 */
import 'dotenv/config';
import { Pool, PoolClient } from 'pg';
import * as bcrypt from 'bcryptjs';
import { config } from '../config';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';

type Id = number;

async function seed(c: PoolClient) {
  // ---- organisation ------------------------------------------------------
  const org = (await c.query(
    `INSERT INTO organisation (name, code, settings) VALUES ($1,$2,$3) RETURNING id`,
    ['Tech Lingua LLP', 'TLL', JSON.stringify({ currency: 'INR', locale: 'en-IN' })],
  )).rows[0].id as Id;

  type MasterRow = readonly [name: string, code?: string | null, meta?: Record<string, unknown>, parentId?: Id | null];
  const master = async (table: string, rows: ReadonlyArray<MasterRow>) => {
    const ids: Id[] = [];
    let sort = 0;
    for (const [name, code, meta, parentId] of rows) {
      const r = await c.query(
        `INSERT INTO ${table} (org_id, name, code, sort_order, meta, parent_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [org, name, code, sort++, JSON.stringify(meta ?? {}), parentId ?? null],
      );
      ids.push(r.rows[0].id);
    }
    return ids;
  };

  // ---- masters -----------------------------------------------------------
  const [delhiState, mahaState] = await master('state', [['Delhi', 'DL'], ['Maharashtra', 'MH']]);
  const [delhiCity, mumbaiCity] = await master('city', [
    ['New Delhi', 'NDL', {}, delhiState],
    ['Mumbai', 'MUM', {}, mahaState],
  ]);
  await master('m_source', [
    ['Meta', 'META'], ['Google Ads', 'GADS'], ['JustDial', 'JD'], ['IndiaMART', 'IM'],
    ['Website Form', 'WEB'], ['Google Sheet', 'SHEET'], ['Walk-in', 'WALKIN'], ['Referral', 'REF'], ['Manual', 'MANUAL'],
  ]);
  await master('m_course', [
    ['Spoken English', 'SPEN'], ['IELTS', 'IELTS'], ['PTE', 'PTE'], ['French', 'FR'], ['German', 'DE'],
  ]);
  await master('m_qualification', [['10th', 'X'], ['12th', 'XII'], ['Graduate', 'GRAD'], ['Post-Graduate', 'PG']]);
  await master('m_budget', [['Under 25k', 'B1'], ['25k-50k', 'B2'], ['50k-1L', 'B3'], ['Above 1L', 'B4']]);
  await master('m_status', [
    ['New', 'NEW', { color: '#62d0ff' }],
    ['In Progress', 'PROG', { color: '#8a7bff' }],
    ['Follow-up', 'FUP', { color: '#ffb547' }],
    ['Won', 'WON', { color: '#2ee6c9', won: true }],
    ['Lost', 'LOST', { color: '#ff5d8f', lost: true }],
  ]);
  await master('m_tag', [['Hot Lead', 'HOT'], ['Priority', 'PRI'], ['Scholarship', 'SCH']]);
  await master('m_followup_type', [
    ['Call', 'CALL'], ['WhatsApp', 'WA'], ['Email', 'EMAIL'], ['SMS', 'SMS'], ['Meeting', 'MEET'], ['Visit', 'VISIT'],
  ]);
  await master('m_disposition', [
    ['Connected', 'CONN'], ['Not Reachable', 'NR'], ['Busy', 'BUSY'],
    ['Call Back', 'CB'], ['Interested', 'INT'], ['Not Interested', 'NI'],
  ]);
  const metaSourceId = (await c.query(`SELECT id FROM m_source WHERE org_id=$1 AND code='META'`, [org])).rows[0].id as Id;

  // ---- hierarchy: branches > verticals > pipelines/stages > campaign > source
  const branch = async (name: string, code: string, stateId: Id, cityId: Id) =>
    (await c.query(
      `INSERT INTO branch (org_id, name, code, state_id, city_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [org, name, code, stateId, cityId],
    )).rows[0].id as Id;
  const delhi = await branch('Delhi', 'DEL', delhiState, delhiCity);
  const mumbai = await branch('Mumbai', 'BOM', mahaState, mumbaiCity);

  const vertical = async (branchId: Id, name: string, code: string) =>
    (await c.query(
      `INSERT INTO vertical (org_id, branch_id, name, code) VALUES ($1,$2,$3,$4) RETURNING id`,
      [org, branchId, name, code],
    )).rows[0].id as Id;
  const tlaDel = await vertical(delhi, 'Tech Lingua Academy', 'TLA');
  const soDel = await vertical(delhi, 'Study Overseas', 'SO');
  const tlaBom = await vertical(mumbai, 'Tech Lingua Academy', 'TLA');

  const pipeline = async (branchId: Id, verticalId: Id, name: string, code: string, stages: Array<[string, string, boolean?]>) => {
    const pid = (await c.query(
      `INSERT INTO pipeline (org_id, branch_id, vertical_id, name, code) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [org, branchId, verticalId, name, code],
    )).rows[0].id as Id;
    let sort = 0;
    for (const [sname, type, isDefault] of stages) {
      await c.query(
        `INSERT INTO pipeline_stage (pipeline_id, name, sort_order, stage_type, is_default) VALUES ($1,$2,$3,$4,$5)`,
        [pid, sname, sort++, type, isDefault ?? false],
      );
    }
    return pid;
  };
  const defaultStages: Array<[string, string, boolean?]> = [
    ['New Lead', 'open', true], ['Contacted', 'open'], ['Counselling', 'open'],
    ['Negotiation', 'open'], ['Enrolled', 'won'], ['Lost', 'lost'],
  ];
  const admDel = await pipeline(delhi, tlaDel, 'Admissions', 'ADM', defaultStages);
  await pipeline(delhi, tlaDel, 'Corporate Training', 'CORP', defaultStages);
  await pipeline(delhi, soDel, 'Study Abroad Admissions', 'ADM', defaultStages);
  await pipeline(mumbai, tlaBom, 'Admissions', 'ADM', defaultStages);

  const campaign = (await c.query(
    `INSERT INTO campaign (org_id, branch_id, vertical_id, pipeline_id, name, utm, cost, distribution_config, duplicacy_config)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [org, delhi, tlaDel, admDel, 'Meta Leads Jul-26',
      JSON.stringify({ utm_source: 'facebook', utm_campaign: 'jul26' }), 25000,
      JSON.stringify({ mode: 'equal', batch_size: 10, agent_user_ids: [], round_robin_scope: 'campaign', conditions: [] }),
      JSON.stringify({ check_scope: 'global', match_key: 'phone', on_duplicate: 'merge', open_reassign_same_user: true }),
    ],
  )).rows[0].id as Id;
  await c.query(
    `INSERT INTO source (org_id, branch_id, vertical_id, pipeline_id, campaign_id, master_source_id, name, channel, webhook_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [org, delhi, tlaDel, admDel, campaign, metaSourceId, 'Meta Lead Ads', 'meta', 'whk_' + Math.random().toString(36).slice(2, 18)],
  );

  // ---- permission catalog --------------------------------------------------
  const permIds = new Map<string, Id>();
  for (const { module, actions } of PERMISSION_CATALOG) {
    for (const action of actions) {
      const key = `${module}.${action}`;
      // idempotent: migration 007 may have pre-seeded lead/followup permissions
      const r = await c.query(
        `INSERT INTO permission (key, module, action) VALUES ($1,$2,$3)
         ON CONFLICT (key) DO UPDATE SET module = EXCLUDED.module RETURNING id`,
        [key, module, action],
      );
      permIds.set(key, r.rows[0].id);
    }
  }

  // ---- system roles (PROJECT_DOCUMENTATION §3.2) ---------------------------
  const roleNames = [
    'Super Admin', 'Organization Admin', 'Branch Manager', 'Vertical Manager', 'Team Leader',
    'Counsellor', 'Telecaller', 'Trainer', 'Academic Coordinator', 'Accountant',
    'HR Manager', 'Marketing Manager', 'Student', 'Parent',
  ];
  const roles = new Map<string, Id>();
  for (const name of roleNames) {
    const r = await c.query(
      `INSERT INTO role (org_id, name, is_system, description) VALUES ($1,$2,TRUE,$3) RETURNING id`,
      [org, name, `System role: ${name}`],
    );
    roles.set(name, r.rows[0].id);
  }

  const grant = async (role: string, keys: string[] | 'ALL', scope: string) => {
    const roleId = roles.get(role)!;
    const list = keys === 'ALL' ? [...permIds.keys()] : keys;
    for (const key of list) {
      const pid = permIds.get(key);
      if (!pid) throw new Error(`unknown permission ${key}`);
      await c.query(
        `INSERT INTO role_permission (role_id, permission_id, record_scope) VALUES ($1,$2,$3)
         ON CONFLICT (role_id, permission_id) DO UPDATE SET record_scope = EXCLUDED.record_scope`,
        [roleId, pid, scope],
      );
    }
  };

  // Full access for admins
  await grant('Super Admin', 'ALL', 'all');
  await grant('Organization Admin', 'ALL', 'all');
  // Branch Manager: everything inside the branch except org/role administration
  await grant('Branch Manager', [
    'dashboard.read', 'lead.read', 'lead.create', 'lead.update', 'lead.assign', 'lead.transfer', 'lead.export',
    'followup.read', 'followup.create', 'followup.update',
    'user.read', 'team.read', 'team.create', 'team.update',
    'branch.read', 'vertical.read', 'pipeline.read', 'campaign.read', 'campaign.create', 'campaign.update',
    'source.read', 'source.create', 'source.update', 'master.read', 'custom_field.read', 'report.read', 'report.export',
  ], 'branch');
  // Vertical Manager: same shape, scoped to vertical
  await grant('Vertical Manager', [
    'dashboard.read', 'lead.read', 'lead.create', 'lead.update', 'lead.assign', 'lead.export',
    'followup.read', 'followup.create', 'followup.update',
    'user.read', 'team.read', 'vertical.read', 'pipeline.read',
    'campaign.read', 'campaign.create', 'campaign.update', 'source.read', 'source.create', 'source.update',
    'master.read', 'custom_field.read', 'report.read', 'report.export',
  ], 'vertical');
  await grant('Team Leader', [
    'dashboard.read', 'lead.read', 'lead.update', 'lead.assign',
    'followup.read', 'followup.create', 'followup.update', 'team.read', 'user.read', 'master.read', 'report.read',
  ], 'team');
  const agentPerms = ['dashboard.read', 'lead.read', 'lead.create', 'lead.update',
    'followup.read', 'followup.create', 'followup.update', 'master.read'];
  await grant('Counsellor', agentPerms, 'own');
  await grant('Telecaller', agentPerms, 'own');
  await grant('Trainer', ['dashboard.read', 'master.read'], 'own');
  await grant('Academic Coordinator', ['dashboard.read', 'master.read'], 'branch');
  await grant('Accountant', ['dashboard.read', 'report.read', 'report.export', 'master.read'], 'branch');
  await grant('HR Manager', ['dashboard.read', 'user.read', 'master.read'], 'all');
  await grant('Marketing Manager', [
    'dashboard.read', 'campaign.read', 'campaign.create', 'campaign.update',
    'source.read', 'source.create', 'source.update', 'lead.read', 'report.read', 'report.export', 'master.read',
  ], 'vertical');
  // Student / Parent: portal roles, no CRM permissions in Phase 1

  // ---- Super Admin user ----------------------------------------------------
  const hash = await bcrypt.hash(config.seedAdminPassword, 10);
  const admin = (await c.query(
    `INSERT INTO "user" (org_id, name, email, phone, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [org, 'Super Admin', config.seedAdminEmail, config.seedAdminPhone, hash],
  )).rows[0].id as Id;
  await c.query(
    `INSERT INTO user_assignment (user_id, role_id) VALUES ($1,$2)`,   // org-wide: all unit columns NULL
    [admin, roles.get('Super Admin')],
  );

  // sample team
  await c.query(
    `INSERT INTO team (org_id, branch_id, vertical_id, name, leader_id) VALUES ($1,$2,$3,$4,$5)`,
    [org, delhi, tlaDel, 'Delhi Counselling Team', admin],
  );

  console.log(`Seeded org=${org}. Super Admin: ${config.seedAdminEmail} · mobile ${config.seedAdminPhone} / ${config.seedAdminPassword}`);
}

async function main() {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const existing = await pool.query('SELECT COUNT(*)::int AS n FROM organisation');
  if (existing.rows[0].n > 0) {
    console.log('Organisation already seeded — nothing to do.');
    await pool.end();
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seed(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
