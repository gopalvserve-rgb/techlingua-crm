import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../database/database.service';
import { MessagingService } from '../messaging/messaging.service';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { missingRequirements } from '../messaging/providers';
import { randomToken, safeEqual, sha256Hex } from '../common/crypto.util';
import { config } from '../config';

/**
 * FORGOT PASSWORD / RESET (client-reported gap — the feature did not exist).
 *
 * POST /auth/forgot-password {email, mobile?} -> ALWAYS a generic 200. If the
 *   address belongs to an active user we mint a cryptographically-random token,
 *   store only its SHA-256 HASH with a 30-minute expiry (single-use), and email
 *   a reset link through the EXISTING SMTP send path (MessagingService). If it
 *   does not, we do exactly the same-shaped nothing — the response never reveals
 *   whether an account exists (enumeration-safe, like the OTP flow).
 *
 * POST /auth/reset-password {token, new_password} -> validate (exists, not
 *   expired, not used), set the new bcrypt hash the same way login reads it,
 *   mark the token used, and invalidate every OTHER outstanding token for that
 *   user.
 *
 * SMTP CHOICE. A password reset is NOT lead-scoped, so it has no vertical. It
 * uses the SYSTEM (org-wide) SMTP row — channel_config(channel='email',
 * vertical_id IS NULL) — and, if the org only configured per-vertical SMTP,
 * falls back to the org's primary (first-configured) vertical SMTP. Either way
 * it is settings-driven: the day Gopal saves SMTP in Settings the email sends,
 * with no code change.
 *
 * SMTP-GATED, DEGRADE CLEANLY. With no SMTP configured (the state today) the
 * endpoint MUST NOT 500. The token is still created; the send is attempted
 * through MessagingService, which records the real reason on the send log
 * (message_log, not_configured=TRUE, no Error-Log noise) — and the user still
 * gets the generic 200. An admin sees "email not configured" in the send log.
 */

/** Reset links live for 30 minutes — long enough to act on an email, short
 *  enough that a leaked link is stale fast. */
export const RESET_TTL_MS = 30 * 60 * 1000;
/** The one message both a real and an unknown email get back. Nothing here
 *  discloses whether the account exists. */
export const RESET_GENERIC_MESSAGE =
  'If an account exists for that address, a password reset link has been sent.';
/** Minimum strength the API enforces (the UI enforces the same before submit). */
export const MIN_PASSWORD_LENGTH = 8;

/** Fixed-window limiter — the SAME shape as ingestion/channels/rate-limit.util.ts,
 *  inlined here so auth carries no dependency on the capture-channel module. In-process
 *  by design (single api replica today); swap for Redis INCR/EXPIRE if ever scaled out. */
class ForgotRateLimiter {
  private readonly hits = new Map<string, { n: number; resetAt: number }>();
  allow(key: string, limit: number, windowMs = 60_000, now = Date.now()): boolean {
    if (limit <= 0) return true;
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { n: 1, resetAt: now + windowMs });
      if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      return true;
    }
    cur.n += 1;
    return cur.n <= limit;
  }
}

interface UserRow { id: string; name: string; email: string | null; phone: string; status: string }

@Injectable()
export class PasswordResetService {
  private readonly log = new Logger('PasswordReset');
  private readonly limiter = new ForgotRateLimiter();

  constructor(
    private readonly db: DatabaseService,
    private readonly messaging: MessagingService,
    private readonly configs: ChannelConfigService,
  ) {}

  private audit(userId: number | null, event: string, detail: Record<string, unknown>) {
    return this.db
      .query(
        `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, after)
         VALUES ((SELECT id FROM organisation ORDER BY id LIMIT 1), $1, 'password_reset', $2, 'reset', $3)`,
        [userId, userId, JSON.stringify({ event, ...detail })],
      )
      .catch((e) => console.error('audit_log write failed:', e.message));
  }

