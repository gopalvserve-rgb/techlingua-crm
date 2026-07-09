/**
 * Permission catalog — the module × action grid that role_permission rows reference.
 * key = `${module}.${action}`. Seeded into the `permission` table by db:seed.
 * Add new modules here as sprints land; the seed only runs once, so late additions
 * need a small catalog-sync migration (Sprint 2 note).
 */
export interface PermissionModule {
  module: string;
  label: string;
  actions: string[];
}

export const PERMISSION_CATALOG: PermissionModule[] = [
  { module: 'dashboard', label: 'Dashboard', actions: ['read'] },
  { module: 'lead', label: 'Leads', actions: ['read', 'create', 'update', 'delete', 'assign', 'transfer', 'export', 'import'] },
  { module: 'followup', label: 'Follow-ups', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'user', label: 'Users', actions: ['read', 'create', 'update', 'deactivate', 'import'] },
  { module: 'team', label: 'Teams', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'role', label: 'Roles & Permissions', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'assignment', label: 'User Assignments', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'branch', label: 'Branches', actions: ['read', 'create', 'update', 'deactivate'] },
  { module: 'vertical', label: 'Verticals', actions: ['read', 'create', 'update', 'deactivate'] },
  { module: 'pipeline', label: 'Pipelines & Stages', actions: ['read', 'create', 'update', 'deactivate'] },
  { module: 'campaign', label: 'Campaigns', actions: ['read', 'create', 'update', 'deactivate'] },
  { module: 'source', label: 'Sources', actions: ['read', 'create', 'update', 'deactivate'] },
  { module: 'master', label: 'Masters', actions: ['read', 'create', 'update', 'deactivate'] },
  { module: 'custom_field', label: 'Custom Fields', actions: ['read', 'create', 'update', 'deactivate'] },
  { module: 'audit', label: 'Audit Logs', actions: ['read', 'export'] },
  { module: 'errorlog', label: 'Error Logs', actions: ['read', 'manage'] },
  { module: 'report', label: 'Reports', actions: ['read', 'export'] },
  { module: 'settings', label: 'Settings', actions: ['read', 'update'] },
];
