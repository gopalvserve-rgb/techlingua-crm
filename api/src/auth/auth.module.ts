import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { SmsService } from './sms.provider';
import { AuthController } from './auth.controller';
import { config } from '../config';
import { MessagingModule } from '../messaging/messaging.module';

@Module({
  imports: [
    // Sprint 4: OTP login now resolves its gateway from the SAME `channel_config` row as
    // bulk SMS — one set of credentials, one send log. (See auth/sms.provider.ts.)
    MessagingModule,
    JwtModule.register({
      global: true,
      secret: config.jwtSecret,
      signOptions: { expiresIn: config.jwtExpiresIn },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, OtpService, SmsService],
})
export class AuthModule {}
