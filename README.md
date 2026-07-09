# Tech Lingua LLP — Education CRM + ERP (app)

Monorepo for the Phase-1 CRM. Sprint 1 delivers the foundation: hierarchy, masters,
users & teams, RBAC (roles, custom roles, multi-unit assignments, record/field scoping),
audit log, and the admin web UI.

```
app/
  api/   NestJS + TypeScript + PostgreSQL (raw SQL migrations, pg driver)
  web/   React + TypeScript + Vite (design tokens from prototype/techlingua-crm-prototype.html)
```

## Prerequisites
- Node.js ≥ 20
- PostgreSQL ≥ 14 (any local instance)

## 1. API setup

```bash
cd api
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, seed admin credentials
npm install
createdb techlingua_crm       # or CREATE DATABASE in psql
npm run db:migrate            # applies db/migrations/*.sql in order (tracked in schema_migrations)
npm run db:seed               # org, branches, verticals/pipelines/stages, masters, roles, permissions, Super Admin
npm run start:dev             # http://localhost:3001/api
```

Default seeded login (change immediately): `admin@techlingua.in` / value of `SEED_ADMIN_PASSWORD` (default `ChangeMe@123`).

Tests (RBAC scope-resolution suite):

```bash
npm test
```

## 2. Web setup

```bash
cd web
npm install
npm run dev                   # http://localhost:5173 (proxies /api -> localhost:3001)
```

## What's in Sprint 1
- **Hierarchy**: Org › Branch › Vertical › Pipeline (+stages) › Campaign › Source, full-path denormalised, CRUD + UI.
- **Masters**: generic module (state, city, source, course, qualification, budget, status, tag, follow-up type, disposition) — list/create/edit/deactivate.
- **Users & Teams**: CRUD, deactivate, bulk CSV import, teams with leader/members.
- **RBAC**: permission catalog, system + custom roles, matrix editor, record scope
  (own/team/branch/vertical/pipeline/campaign/all), field scope (JSONB), multi-unit user assignments,
  central `ScopeResolverService` + `PermissionsGuard` injecting scope filters into queries.
- **Audit log**: global interceptor writes every mutation + logins; viewer UI.
- **Lead schema** (tables only, APIs land in Sprint 2): lead, lead_tag, lead_activity, follow_up,
  campaign distribution/duplicacy JSONB configs per the NeoDove spec.

See `docs/dev/02-sprint1-implementation.md` for the API route list and deferred items.
