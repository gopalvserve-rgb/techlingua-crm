import { BadRequestException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { NotConfiguredException } from '../common/not-configured.exception';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../database/database.service';
import { normalizePhone } from '../common/phone.util';
import { SMS_NOT_CONFIGURED_MSG, SmsService } from './sms.provider';

/**
 * OTP login (client update #1 — mobile-first auth).
 *
 * POST /auth/otp/request {mobile} -> 6-digit code, bcrypt-hashed in auth_otp:
 *   5-minute expiry · max 3 verify attempts · 60s resend throttle per phone.
 *   Sent via the pluggable SMS abstraction (503 while no gateway is configured).
 * POST /auth/otp/verify {mobile, code} -> JWT (issued by AuthService).
 * Every request / verify / failed attempt lands in audit_log (entity auth_otp).
 */
export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 3;
export const OTP_RESEND_THROTTLE_MS = 60 * 1000;
/** Enumeration hardening (backlog c): registered and unregistered mobiles get the
 *  SAME response shape/status — nothing in the API discloses whether a mobile
 *  belongs to an account. */
export const OTP_GENERIC_MESSAGE = 'If this mobile is registered, an OTP has been sent';

export interface OtpUser { id: number; name: string; email: string | null; phone: string; status: string }

@Injectable()
export class OtpService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sms: SmsService,
  ) {}

  private audit(actorId: number | null, event: string, detail: Record<string, unknown>) {
    return this.db
      .query(
        `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, after)
         VALUES ((SELECT id FROM organisation ORDER BY id LIMIT 1), $1, 'auth_otp', $2, 'login', $3)`,
        [actorId, actorId, JSON.stringify({ event, ...detail })],
      )
      .catch((e) => console.error('audit_log write failed:', e.message));
  }

  private async userByMobile(mobile: string): Promise<{ phone: string; user: OtpUser | null }> {
    const phone = normalizePhone(mobile);
    if (!phone || phone.replace(/\D/g, '').length < 8) throw new BadRequestException('a valid mobile number is required');
    const user = await this.db.one<OtpUser>(
      `SELECT id, name, email, phone, status FROM "user" WHERE phone = $1 AND deleted_at IS NULL`, [phone],
    );
    return { phone, user: user && user.status === 'active' ? user : null };
  }

  /** In-memory last-request marker so the 60s resend throttle behaves the SAME
   *  for unregistered mobiles (which have no auth_otp rows) as for registered
   *  ones — otherwise the throttle itself becomes an enumeration oracle. */
  private readonly lastRequestAt = new Map<string, number>(); // per-instance == per-process (Nest singleton)

  /**
   * Generate + store + send an OTP. Enumeration-hardened (backlog c):
   *  - gateway unconfigured -> 503 uniformly, REGARDLESS of registration;
   *  - gateway configured   -> generic 200 for registered AND unregistered
   *    mobiles (identical shape); the SMS only goes out to registered ones.
   *  - 60s resend throttle applies uniformly per phone.
   */
  async request(mobile: string) {
    const { phone, user } = await this.userByMobile(mobile);

    // uniform 60s resend throttle (in-memory covers unregistered phones; the
    // auth_otp check below keeps it durable across restarts for registered ones)
    const lastMem = this.lastRequestAt.get(phone);
    const last = await this.db.one<{ created_at: string }>(
      `SELECT created_at FROM auth_otp WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`, [phone],
    );
    const lastAt = Math.max(lastMem ?? 0, last ? new Date(last.created_at).getTime() : 0);
    if (lastAt && Date.now() - lastAt < OTP_RESEND_THROTTLE_MS) {
      await this.audit(user?.id ?? null, 'otp_request_throttled', { phone });
      throw new HttpException('Please wait 60 seconds before requesting another OTP', 429);
    }

    // gateway availability is decided BEFORE registration is consulted — while
    // no gateway is configured EVERY request 503s identically (no oracle), and
    // no dangling code is left behind.
    const provider = await this.sms.provider();
    if (provider.name === 'not_configured') {
      await this.audit(user?.id ?? null, 'otp_request_unavailable', { phone, reason: 'sms gateway not configured' });
      throw new NotConfiguredException(SMS_NOT_CONFIGURED_MSG);
    }

    this.lastRequestAt.set(phone, Date.now());
    if (!user) {
      // same response as the success path — do NOT reveal that the mobile is unknown
      await this.audit(null, 'otp_request_rejected', { phone, reason: 'no active user' });
      return { ok: true, message: OTP_GENERIC_MESSAGE, expires_in_sec: OTP_TTL_MS / 1000 };
    }

    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
    await provider.send(phone, `${code} is your Tech Lingua CRM login code. Valid for 5 minutes.`);
    const hash = await bcrypt.hash(code, 10);
    await this.db.query(
      `INSERT INTO auth_otp (user_id, phone, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '5 minutes')`,
      [user.id, phone, hash],
    );
    await this.audit(user.id, 'otp_requested', { phone, provider: provider.name });
    return { ok: true, message: OTP_GENERIC_MESSAGE, expires_in_sec: OTP_TTL_MS / 1000 };
  }

  /** Verify a code. Returns the user for AuthService to mint the JWT. */
  async verify(mobile: string, code: string): Promise<OtpUser> {
    if (!code?.trim()) throw new BadRequestException('mobile and code are required');
    const { phone, user } = await this.userByMobile(mobile);
    const otp = await this.db.one<{ id: string; code_hash: string; expires_at: string; attempts: number; consumed_at: string | null }>(
      `SELECT id, code_hash, expires_at, attempts, consumed_at
         FROM auth_otp WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`, [phone],
    );
    const fail = async (reason: string, bumpAttempts = false) => {
      if (bumpAttempts && otp) await this.db.query(`UPDATE auth_otp SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
      await this.audit(user?.id ?? null, 'otp_verify_failed', { phone, reason });
      throw new UnauthorizedException('Invalid or expired OTP');
    };
    if (!user || !otp) await fail('no user or no otp');
    if (otp!.consumed_at) await fail('already used');
    if (new Date(otp!.expires_at).getTime() < Date.now()) await fail('expired');
    if (otp!.attempts >= OTP_MAX_ATTEMPTS) await fail('attempt limit');
    const ok = await bcrypt.compare(code.trim(), otp!.code_hash);
    if (!ok) await fail('wrong code', true);
    await this.db.query(`UPDATE auth_otp SET consumed_at = now(), attempts = attempts + 1 WHERE id = $1`, [otp!.id]);
    await this.audit(user!.id, 'otp_verified', { phone });
    return user!;
  }
}
