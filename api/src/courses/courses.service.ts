import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * Course catalogs (client feedback #13) — the seeded dropdown sets behind the Course master's
 * Course Type / Course Level / Delivery Mode fields. Mirrors the batch_type_def / batches
 * type-catalog pattern (migration 082 seeds `course_type_def`, `course_level_def`,
 * `course_delivery_def`; code == label, human-readable). A course stores the picked value as text
 * in m_course.meta (course_type / level / delivery_mode), consistent with fee / vertical_id.
 */
@Injectable()
export class CoursesService {
  constructor(private readonly db: DatabaseService) {}

  typeCatalog() {
    return this.db.query(`SELECT code, label, ordering FROM course_type_def ORDER BY ordering, code`);
  }
  levelCatalog() {
    return this.db.query(`SELECT code, label, ordering FROM course_level_def ORDER BY ordering, code`);
  }
  deliveryCatalog() {
    return this.db.query(`SELECT code, label, ordering FROM course_delivery_def ORDER BY ordering, code`);
  }
}
