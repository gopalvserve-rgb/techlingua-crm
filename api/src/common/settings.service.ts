import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * ONE place that reads/writes the `app_setting` key/value store.
 *
 * Everything the client must be able to change without a deploy lives here:
 * score bands, the escalation policy, notification channels, calendar sync,
 * the hand-out guardrail, the SMS provider. Callers always pass a default, so a
 * missing row is never an error — the feature just runs on its documented default.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly db: DatabaseService) {}

  async get<T extends Record<string, unknown>>(key: string, fallback: T): Promise<T> {
    const row = await this.db.one<{ value: unknown }>(`SELECT value FROM app_setting WHERE key = $1`, [key]);
    const v = row?.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fallback;
    // shallow-merge over the default so a partially-filled row never loses a key
    return { ...fallback, ...(v as Record<string, unknown>) } as T;
  }

  async set(key: string, value: Record<string, unknown>, actorId?: number): Promise<void> {
    await this.db.query(
      `INSERT INTO app_setting (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), actorId ?? null],
    );
  }
}
