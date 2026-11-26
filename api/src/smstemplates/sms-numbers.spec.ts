/**
 * FB-2026-004 (client, 23 Nov 2026) — SMS templates: "Counsellor's phone — where does it come from? That
 * is the login number." and "Call-back number (vertical) is our support number — give another number".
 */
import { SmsTemplateService } from './sms-template.service';
import { UsersService } from '../users/users.service';
import { BadRequestException } from '@nestjs/common';

function build(row: Record<string, unknown>) {
  const sqls: string[] = [];
  const db = {
    one: async (sql: string) => { sqls.push(sql.replace(/\s+/g, ' ')); return /FROM lead l/.test(sql) ? row : null; },
    query: async () => [],
  } as any;
  return { svc: new SmsTemplateService(db, {} as any, {} as any), sqls };
}

const BASE = { id: 1, full_name: 'Riya Sharma', phone: '+919811111111', counsellor: 'Asha', branch_phone: '+911100000000' };

describe('SMS numbers (FB-2026-004)', () => {
  it("Counsellor's number: the user's contact number, else the login mobile (decided in SQL)", async () => {
    const { svc, sqls } = build({ ...BASE, counsellor_phone: '+919800000001' });
    const out = await svc.varsForLead(1);
    expect(sqls[0]).toContain("COALESCE(NULLIF(u.contact_phone, ''), u.phone) AS counsellor_phone");
    expect(out!.vars.counsellor_phone).toBe('+919800000001');
  });

  it('Call-back number: the vertical call-back number when set …', async () => {
    const { svc } = build({ ...BASE, counsellor_phone: '+919800000001', vertical_callback: '+918506000000', vertical_phone: '+918506067041' });
    expect((await svc.varsForLead(1))!.vars.callback).toBe('+918506000000');
  });

  it('… else the vertical phone (support number), as before', async () => {
    const { svc } = build({ ...BASE, counsellor_phone: '+919800000001', vertical_callback: null, vertical_phone: '+918506067041' });
    expect((await svc.varsForLead(1))!.vars.callback).toBe('+918506067041');
  });

  it('a contact number must look like a phone number; empty clears it', () => {
    expect(UsersService.contactPhone('  +91 98110 00000 ')).toBe('+91 98110 00000');
    expect(UsersService.contactPhone('')).toBeNull();
    expect(UsersService.contactPhone(null)).toBeNull();
    expect(() => UsersService.contactPhone('12')).toThrow(BadRequestException);
  });
});
