# Deploy — GitHub + Railway (+ Cloudflare later)

Repo root = this `app/` folder. Secrets live ONLY in Railway Variables / GitHub token store — `.gitignore` blocks `env.txt`, `.env`, `*.token`, `secrets*`.

## GitHub
Private repo (e.g. `techlingua-crm`). Push this folder as-is (`api/` + `web/` + `railway.json`).

## Railway
1. New Project → Deploy from GitHub repo → pick the repo.
2. Add **PostgreSQL** and **Redis** database plugins.
3. API service → Variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `JWT_SECRET` = long random string
   - `WEB_ORIGIN` = web app URL (Cloudflare Pages URL once live)
   - `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` = real admin credentials (change from defaults!)
4. `railway.json` handles the rest: build (`api` workspace), run migrations on boot, start API.
5. One-time: run `npm run db:seed:prod` in a Railway shell to load masters/roles/org tree.

## Web (Cloudflare Pages — pending Cloudflare credentials)
`cd web && npm ci && npm run build` → deploy `web/dist` to Cloudflare Pages; set API base URL env. Assets → R2 per `docs/PHASE1_DEV_PLAN.md` §5.
