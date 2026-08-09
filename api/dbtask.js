const { Client } = require('pg');
const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!url) { console.error('NO DB URL in env'); process.exit(2); }
const cmd = process.argv[2] || 'snapshot';
(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = (s, p=[]) => c.query(s, p).then(r => r.rows);
  try {
    if (cmd === 'snapshot') {
      const t = ['study_material','certificate','report_card','audit_log','student','batch','assessment_test','assessment_score','attendance','coursework_assignment','coursework_submission'];
      const out = {};
      for (const tb of t) { try { out[tb] = Number((await q(`SELECT count(*)::int n FROM ${tb}`))[0].n); } catch(e){ out[tb]='ERR '+e.message; } }
      console.log('SNAPSHOT ' + JSON.stringify(out));
    } else if (cmd === 'peek') {
      console.log('MATERIALS ' + JSON.stringify(await q(`SELECT id,title,visibility,access_level FROM study_material ORDER BY id DESC LIMIT 20`)));
      console.log('CERTS ' + JSON.stringify(await q(`SELECT id,serial_no,status,student_id FROM certificate ORDER BY id DESC LIMIT 20`)));
      console.log('CARDS ' + JSON.stringify(await q(`SELECT id,term,student_id,status,share_token FROM report_card ORDER BY id DESC LIMIT 20`)));
      console.log('STUDENTS_WITH_SCORES ' + JSON.stringify(await q(`SELECT DISTINCT s.id, s.full_name, s.batch_id FROM student s JOIN assessment_score sc ON sc.student_id=s.id AND sc.deleted_at IS NULL WHERE s.deleted_at IS NULL LIMIT 10`)));
      console.log('STUDENTS_WITH_ATT ' + JSON.stringify(await q(`SELECT DISTINCT s.id, s.full_name FROM student s JOIN attendance a ON a.student_id=s.id AND a.deleted_at IS NULL WHERE s.deleted_at IS NULL LIMIT 10`)));
    } else if (cmd === 'sql') {
      console.log(JSON.stringify(await q(process.argv[3])));
    }
  } finally { await c.end(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