  /** Look up an ACTIVE user by email (case-insensitive) or, if given, mobile. */
  private async findUser(email?: string | null, mobile?: string | null): Promise<UserRow | null> {
    const id = (email ?? '').trim();
    if (id) {
      const u = await this.db.one<UserRow>(
        `SELECT id, name, email, phone, status FROM "user"
          WHERE lower(email) = lower($1) AND deleted_at IS NULL`, [id],
      );
      if (u) return u.status === 'active' ? u : null;
    }
    const m = (mobile ?? '').trim();
    if (m) {
      const u = await this.db.one<UserRow>(
        `SELECT id, name, email, phone, status FROM "user"
          WHERE phone = $1 AND deleted_at IS NULL`, [m],
      );
      if (u) return u.status === 'active' ? u : null;
    }
    return null;
  }

  /**
   * Which vertical's SMTP does a (non-lead) password reset use?
   *   null   -> the org-wide/system SMTP row (channel_config email, vertical_id IS NULL);
   *   number -> the org's primary (first-configured) vertical SMTP, if no system row exists;
   *   undefined stays null so `deliver()` still records a clean "not configured".
   * Returns the vertical_id to stamp on the queued email.
   */
  private async emailVerticalId(): Promise<number | null> {
    // 1) system/org-wide SMTP
    const sys = await this.configs.resolve('email', null);
    if (sys && missingRequirements(sys.provider, sys.config, Object.keys(sys.secrets)).length === 0) return null;
    // 2) primary vertical SMTP (first configured), so it still works if only per-vertical
    //    SMTP was set up
    const rows = await this.configs.list('email');
    for (const r of rows as Array<{ vertical_id: number | null; status: string }>) {
      if (r.status === 'connected' && r.vertical_id != null) return Number(r.vertical_id);
    }
    return null; // nothing configured -> deliver() will record the reason, no 500
  }

  private resetLink(origin: string | undefined, token: string): string {
    const base = (origin || config.webOrigin || '').replace(/\/+$/, '');
    return `${base}/reset-password?token=${encodeURIComponent(token)}`;
  }

  /**
   * Request a reset. Enumeration-safe: identical generic 200 for a real and an
   * unknown address. Rate-limited per IP and per email to blunt abuse.
   */
  async requestReset(email: string | undefined, mobile: string | undefined, ip: string, origin?: string) {
    const addr = (email ?? '').trim();
    const mob = (mobile ?? '').trim();
    if (!addr && !mob) throw new BadRequestException('email (or mobile) is required');

    // rate limit BEFORE any user lookup, so the limiter itself is not an oracle
    const okIp = this.limiter.allow(`fp:ip:${ip}`, 10, 15 * 60_000);
    const okKey = this.limiter.allow(`fp:key:${(addr || mob).toLowerCase()}`, 5, 15 * 60_000);
    if (!okIp || !okKey) {
      await this.audit(null, 'forgot_throttled', { ip });
      throw new HttpException('Too many reset requests — please try again later.', 429);
    }

    const user = await this.findUser(addr, mob);
    if (!user) {
      // same-shaped nothing — never reveal that the address is unknown
      await this.audit(null, 'forgot_unknown', { email: addr || null });
      return { ok: true, message: RESET_GENERIC_MESSAGE };
    }

    // mint a token; store ONLY its hash; 30-minute single-use expiry
    const token = randomToken(32);
    const tokenHash = sha256Hex(token);
    await this.db.query(
      `INSERT INTO password_reset (org_id, user_id, token_hash, expires_at, request_ip)
       VALUES ((SELECT id FROM organisation ORDER BY id LIMIT 1), $1, $2, now() + interval '30 minutes', $3)`,
      [user.id, tokenHash, ip ? String(ip).slice(0, 64) : null],
    );

    if (!user.email) {
      // an account with no email address cannot be emailed — recorded, still generic 200
      await this.audit(Number(user.id), 'forgot_no_email', {});
      return { ok: true, message: RESET_GENERIC_MESSAGE };
    }

    const link = this.resetLink(origin, token);
    const verticalId = await this.emailVerticalId();
    const body =
      `<p>Hello ${user.name || ''},</p>` +
      `<p>We received a request to reset the password for your Tech Lingua CRM account.</p>` +
      `<p><a href="${link}">Click here to set a new password</a>. This link is valid for 30 minutes and can be used once.</p>` +
      `<p>If you did not request this, you can safely ignore this email — your password will not change.</p>` +
      `<p>— Tech Lingua CRM</p>`;

    // Reuse the existing per-vertical/system SMTP send path. sendNow NEVER throws for a
    // credential/SMTP problem — deliver() writes the reason to the send log (message_log)
    // and flags not_configured, so the Error Log stays clean and the user still gets 200.
    let outcome = 'unknown';
    let reason: string | undefined;
    try {
      const out = await this.messaging.sendNow({
        channel: 'email',
        to: user.email,
        subject: 'Reset your Tech Lingua CRM password',
        body,
        vertical_id: verticalId,
        actor_id: null,
        guarded: false,
      });
      outcome = out.status;
      reason = out.reason;
    } catch (e) {
      // belt-and-suspenders: even an unexpected throw must not 500 this endpoint
      outcome = 'error';
      reason = (e as Error).message;
      this.log.warn(`reset email send raised: ${reason}`);
    }
    // NEVER log the token or the link. Record only the outcome + reason (e.g. "email not
    // configured") so an admin can see why nothing arrived.
    await this.audit(Number(user.id), 'forgot_sent', { outcome, reason: reason ?? null });
    return { ok: true, message: RESET_GENERIC_MESSAGE };
  }

