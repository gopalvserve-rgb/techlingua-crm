import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';

const MAX_BYTES = 15 * 1024 * 1024;

/**
 * SHARED DOCUMENTS (client, Oct 2026 — was a "Phase 2" placeholder). A document library:
 * folders, files (Cloudflare R2 when configured, else stored in the database), shared with
 * everyone / a branch / a vertical / a role. A user sees a document when its share target
 * matches one of their role assignments; a holder of shared_doc.delete (admins) sees all.
 */
@Injectable()
export class SharedDocsService {
  constructor(private readonly db: DatabaseService, private readonly storage: StorageService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r!.id);
  }

  private async isAdmin(userId: number): Promise<boolean> {
    const r = await this.db.one(
      `SELECT 1 FROM user_assignment ua JOIN role_permission rp ON rp.role_id = ua.role_id
         JOIN permission p ON p.id = rp.permission_id
        WHERE ua.user_id = $1 AND ua.is_active AND p.key = 'shared_doc.delete' LIMIT 1`, [userId]);
    return !!r;
  }

  /** SQL that keeps only documents shared with `userId` (param $1). */
  private visible(alias = 'd') {
    return `(${alias}.share_scope = 'all'
      OR ${alias}.uploaded_by = $1
      OR EXISTS (SELECT 1 FROM user_assignment ua WHERE ua.user_id = $1 AND ua.is_active AND (
           (${alias}.share_scope = 'branch' AND ua.branch_id = ${alias}.branch_id)
        OR (${alias}.share_scope = 'vertical' AND ua.vertical_id = ${alias}.vertical_id)
        OR (${alias}.share_scope = 'role' AND ua.role_id = ${alias}.role_id))))`;
  }

  async list(userId: number, f: { folder_id?: string; q?: string } = {}) {
    const admin = await this.isAdmin(userId);
    const params: unknown[] = [userId];
    const where = [`d.deleted_at IS NULL`];
    where.push(admin ? '$1::bigint IS NOT NULL' : this.visible('d'));
    if (f.folder_id === 'none') where.push('d.folder_id IS NULL');
    else if (f.folder_id) { params.push(Number(f.folder_id)); where.push(`d.folder_id = $${params.length}`); }
    if (f.q) { params.push(`%${String(f.q).trim()}%`); where.push(`(d.title ILIKE $${params.length} OR d.file_name ILIKE $${params.length} OR d.description ILIKE $${params.length})`); }
    const rows = await this.db.query<any>(
      `SELECT d.id, d.folder_id, fo.name AS folder_name, d.title, d.description, d.file_name, d.mime, d.size_bytes,
              d.share_scope, d.branch_id, b.name AS branch_name, d.vertical_id, v.name AS vertical_name,
              d.role_id, r.name AS role_name, d.downloads, d.uploaded_by, u.name AS uploaded_by_name, d.created_at
         FROM shared_doc d
         LEFT JOIN shared_doc_folder fo ON fo.id = d.folder_id
         LEFT JOIN branch b ON b.id = d.branch_id
         LEFT JOIN vertical v ON v.id = d.vertical_id
         LEFT JOIN role r ON r.id = d.role_id
         LEFT JOIN "user" u ON u.id = d.uploaded_by
        WHERE ${where.join(' AND ')}
        ORDER BY d.created_at DESC LIMIT 500`, params);
    const folders = await this.db.query<any>(
      `SELECT fo.id, fo.name, (SELECT count(*) FROM shared_doc d WHERE d.folder_id = fo.id AND d.deleted_at IS NULL) AS files
         FROM shared_doc_folder fo WHERE fo.deleted_at IS NULL ORDER BY lower(fo.name)`);
    return { rows, folders, admin };
  }

  async createFolder(dto: any, actorId: number) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the folder a name.');
    return this.db.one<any>(
      `INSERT INTO shared_doc_folder (org_id, name, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [await this.orgId(), name.slice(0, 120), actorId]);
  }

  async deleteFolder(id: number) {
    const n = await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM shared_doc WHERE folder_id = $1 AND deleted_at IS NULL`, [id]);
    if (Number(n?.n ?? 0) > 0) throw new BadRequestException('Move or delete the files in this folder first.');
    await this.db.query(`UPDATE shared_doc_folder SET deleted_at = now() WHERE id = $1`, [id]);
    return { id, deleted: true };
  }

  /** Upload: { title, description?, folder_id?, share_scope, branch_id?, vertical_id?, role_id?, file: { name, mime, base64 } } */
  async upload(dto: any, actorId: number) {
    const title = String(dto?.title ?? dto?.file?.name ?? '').trim();
    if (!title) throw new BadRequestException('Give the document a title.');
    const b64 = String(dto?.file?.base64 ?? '').replace(/^data:[^,]*,/, '');
    if (!b64) throw new BadRequestException('Choose a file to upload.');
    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length) throw new BadRequestException('The file is empty.');
    if (bytes.length > MAX_BYTES) throw new BadRequestException('Files up to 15 MB can be uploaded.');
    const scope = ['all', 'branch', 'vertical', 'role'].includes(String(dto?.share_scope)) ? String(dto.share_scope) : 'all';
    const branchId = scope === 'branch' ? Number(dto?.branch_id) || null : null;
    const verticalId = scope === 'vertical' ? Number(dto?.vertical_id) || null : null;
    const roleId = scope === 'role' ? Number(dto?.role_id) || null : null;
    if (scope === 'branch' && !branchId) throw new BadRequestException('Pick the branch to share with.');
    if (scope === 'vertical' && !verticalId) throw new BadRequestException('Pick the vertical to share with.');
    if (scope === 'role' && !roleId) throw new BadRequestException('Pick the role to share with.');
    const fileName = String(dto?.file?.name ?? 'document').slice(0, 255);
    const mime = String(dto?.file?.mime ?? 'application/octet-stream').slice(0, 120);
    const orgId = await this.orgId();
    let r2Key: string | null = null;
    if (await this.storage.isConfigured()) {
      r2Key = `shared-docs/${orgId}/${Date.now()}-${fileName.replace(/[^\w.-]+/g, '_')}`;
      try { await this.storage.putObject(r2Key, bytes, mime); } catch { r2Key = null; }
    }
    return this.db.one<any>(
      `INSERT INTO shared_doc (org_id, folder_id, title, description, file_name, mime, size_bytes, r2_key, content,
                               share_scope, branch_id, vertical_id, role_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, title, file_name, size_bytes, share_scope, created_at`,
      [orgId, Number(dto?.folder_id) || null, title.slice(0, 200), dto?.description ? String(dto.description).slice(0, 2000) : null,
        fileName, mime, bytes.length, r2Key, r2Key ? null : bytes, scope, branchId, verticalId, roleId, actorId]);
  }

  async download(id: number, userId: number) {
    const admin = await this.isAdmin(userId);
    const d = await this.db.one<any>(
      `SELECT d.* FROM shared_doc d WHERE d.id = $2 AND d.deleted_at IS NULL AND ${admin ? '$1::bigint IS NOT NULL' : this.visible('d')}`,
      [userId, id]);
    if (!d) throw new NotFoundException('Document not found (or not shared with you)');
    await this.db.query(`UPDATE shared_doc SET downloads = downloads + 1 WHERE id = $1`, [id]);
    if (d.r2_key) {
      const o = await this.storage.getObject(String(d.r2_key));
      return { file_name: String(d.file_name), mime: String(d.mime || o.contentType), content: o.body };
    }
    return { file_name: String(d.file_name), mime: String(d.mime || 'application/octet-stream'), content: d.content as Buffer };
  }

  async update(id: number, dto: any) {
    const cur = await this.db.one<any>(`SELECT * FROM shared_doc WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!cur) throw new NotFoundException('Document not found');
    const scope = ['all', 'branch', 'vertical', 'role'].includes(String(dto?.share_scope)) ? String(dto.share_scope) : cur.share_scope;
    await this.db.query(
      `UPDATE shared_doc SET title = $2, description = $3, folder_id = $4, share_scope = $5,
              branch_id = $6, vertical_id = $7, role_id = $8 WHERE id = $1`,
      [id, String(dto?.title ?? cur.title).slice(0, 200), dto?.description === undefined ? cur.description : dto.description,
        dto?.folder_id === undefined ? cur.folder_id : (Number(dto.folder_id) || null), scope,
        scope === 'branch' ? Number(dto?.branch_id ?? cur.branch_id) || null : null,
        scope === 'vertical' ? Number(dto?.vertical_id ?? cur.vertical_id) || null : null,
        scope === 'role' ? Number(dto?.role_id ?? cur.role_id) || null : null]);
    return { id, ok: true };
  }

  async remove(id: number, actorId: number) {
    await this.db.query(`UPDATE shared_doc SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, actorId]);
    return { id, deleted: true };
  }
}
