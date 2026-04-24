// Shared builder for the "generate detailed explanation" prompt.
// Used by both single-regen (api/questions/ai-action.mjs) and batch
// (api/exams/generate-solutions.mjs) so the two code paths stay in lock-step
// and the user gets identical quality whether they click "פתרון מפורט" on one
// question or "צור הסברים מפורטים עם AI" for the whole exam.
//
// The prompt asks Gemini for the richest shape the UI can render:
//   - concept_tag        : short Hebrew label shown as a pill
//   - general_explanation: 5-8 sentence walkthrough (with $$...$$ for derivations)
//   - option_explanations: per-option why-correct / why-wrong
//   - distractor_analysis: per-wrong-option misconception + why_wrong
// All four live on `ep_questions` already (see
// supabase/migrations/explanation_enrichment.sql). The UI at
// public/app.js renderSolutionPanel() surfaces them automatically.

const HEBREW_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];

/**
 * Build the prompt text. Caller is responsible for attaching inline image
 * parts (question image, context image) before this text part.
 *
 * @param {object} params
 * @param {object} params.q — ep_questions row. Needs: question_text, options_text, num_options, correct_idx.
 * @param {string|null} params.contextPromptBlock — from buildGroupContextForQuestion().
 * @returns {string} prompt text
 */
