import * as dotenv from 'dotenv';
dotenv.config();

/** Central, typed env config. No secrets in code — see .env.example. */
export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/techlingua_crm',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@techlingua.in',
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe@123',
};
