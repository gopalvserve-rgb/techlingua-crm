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
    // dev/106 — Course Type is now a self-manageable master (m_course_type, migration 095). This
    // endpoint stays as a BACK-COMPAT alias so existing callers (RefData `courseTypes`, the course
    // form dropdown, the Course list Course Type filter) keep working unchanged: it returns
    // code == label == name (the value stored in m_course.meta->>'course_type'), active values only,
    // and now reflects whatever the client has added/edited/deactivated in Administration > Masters.
    return this.db.query(
      `SELECT name AS code, name AS label, sort_order AS ordering
         FROM m_course_type WHERE deleted_at IS NULL AND is_active
        ORDER BY sort_order, name`,
    );
  }
  levelCatalog() {
    // dev/114 — Level is now a self-manageable master (m_level, migration 097). This endpoint
    // stays as a BACK-COMPAT alias so existing callers (RefData `courseLevels`, the course form's
    // Level picker) keep working unchanged: it returns code == label == name (the value stored in
    // course_level.code / m_course.meta->>'level'), active values only, and now reflects whatever
    // the client has added/edited/deactivated in Administration > Masters.
    return this.db.query(
      `SELECT name AS code, name AS label, sort_order AS ordering
         FROM m_level WHERE deleted_at IS NULL AND is_active
        ORDER BY sort_order, name`,
    );
  }
  deliveryCatalog() {
    return this.db.query(`SELECT code, label, ordering FROM course_delivery_def ORDER BY ordering, code`);
  }
}