export function buildExplainPrompt({ q, contextPromptBlock }) {
  const numOptions = q.num_options || 4;
  const correctIdx = q.correct_idx;
  const correctLetter = HEBREW_LETTERS[correctIdx - 1] || String(correctIdx);

  const optionsBlock = Array.from({ length: numOptions }, (_, i) => {
    const k = i + 1;
    const t = (q.options_text || {})[k] || (q.options_text || {})[String(k)] || '';
    return `${k} (${HEBREW_LETTERS[i] || k}). ${String(t).trim() || '(ראה בתמונה)'}`;
  }).join('\n');

  const stem = String(q.question_text || '').trim() || 'קרא את השאלה מהתמונה המצורפת.';

  const optExpl = Array.from({ length: numOptions }, (_, i) => {
    const idx = i + 1;
    const isCorrect = idx === correctIdx;
    const hint = isCorrect
      ? 'מדוע אפשרות זו נכונה — הגדרה / משפט / גזירה שמאשרת אותה'
      : 'הפרכה ספציפית — במה בדיוק האפשרות נופלת או סותרת את ההגדרה';
    return `    {"idx": ${idx}, "isCorrect": ${isCorrect}, "explanation": "<3-4 משפטים: ${hint}>"}`;
  }).join(',\n');

  const wrongIndices = Array.from({ length: numOptions }, (_, i) => i + 1).filter(i => i !== correctIdx);
  const distTemplate = wrongIndices.map(idx => (
    `    {"idx": ${idx}, "misconception": "<1-2 משפטים: מה הסטודנט **חושב** כשהוא בוחר בה — המחשבה שגורמת לטעות>", "why_wrong": "<1-2 משפטים: למה המחשבה הזו לא מחזיקה — נימוק ספציפי>"}`
  )).join(',\n');

  const ctxSection = contextPromptBlock
    ? `\nהקשר משותף של הסט (השתמש בו בהסבר):\n${contextPromptBlock}\n`
    : '';

  return `אתה מרצה אוניברסיטאי בכיר (פרופסור) עם תואר דוקטור במתמטיקה/מדעי המחשב. תפקידך: לספק את ההסבר הכי מדויק, מעמיק ומנומק לשאלה רב-ברירה אקדמית, בעברית אקדמית.

=============================================================
🔴 מקור האמת: **התמונה המצורפת**.
הטקסט שלהלן חולץ אוטומטית ועלול להיות שגוי/חלקי (כתב יד, סריקה, סימנים מתמטיים מעוותים). אם יש סתירה בין הטקסט לתמונה — **התמונה קובעת**, תמיד. קרא את השאלה ואת האפשרויות ישירות מהתמונה.
=============================================================
${ctxSection}
טקסט שחולץ (עזר בלבד, לא מחייב):
שאלה: ${stem}

אפשרויות:
${optionsBlock}

התשובה הנכונה לפי מאגר האימות היא אפשרות ${correctIdx} (${correctLetter}).
⚠️ זהו SOURCE OF TRUTH מוחלט — ההסבר שלך חייב להוביל לאפשרות זו. אל תציע אחרת ואל תביע ספק ב-${correctLetter}.

=============================================================
תהליך חשיבה פנימי (לא לפלט — רק תחשוב):
  שלב 1 — קריאה: קרא את השאלה והאפשרויות **מהתמונה** (לא רק מהטקסט המחולץ). זהה את הנתונים המדויקים, נוסחאות, תנאים.
  שלב 2 — פתירה עצמאית: פתור את השאלה בעצמך מאפס. זהה את המשפט/ההגדרה המדויקים שרלוונטיים. גזור את התשובה צעד אחר צעד.
  שלב 3 — אימות: בדוק שהתשובה שקיבלת היא ${correctLetter} (=${correctIdx}). אם לא — קרא שוב את התמונה, ייתכן שפספסת פרט. התאם את הניתוח לתשובה הנכונה.
  שלב 4 — ניתוח שגויות: לכל אפשרות שגויה — מה הטעות האינטואיטיבית שמוליכה אליה, והפרכה ספציפית.

=============================================================
פלט — JSON תקין בלבד (ללא markdown, ללא \`\`\`):
{
  "concept_tag": "<תווית קצרה בעברית עד 4 מילים — שם המשפט/ההגדרה/הטכניקה המרכזיים. דוגמאות: 'משפט ריצ''ה', 'NP-שלמות', 'לֶמת הניפוח', 'אינדוקציה מתמטית', 'נוסחת ברנולי'>",

  "general_explanation": "<6-10 משפטים, בעברית אקדמית מדויקת:
    (1) הצגת המושג/המשפט המרכזי עם ציטוט מדויק של ההגדרה/הטענה (למשל: 'לפי משפט ריצ''ה, כל תכונה לא-טריוויאלית של שפות r.e. היא בלתי ניתנת להכרעה').
    (2) התאמת המשפט/ההגדרה לנתוני השאלה — למה היא חלה כאן.
    (3) גזירה מסודרת של התשובה הנכונה. לשאלות חישוב/הוכחה: הצג **כל צעד** ב-$$...$$ כולל הצעד הסופי.
    (4) קישור ברור לאפשרות ${correctLetter}.
    (5) אם יש הקשר של סט — שלב.>",

  "option_explanations": [
${optExpl}
  ],

  "distractor_analysis": [
${distTemplate}
  ]
}

=============================================================
LaTeX — קריטי לקריאות; הקפד:
- כל ביטוי מתמטי תוך \$...\$ (אינליין) או \$\$...\$\$ (תצוגה נפרדת).
- שמות אובייקטים מתמטיים באותיות זקופות: \$\\mathrm{NP}\$, \$\\mathrm{coRE}\$, \$\\mathrm{PSPACE}\$, \$\\mathrm{coNPC}\$, \$\\mathrm{ACC}\$.
- משתנים ותתי-אינדקסים: \$L_1\$, \$x_i\$, \$f(n)\$.
- אופרטורים סטנדרטיים: \$\\in, \\notin, \\subseteq, \\subset, \\cup, \\cap, \\setminus\$.
- כמתים והיגיון: \$\\forall, \\exists, \\land, \\lor, \\neg, \\Rightarrow, \\Leftrightarrow\$.
- פונקציות/סדרות: \$O(n \\log n), \\Theta(2^n), \\sum_{k=1}^{n}, \\prod_{i=1}^{n}, \\binom{n}{k}\$.
- הסתברות: \$\\Pr[A \\cap B], \\mathbb{E}[X], \\mathrm{Var}(X)\$.
- הוכחות בשורות נפרדות (אחד תחת השני): \$\$\\begin{aligned} ... \\end{aligned}\$\$.
- **מונח** (כוכביות כפולות) להדגשת מונחי מפתח לא-מתמטיים.
- שורה ריקה בין רעיונות עיקריים.

=============================================================
כללים קשוחים:
- עברית אקדמית מדויקת; מונחים טכניים אנגליים (Turing machine, context-free, reduction) נשארים באנגלית.
- אל תחזור מילה-במילה על השאלה או על נוסח האפשרויות.
- **בדיוק ${numOptions}** רשומות ב-option_explanations, idx=1..${numOptions}.
- **בדיוק ${numOptions - 1}** רשומות ב-distractor_analysis — אחת לכל אפשרות שגויה, ללא idx=${correctIdx}.
- JSON תקין בלבד. ללא טקסט לפני או אחרי. ללא \`\`\`.
- אל תכתוב "אני לא בטוח" או "לפי התמונה נראה ש…" — תן תשובה עם ביטחון.`;
}

