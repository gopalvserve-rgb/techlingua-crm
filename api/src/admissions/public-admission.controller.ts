import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../rbac/rbac.decorators';
import { AdmissionService } from './admission.service';

/**
 * THE PUBLIC ADMISSION ENDPOINTS — the self-serve online admission form. Like the website-form
 * capture and the parent report view, these sit OUTSIDE authentication: a prospective student
 * carries no JWT. What replaces auth: an unguessable per-form key in the path, a rate limit
 * applied before any DB work, a honeypot, and India field validation — all inside the service.
 * (Allowlisted public route, reason: self-serve admission intake.)
 */
@Public()
@Controller('public/admission')
export class PublicAdmissionController {
  constructor(private readonly svc: AdmissionService) {}

  @Public() @Get(':formKey')
  form(@Param('formKey') formKey: string) { return this.svc.publicForm(formKey); }

  @Public() @Post(':formKey')
  submit(@Param('formKey') formKey: string, @Body() body: any, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    return this.svc.submitPublic(formKey, body, { ip });
  }
}
