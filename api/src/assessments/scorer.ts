/**
 * AUTO-SCORER — Assessment Batch C.
 *
 * A PURE function that scores the OBJECTIVE portion of an attempt. Kept free of the DB so
 * it can be unit-tested exhaustively (single/multi exact-match, true/false, fill-blank
 * case-insensitive, negative marking, subjective left null, pass/fail boundary). The
 * service loads the frozen question set + correct answers and calls this; subjective
 * answers get awarded=null and wait for faculty evaluation.
 *
 * RULES (kept deliberately simple, per the brief):
 *   · mcq_single / true_false / image_mcq / audio_mcq / video_mcq — correct iff the selected
 *     set exactly equals the correct set (these have exactly one correct option).
 *   · mcq_multi — FULL marks only if the selected set exactly equals the correct set
 *     (all-correct-and-only-correct); otherwise wrong.
 *   · fill_blank — case-insensitive, trimmed exact match of the typed answer to any correct
 *     option text / answer key.
 *   · match_following — all pairs correct (answer_text carries a JSON map option_id -> match_key).
 *   · negative marking — applied ONLY when the test has negative_marking on AND the question
 *     was answered AND it was wrong; an unanswered question scores 0, never negative.
 *   · subjective types — awarded=null, is_correct=null (pending evaluation).
 */

export const OBJECTIVE_SCORABLE = new Set<string>([
  'mcq_single', 'mcq_multi', 'true_false', 'image_mcq', 'audio_mcq', 'video_mcq',
  'match_following', 'fill_blank',
]);

export interface ScorerQuestion {
  question_id: number;
  q_type: string;
  marks: number;
  negative: number;                 // resolved per-link negative for this question
  correct_option_ids?: number[];    // objective option-based correctness
  correct_texts?: string[];         // fill_blank accepted answers (option bodies where is_correct)
  match_pairs?: Array<{ option_id: number; match_key: string }>;
}

export interface ScorerAnswer {
  question_id: number;
  selected_option_ids?: number[];
  answer_text?: string | null;
}

export interface ScoredQuestion {
  question_id: number;
  q_type: string;
  objective: boolean;
  answered: boolean;
  is_correct: boolean | null;
  awarded: number | null;
}

export interface ScoreResult {
  per: ScoredQuestion[];
  auto_score: number;      // sum of objective awarded, clamped to >= 0
  max_score: number;       // sum of all question marks
  has_subjective: boolean;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const setEqual = (a: number[], b: number[]) => {
  const A = new Set(a.map(Number)); const B = new Set(b.map(Number));
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
};

function isAnswered(q: ScorerQuestion, a: ScorerAnswer | undefined): boolean {
  if (!a) return false;
  if ((a.selected_option_ids ?? []).length > 0) return true;
  if (a.answer_text != null && String(a.answer_text).trim() !== '') return true;
  return false;
}

function objectiveCorrect(q: ScorerQuestion, a: ScorerAnswer): boolean {
  const sel = (a.selected_option_ids ?? []).map(Number);
  switch (q.q_type) {
    case 'fill_blank': {
      const want = (q.correct_texts ?? []).map(norm).filter(Boolean);
      return want.length > 0 && want.includes(norm(a.answer_text));
    }
    case 'match_following': {
      const pairs = q.match_pairs ?? [];
      if (!pairs.length) return false;
      let map: Record<string, string> = {};
      try { map = a.answer_text ? JSON.parse(String(a.answer_text)) : {}; } catch { map = {}; }
      return pairs.every((p) => norm(map[String(p.option_id)]) === norm(p.match_key));
    }
    default:
      // mcq_single/multi, true_false, image/audio/video_mcq — exact set match
      return setEqual(sel, q.correct_option_ids ?? []);
  }
}

export function scoreAttempt(
  questions: ScorerQuestion[],
  answers: ScorerAnswer[],
  opts: { negativeMarking: boolean },
): ScoreResult {
  const byQ = new Map<number, ScorerAnswer>();
  for (const a of answers) byQ.set(Number(a.question_id), a);

  const per: ScoredQuestion[] = [];
  let auto = 0;
  let max = 0;
  let hasSubjective = false;

  for (const q of questions) {
    const marks = Number(q.marks) || 0;
    max += marks;
    const objective = OBJECTIVE_SCORABLE.has(q.q_type);
    const a = byQ.get(Number(q.question_id));
    const answered = isAnswered(q, a);

    if (!objective) {
      hasSubjective = true;
      per.push({ question_id: q.question_id, q_type: q.q_type, objective: false, answered, is_correct: null, awarded: null });
      continue;
    }
    if (!answered) {
      per.push({ question_id: q.question_id, q_type: q.q_type, objective: true, answered: false, is_correct: false, awarded: 0 });
      continue;
    }
    const correct = objectiveCorrect(q, a as ScorerAnswer);
    let awarded = 0;
    if (correct) awarded = marks;
    else if (opts.negativeMarking) awarded = -(Number(q.negative) || 0);
    auto += awarded;
    per.push({ question_id: q.question_id, q_type: q.q_type, objective: true, answered: true, is_correct: correct, awarded });
  }

  return { per, auto_score: Math.max(0, Math.round(auto * 100) / 100), max_score: Math.round(max * 100) / 100, has_subjective: hasSubjective };
}

/** Pass/fail against the test's threshold. Returns null when no threshold is set. */
export function computeIsPassed(totalScore: number, maxScore: number, passingMarks: number | null, passingPct: number | null): boolean | null {
  if (passingMarks != null) return totalScore >= Number(passingMarks);
  if (passingPct != null && maxScore > 0) return (totalScore / maxScore) * 100 >= Number(passingPct);
  return null;
}