/**
 * generationConfig defaults for the explain prompt.
 *
 * Tuning rationale:
 * - temperature: 0.0         — math/theory: fully deterministic. Zero temp
 *   kills creative drift; the model picks the highest-prob token every step.
 * - topP: 0.95               — pair with temp=0 to force deterministic greedy
 *   decoding without nucleus-sampling randomness.
 * - maxOutputTokens: 16384   — enough room for deep JSON with distractors.
 * - mediaResolution: HIGH    — Gemini reads the question image at 768×768
 *   per tile instead of 256×256. Critical for handwritten/scanned/small-
 *   font questions. Supported by Gemini 2.5+; flash-preview ignores fields
 *   it doesn't recognize without erroring.
 * - thinkingConfig.budget 16384 — Gemini 3.x Pro-preview reasons internally
 *   before emitting JSON. Doubling the budget (8k→16k) buys substantially
 *   better math/logic quality on hard CS-theory questions. Ignored by flash.
 * - safetySettings BLOCK_NONE — academic exam content (e.g. CS crypto,
 *   biology pathology) can trip minor safety filters; we want the explainer
 *   to always produce output.
 */
export const EXPLAIN_GEN_CONFIG = {
  temperature: 0.0,
  topP: 0.95,
  maxOutputTokens: 16384,
  responseMimeType: 'application/json',
  mediaResolution: 'MEDIA_RESOLUTION_HIGH',
  thinkingConfig: { thinkingBudget: 16384, includeThoughts: false },
};

/**
 * Safety settings — allow all content. Exam questions on sensitive but
 * academically legitimate topics (security, medical, biology) must not be
 * blocked. These are applied at the request level, parallel to
 * generationConfig. Flash models that don't know a threshold ignore it.
 */
export const EXPLAIN_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

/**
 * Validate + normalize Gemini's JSON response. Returns a cleaned object the
 * caller can drop straight into the DB update, or null if the shape is bad.
 *
 * Shape returned:
 *   {
 *     general_explanation: string,
 *     option_explanations: [{idx, isCorrect, explanation}, ...],
 *     concept_tag: string | null,
 *     distractor_analysis: [{idx, misconception, why_wrong}, ...] | null,
 *   }
 */
export function normalizeExplainResponse(parsed, { numOptions, correctIdx }) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.general_explanation !== 'string') return null;
  if (!Array.isArray(parsed.option_explanations)) return null;

  const general = String(parsed.general_explanation).trim();
  if (general.length < 5) return null;

  const optExpl = Array.from({ length: numOptions }, (_, i) => {
    const idx = i + 1;
    const found = parsed.option_explanations.find(o => parseInt(o?.idx, 10) === idx);
    return {
      idx,
      isCorrect: idx === correctIdx,
      explanation: String(found?.explanation || '').trim(),
    };
  });

  let conceptTag = null;
  if (typeof parsed.concept_tag === 'string') {
    const trimmed = parsed.concept_tag.trim();
    if (trimmed && trimmed.length <= 80) conceptTag = trimmed;
  }

  let distractor = null;
  if (Array.isArray(parsed.distractor_analysis)) {
    const cleaned = [];
    for (const row of parsed.distractor_analysis) {
      const idx = parseInt(row?.idx, 10);
      if (!Number.isFinite(idx) || idx < 1 || idx > numOptions) continue;
      if (idx === correctIdx) continue; // only wrong options
      const misc = String(row?.misconception || '').trim();
      const why  = String(row?.why_wrong || '').trim();
      if (!misc && !why) continue;
      cleaned.push({ idx, misconception: misc, why_wrong: why });
    }
    if (cleaned.length > 0) distractor = cleaned;
  }

  return {
    general_explanation: general,
    option_explanations: optExpl,
    concept_tag: conceptTag,
    distractor_analysis: distractor,
  };
}
