import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../rbac/rbac.decorators';
import { AssessmentCertificateService } from './assessment-certificate.service';

/**
 * PUBLIC CERTIFICATE VERIFICATION — a login-free check of a certificate by its verify code.
 * Returns only the minimal fields (valid/invalid + student, assessment, grade, issued-on, revoked
 * status). No auth, no listing, no enumeration beyond a single opaque code lookup — the same shape
 * as the public report-card view. Rate-limited by the global throttler like other public routes.
 */
@Public()
@Controller('public/verify/certificate')
export class PublicCertificateController {
  constructor(private readonly svc: AssessmentCertificateService) {}

  @Public()
  @Get(':code')
  verify(@Param('code') code: string) { return this.svc.verify(code); }
}