  /**
   * Complete a reset. Validates the token (exists, not expired, not used) with a
   * constant-time compare, sets the new password (bcrypt, as login reads it),
   * marks the token used and invalidates every other outstanding token for the user.
   */
  async performReset(token: string, newPassword: string) {
    const t = (token ?? '').trim();
    const pw = String(newPassword ?? '');
    if (!t) throw new BadRequestException('token is required');
    if (pw.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const tokenHash = sha256Hex(t);
    const row = await this.db.one<{ id: string; user_id: string; token_hash: string; expires_at: string; used_at: string | null }>(
      `SELECT id, user_id, token_hash, expires_at, used_at
         FROM password_reset WHERE token_hash = $1 LIMIT 1`, [tokenHash],
    );
    // Constant-time compare guards against a (theoretical) timing side channel on the hash
    // even though the SELECT already matched it exactly.
    const invalid = () => new BadRequestException('This reset link is invalid or has expired. Please request a new one.');
    if (!row || !safeEqual(row.token_hash, tokenHash)) {
      await this.audit(null, 'reset_rejected', { reason: 'unknown token' });
      throw invalid();
    }
    if (row.used_at) {
      await this.audit(Number(row.user_id), 'reset_rejected', { reason: 'already used' });
      throw invalid();
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await this.audit(Number(row.user_id), 'reset_rejected', { reason: 'expired' });
      throw invalid();
    }

    const hash = await bcrypt.hash(pw, 10);
    await this.db.tx(async (client) => {
      await client.query(`UPDATE "user" SET password_hash = $2, updated_at = now() WHERE id = $1`, [row.user_id, hash]);
      await client.query(`UPDATE password_reset SET used_at = now() WHERE id = $1`, [row.id]);
      // single-use for THIS user: any other outstanding token is spent too, so an
      // attacker holding an earlier link cannot reuse it after a reset.
      await client.query(
        `UPDATE password_reset SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [row.user_id],
      );
    });
    await this.audit(Number(row.user_id), 'reset_done', {});
    // NOTE: sessions are stateless JWTs (no server-side store / token version), so existing
    // tokens cannot be revoked without a guard change — documented in docs/dev/14. New
    // logins use the new password; old JWTs expire within JWT_EXPIRES_IN (8h).
    return { ok: true, message: 'Your password has been reset. Please sign in with your new password.' };
  }
}
