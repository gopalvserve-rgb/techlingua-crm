import { BadRequestException, Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { CurrentUser, Public } from '../rbac/rbac.decorators';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly otp: OtpService,
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

  @Get('me')
  me(@CurrentUser() user: { id: number }) {
    return this.auth.me(user.id);
  }
}
