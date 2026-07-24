import { BadRequestException, Body, Controller, Get, HttpCode, Ip, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { PasswordResetService } from './password-reset.service';
import { CurrentUser, Public } from '../rbac/rbac.decorators';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly otp: OtpService,
    private readonly reset: PasswordResetService,
  ) {}

  /** identifier = mobile OR email; `email` kept for backward compatibility. */
  @Public()
  @Post('login')
  async login(@Body() body: { identifier?: string; email?: string; password?: string }) {
    const identifier = body?.identifier?.trim() || body?.email?.trim();
    if (!identifier || !body?.password) {
      throw new BadRequestException('identifier (mobile or email) and password are required');
    }
    return this.auth.login(identifier, body.password);
  }

  /** OTP login step 1: send a 6-digit code to a registered mobile (60s throttle). */
  @Public()
  @Post('otp/request')
  @HttpCode(200)
  otpRequest(@Body() body: { mobile?: string }) {
    if (!body?.mobile?.trim()) throw new BadRequestException('mobile is required');
    return this.otp.request(body.mobile.trim());
  }

  /** OTP login step 2: verify the code -> JWT (same shape as password login). */
  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  async otpVerify(@Body() body: { mobile?: string; code?: string }) {
    if (!body?.mobile?.trim() || !body?.code?.trim()) {
      throw new BadRequestException('mobile and code are required');
    }
    const user = await this.otp.verify(body.mobile.trim(), body.code.trim());
    return this.auth.issueToken({ id: Number(user.id), name: user.name, email: user.email });
  }

  /**
   * Forgot password step 1 — request a reset link by email (mobile optional).
   * ALWAYS a generic 200 (enumeration-safe); the email only goes out to a real,
   * active account, through the existing SMTP send path. Rate-limited per IP/email.
   */
  @Public()
  @Post('forgot-password')
  @HttpCode(200)
  forgotPassword(@Body() body: { email?: string; mobile?: string }, @Ip() ip: string, @Req() req: Request) {
    if (!body?.email?.trim() && !body?.mobile?.trim()) {
      throw new BadRequestException('email (or mobile) is required');
    }
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const origin = host ? `${proto}://${host}` : undefined;
    return this.reset.requestReset(body?.email, body?.mobile, ip, origin);
  }

  /** Forgot password step 2 — set a new password with a valid, unexpired, unused token. */
  @Public()
  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body() body: { token?: string; new_password?: string }) {
    if (!body?.token?.trim() || !body?.new_password) {
      throw new BadRequestException('token and new_password are required');
    }
    return this.reset.performReset(body.token.trim(), body.new_password);
  }

  @Get('me')
  me(@CurrentUser() user: { id: number }) {
    return this.auth.me(user.id);
  }
}
