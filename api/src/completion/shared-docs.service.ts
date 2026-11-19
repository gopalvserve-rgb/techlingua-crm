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

  async list(userId: number, f: { folder_id?: string; q?: string; lead_id?: string; student_id?: string } = {}) {
    const admin = await this.isAdmin(userId);
    const params: unknown[] = [userId];
    const where = [`d.deleted_at IS NULL`];
    where.push(admin ? '$1::bigint IS NOT NULL' : this.visible('d'));
    if (f.folder_id === 'none') where.push('d.folder_id IS NULL');
    else if (f.folder_id && !f.q) { params.push(Number(f.folder_id)); where.push(`d.folder_id = $${params.length}`); }
    // a search looks inside the folder AND its sub-folders (12 Nov 2026)
    else if (f.folder_id && f.q) {
      params.push(Number(f.folder_id));
      where.push(`d.folder_id IN (WITH RECURSIVE t AS (SELECT id FROM shared_doc_folder WHERE id = $${params.length}
                    UNION ALL SELECT c.id FROM shared_doc_folder c JOIN t ON c.parent_id = t.id WHERE c.deleted_at IS NULL) SELECT id FROM t)`);
    }
    if (f.lead_id) { params.push(Number(f.lead_id)); where.push(`d.lead_id = $${params.length}`); }
    if (f.student_id) { params.push(Number(f.student_id)); where.push(`d.student_id = $${params.length}`); }
    if (f.q) { params.push(`%${String(f.q).trim()}%`); where.push(`(d.title ILIKE $${params.length} OR d.file_name ILIKE $${params.length} OR d.description ILIKE $${params.length})`); }
    const rows = await this.db.query<any>(
      `SELECT d.id, d.folder_id, fo.name AS folder_name, d.title, d.description, d.file_name, d.mime, d.size_bytes,
              d.share_scope, d.branch_id, b.name AS branch_name, d.vertical_id, v.name AS vertical_name,
              d.role_id, r.name AS role_name, d.downloads, d.uploaded_by, u.name AS uploaded_by_name, d.created_at,
              d.version_no, d.updated_at, d.lead_id, ld.full_name AS lead_name, d.student_id, st.full_name AS student_name
         FROM shared_doc d
         LEFT JOIN lead ld ON ld.id = d.lead_id
         LEFT JOIN student st ON st.id = d.student_id
         LEFT JOIN shared_doc_folder fo ON fo.id = d.folder_id
         LEFT JOIN branch b ON b.id = d.branch_id
         LEFT JOIN vertical v ON v.id = d.vertical_id
         LEFT JOIN role r ON r.id = d.role_id
         LEFT JOIN "user" u ON u.id = d.uploaded_by
        WHERE ${where.join(' AND ')}
        ORDER BY d.created_at DESC LIMIT 500`, params);
    const folders = await this.db.query<any>(
      `SELECT fo.id, fo.name, fo.parent_id, (SELECT count(*) FROM shared_doc d WHERE d.folder_id = fo.id AND d.deleted_at IS NULL) AS files,
              (SELECT count(*) FROM shared_doc_folder c WHERE c.parent_id = fo.id AND c.deleted_at IS NULL) AS subfolders
         FROM shared_doc_folder fo WHERE fo.deleted_at IS NULL ORDER BY lower(fo.name)`);
    return { rows, folders, admin };
  }

  /* ---- 12 Nov 2026: edit, move, versions, preview, sub-folders ---- */

  private async editable(id: number, userId: number) {
    const d = await this.db.one<any>(`SELECT * FROM shared_doc WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!d) throw new NotFoundException('Document not found');
    if (Number(d.uploaded_by) !== userId && !(await this.isAdmin(userId))) throw new BadRequestException('Only the person who uploaded it (or an admin) can change this document.');
    return d;
  }

  private async putFile(orgId: number, fileName: string, mime: string, bytes: Buffer): Promise<string | null> {
    if (!(await this.storage.isConfigured())) return null;
    const key = `shared-docs/${orgId}/${Date.now()}-${fileName.replace(/[^\w.-]+/g, '_')}`;
    try { await this.storage.putObject(key, bytes, mime); return key; } catch { return null; }
  }

  private decode(dto: any): { bytes: Buffer; name: string; mime: string } {
    const b64 = String(dto?.file?.base64 ?? '').replace(/^data:[^,]*,/, '');
    if (!b64) throw new BadRequestException('Choose a file to upload.');
    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length) throw new BadRequestException('The file is empty.');
    if (bytes.length > MAX_BYTES) throw new BadRequestException('Files up to 15 MB can be uploaded.');
    return { bytes, name: String(dto?.file?.name ?? 'document').slice(0, 255), mime: String(dto?.file?.mime ?? 'application/octet-stream').slice(0, 120) };
  }

  /** Replace the file, keeping the old one as a numbered version. */
  async newVersion(id: number, dto: any, actorId: number) {
    const d = await this.editable(id, actorId);
    const f = this.decode(dto);
    const key = await this.putFile(Number(d.org_id), f.name, f.mime, f.bytes);
    await this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO shared_doc_version (doc_id, version_no, file_name, mime, size_bytes, r2_key, content, note, uploaded_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, d.version_no ?? 1, d.file_name, d.mime, d.size_bytes, d.r2_key, d.r2_key ? null : d.content, dto?.note ? String(dto.note).slice(0, 300) : null,
          d.updated_by ?? d.uploaded_by, d.updated_at ?? d.created_at]);
      await c.query(
        `UPDATE shared_doc SET file_name = $2, mime = $3, size_bytes = $4, r2_key = $5, content = $6, version_no = COALESCE(version_no, 1) + 1,
                updated_at = now(), updated_by = $7 WHERE id = $1`,
        [id, f.name, f.mime, f.bytes.length, key, key ? null : f.bytes, actorId]);
    });
    return { id, version_no: Number(d.version_no ?? 1) + 1 };
  }

  async versions(id: number, userId: number) {
    await this.readable(id, userId);
    return this.db.query<any>(
      `SELECT v.id, v.version_no, v.file_name, v.size_bytes, v.note, v.created_at, v.replaced_at, u.name AS uploaded_by_name
         FROM shared_doc_version v LEFT JOIN "user" u ON u.id = v.uploaded_by WHERE v.doc_id = $1 ORDER BY v.version_no DESC`, [id]);
  }

  private async readable(id: number, userId: number) {
    const admin = await this.isAdmin(userId);
    const d = await this.db.one<any>(
      `SELECT d.* FROM shared_doc d WHERE d.id = $2 AND d.deleted_at IS NULL AND ${admin ? '$1::bigint IS NOT NULL' : this.visible('d')}`, [userId, id]);
    if (!d) throw new NotFoundException('Document not found (or not shared with you)');
    return d;
  }

  async downloadVersion(id: number, versionId: number, userId: number) {
    await this.readable(id, userId);
    const v = await this.db.one<any>(`SELECT * FROM shared_doc_version WHERE id = $1 AND doc_id = $2`, [versionId, id]);
    if (!v) throw new NotFoundException('Version not found');
    if (v.r2_key) { const o = await this.storage.getObject(String(v.r2_key)); return { file_name: String(v.file_name), mime: String(v.mime || o.contentType), content: o.body }; }
    return { file_name: String(v.file_name), mime: String(v.mime || 'application/octet-stream'), content: v.content as Buffer };
  }

  /** Inline preview of a PDF / image / text file (no download counted). */
  async preview(id: number, userId: number) {
    const d = await this.readable(id, userId);
    const mime = String(d.mime || '');
    if (!/^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/plain)/.test(mime)) throw new BadRequestException('This file type cannot be previewed — download it instead.');
    if (d.r2_key) { const o = await this.storage.getObject(String(d.r2_key)); return { file_name: String(d.file_name), mime, content: o.body }; }
    return { file_name: String(d.file_name), mime, content: d.content as Buffer };
  }

  async renameFolder(id: number, dto: any) {
    const fo = await this.db.one<any>(`SELECT * FROM shared_doc_folder WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!fo) throw new NotFoundException('Folder not found');
    let parent = dto?.parent_id === undefined ? fo.parent_id : (Number(dto.parent_id) || null);
    if (parent) {
      // never move a folder inside itself or one of its own sub-folders
      const loop = await this.db.one<any>(
        `WITH RECURSIVE t AS (SELECT id FROM shared_doc_folder WHERE id = $1 UNION ALL SELECT c.id FROM shared_doc_folder c JOIN t ON c.parent_id = t.id)
         SELECT 1 AS x FROM t WHERE id = $2`, [id, parent]);
      if (loop) throw new BadRequestException('A folder cannot go inside itself.');
    } else parent = null;
    await this.db.query(`UPDATE shared_doc_folder SET name = $2, parent_id = $3 WHERE id = $1`,
      [id, String(dto?.name ?? fo.name).trim().slice(0, 120) || fo.name, parent]);
    return { id, ok: true };
  }

  async createFolder(dto: any, actorId: number) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the folder a name.');
    return this.db.one<any>(
      `INSERT INTO shared_doc_folder (org_id, name, created_by, parent_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [await this.orgId(), name.slice(0, 120), actorId, Number(dto?.parent_id) || null]);
  }

  async deleteFolder(id: number) {
    const n = await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM shared_doc WHERE folder_id = $1 AND deleted_at IS NULL`, [id]);
    if (Number(n?.n ?? 0) > 0) throw new BadRequestException('Move or delete the files in this folder first.');
    const sub = await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM shared_doc_folder WHERE parent_id = $1 AND deleted_at IS NULL`, [id]);
    if (Number(sub?.n ?? 0) > 0) throw new BadRequestException('Delete or move the sub-folders first.');
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
                               share_scope, branch_id, vertical_id, role_id, uploaded_by, lead_id, student_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id, title, file_name, size_bytes, share_scope, created_at`,
      [orgId, Number(dto?.folder_id) || null, title.slice(0, 200), dto?.description ? String(dto.description).slice(0, 2000) : null,
        fileName, mime, bytes.length, r2Key, r2Key ? null : bytes, scope, branchId, verticalId, roleId, actorId,
        Number(dto?.lead_id) || null, Number(dto?.student_id) || null]);
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

  async update(id: number, dto: any, userId?: number) {
    const cur = userId ? await this.editable(id, userId) : await this.db.one<any>(`SELECT * FROM shared_doc WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!cur) throw new NotFoundException('Document not found');
    if (dto?.lead_id !== undefined || dto?.student_id !== undefined) {
      await this.db.query(`UPDATE shared_doc SET lead_id = $2, student_id = $3 WHERE id = $1`,
        [id, dto.lead_id === undefined ? cur.lead_id : (Number(dto.lead_id) || null), dto.student_id === undefined ? cur.student_id : (Number(dto.student_id) || null)]);
    }
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
