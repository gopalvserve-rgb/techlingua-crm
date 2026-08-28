import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * DOCUMENT TEMPLATE SETUP (dev/143 item 5, migration 116) — Administration › Template Setup.
 * One row per template TYPE; `settings` is a JSON blob the relevant generator reads. Generators
 * consume it non-destructively (a missing/blank field falls back to the built-in default).
 * NOTE: distinct from the message-template module (src/templates) — this is document/ID formats.
 */
export const DOC_TEMPLATE_TYPES = [
  'fee_invoice', 'fee_receipt', 'student_id', 'employee_id', 'quotation', 'certificate', 'marksheet',
] as const;
export type DocTemplateType = (typeof DOC_TEMPLATE_TYPES)[number];

const TYPE_LABELS: Record<string, string> = {
  fee_invoice: 'Fee Invoice', fee_receipt: 'Fee Receipt', student_id: 'Student ID',
  employee_id: 'Employee ID', quotation: 'Quotation', certificate: 'Certificate', marksheet: 'Marksheet',
};

const DEFAULT_SETTINGS: Record<string, Record<string, unknown>> = {
  fee_invoice: { header_title: 'Fee Invoice (Tax Invoice)', show_logo: true, footer_text: '', terms: 'Fees once paid are non-refundable except per the refund policy.', fields: { gstin: true, place_of_supply: true, hsn_sac: true } },
  fee_receipt: { header_title: 'Fee Receipt', show_logo: true, footer_text: 'Thank you for your payment.', terms: '', fields: { mode: true, reference: true, balance: true } },
  student_id: { header_title: 'Student Identity Card', show_logo: true, footer_text: '', id_format: '<CENTRE>-<YYYY>-<NNN>', fields: { photo: true, blood_group: true, valid_until: true } },
  employee_id: { header_title: 'Employee Identity Card', show_logo: true, footer_text: '', id_format: 'EMP-<NNNN>', fields: { photo: true, department: true, designation: true } },
  quotation: { header_title: 'Quotation', show_logo: true, footer_text: '', terms: 'This quotation is valid for 15 days from the date of issue.', fields: { validity: true, payment_plan: true } },
  certificate: { header_title: 'Certificate of Completion', show_logo: true, footer_text: '', terms: '', fields: { serial_no: true, issue_date: true, signatory: true } },
  marksheet: { header_title: 'Statement of Marks', show_logo: true, footer_text: '', terms: '', fields: { grade: true, percentage: true, result: true } },
};

export interface DocTemplateOverrides {
  header_title?: string | null;
  show_logo?: boolean | null;
  footer_text?: string | null;
  terms?: string | null;
  id_format?: string | null;
}

@Injectable()
export class DocTemplateService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const o = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(o!.id);
  }

  private async ensureSeeded(orgId: number): Promise<void> {
    for (const type of DOC_TEMPLATE_TYPES) {
      await this.db.query(
        `INSERT INTO document_template (org_id, type, name, settings)
         VALUES ($1::bigint, $2, $3, $4::jsonb)
         ON CONFLICT (org_id, type) DO NOTHING`,
        [orgId, type, TYPE_LABELS[type], JSON.stringify(DEFAULT_SETTINGS[type] ?? {})],
      );
    }
  }

  async list() {
    const orgId = await this.orgId();
    await this.ensureSeeded(orgId);
    const rows = await this.db.query<any>(
      `SELECT dt.id, dt.type, dt.name, dt.settings, dt.is_active, dt.updated_at,
              u.name AS updated_by_name
         FROM document_template dt
         LEFT JOIN "user" u ON u.id = dt.updated_by
        WHERE dt.org_id = $1::bigint
        ORDER BY dt.id`,
      [orgId],
    );
    const order = new Map(DOC_TEMPLATE_TYPES.map((t, i) => [t, i]));
    return rows.sort((a, b) => (order.get(a.type) ?? 99) - (order.get(b.type) ?? 99));
  }

  async get(type: string) {
    if (!(DOC_TEMPLATE_TYPES as readonly string[]).includes(type)) throw new BadRequestException('Unknown template type.');
    const orgId = await this.orgId();
    await this.ensureSeeded(orgId);
    const r = await this.db.one<any>(
      `SELECT id, type, name, settings, is_active, updated_at FROM document_template
        WHERE org_id = $1::bigint AND type = $2`, [orgId, type]);
    if (!r) throw new NotFoundException(`Template "${type}" not found.`);
    return r;
  }

  async update(type: string, dto: { name?: string; settings?: Record<string, unknown>; is_active?: boolean }, userId: number) {
    if (!(DOC_TEMPLATE_TYPES as readonly string[]).includes(type)) throw new BadRequestException('Unknown template type.');
    const orgId = await this.orgId();
    await this.ensureSeeded(orgId);
    const settings = dto?.settings && typeof dto.settings === 'object' ? dto.settings : undefined;
    const rows = await this.db.query<any>(
      `UPDATE document_template
          SET name = COALESCE($3, name),
              settings = COALESCE($4::jsonb, settings),
              is_active = COALESCE($5, is_active),
              updated_by = $6::bigint, updated_at = now()
        WHERE org_id = $1::bigint AND type = $2
        RETURNING id, type, name, settings, is_active, updated_at`,
      [orgId, type, dto?.name ?? null, settings ? JSON.stringify(settings) : null,
        dto?.is_active ?? null, userId],
    );
    if (!rows.length) throw new NotFoundException(`Template "${type}" not found.`);
    return rows[0];
  }

  /** Overrides a generator consumes. NEVER throws — a missing row returns {} (built-in defaults). */
  async overridesFor(type: string): Promise<DocTemplateOverrides> {
    try {
      const orgId = await this.orgId();
      const r = await this.db.one<any>(
        `SELECT settings FROM document_template WHERE org_id = $1::bigint AND type = $2 AND is_active`,
        [orgId, type]);
      const s = (r?.settings ?? {}) as Record<string, unknown>;
      return {
        header_title: typeof s.header_title === 'string' ? s.header_title : null,
        show_logo: typeof s.show_logo === 'boolean' ? s.show_logo : null,
        footer_text: typeof s.footer_text === 'string' ? s.footer_text : null,
        terms: typeof s.terms === 'string' ? s.terms : null,
        id_format: typeof s.id_format === 'string' ? s.id_format : null,
      };
    } catch {
      return {};
    }
  }
}
