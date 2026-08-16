-- 090_roll_number_renumber_fix.sql — fix duplicate Roll Numbers.
-- Migration 089 renumbered PRE-EXISTING student_vertical_id rows (dev/79 backfill, old
-- SID-YYYY-YY/NNNN format) AND inserted new home-vertical rows in TWO independent numbering
-- passes, so two rows in the same vertical-code sequence could land on the same NNN.
-- FIX: renumber EVERY student_vertical_id row in ONE deterministic pass per (vertical CODE,
-- IST year) — ordered by issued_at then id — so each vertical-code sequence is gap-free and
-- collision-free, then reseed the 'roll' counter to continue past the max. Idempotent: safe to
-- run on a DB that is already correct (it just re-derives the same numbers). Runs on fresh DBs
-- too (089 hits the same two-pass overlap there, so this normalises both).
WITH numbered AS (
  SELECT svi.id, upper(v.code) AS vcode,
         EXTRACT(YEAR FROM (svi.issued_at AT TIME ZONE 'Asia/Kolkata'))::int AS yr,
         row_number() OVER (
           PARTITION BY upper(v.code), EXTRACT(YEAR FROM (svi.issued_at AT TIME ZONE 'Asia/Kolkata'))
           ORDER BY svi.issued_at, svi.id) AS n
    FROM student_vertical_id svi JOIN vertical v ON v.id = svi.vertical_id
)
UPDATE student_vertical_id svi
   SET student_vertical_no = numbered.vcode || '-' || numbered.yr || '-' || lpad(numbered.n::text, 3, '0')
  FROM numbered WHERE numbered.id = svi.id;

-- Reseed the 'roll' counter from the just-written numbers (codes never contain '-').
DELETE FROM coded_number_seq WHERE scope = 'roll';
INSERT INTO coded_number_seq (org_id, scope, code, year, next_seq)
SELECT org_id, 'roll', upper(split_part(student_vertical_no,'-',1)), split_part(student_vertical_no,'-',2)::int,
       MAX(split_part(student_vertical_no,'-',3)::int) + 1
  FROM student_vertical_id
 WHERE student_vertical_no ~ '^[A-Za-z0-9]+-[0-9]{4}-[0-9]{3,}$'
 GROUP BY org_id, upper(split_part(student_vertical_no,'-',1)), split_part(student_vertical_no,'-',2)::int;
