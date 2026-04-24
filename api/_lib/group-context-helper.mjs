// Helper that assembles everything Gemini needs to understand a single
// question that belongs to a set (group_id != NULL):
//   • The set's shared context (scenario / passage / data table / code block)
//   • The set's shared context image (Cloudinary URL) if available
//   • Earlier siblings in the set (question_number < current) with their
//     stems + correct option text, so chained reasoning works
//     (e.g. Q2's explanation can reference what Q1 asked + its answer).
//
// Returns { contextPromptBlock: string, contextImagePath: string|null } or
// null when the question isn't part of a group (no work needed).

const HEBREW_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];

function formatOptionText(q, idx) {
  if (!idx || idx < 1 || idx > 10) return null;
  const letter = HEBREW_LETTERS[idx - 1] || String(idx);
  const opts = q.options_text || {};
  const text = opts[idx] || opts[String(idx)] || '';
  const clean = String(text).trim().slice(0, 160);
  return clean ? `${letter}) ${clean}` : letter;
}

function formatStem(q) {
  const s = String(q.question_text || '').trim();
  return s ? s.slice(0, 400) : `שאלה ${q.question_number}`;
}

// db: the authenticated supabase client
// q:  the full ep_questions row (must include exam_id, user_id, group_id,
//     question_number, context_text, context_image_path, num_options).
export async function buildGroupContextForQuestion(db, q) {
  if (!q || !q.group_id) return null;

  const parts = [];

  // 1) Shared scenario / passage / data block.
  const ctxText = (q.context_text || '').trim();
  if (ctxText) {
    parts.push(
`הקשר משותף לסט השאלות (תיאור הניסוי / טבלת נתונים / קטע):
"""
${ctxText.slice(0, 4000)}
"""`
    );
  }

  // 2) Prior siblings in the same set (question_number < current).
  try {
    const { data: siblings } = await db.from('ep_questions')
      .select('id, question_number, question_text, options_text, correct_idx, num_options')
      .eq('exam_id', q.exam_id)
      .eq('group_id', q.group_id)
      .is('deleted_at', null)
      .lt('question_number', q.question_number)
      .order('question_number', { ascending: true });

    if (Array.isArray(siblings) && siblings.length > 0) {
      const lines = ['שאלות קודמות באותו סט (להקשר לוגי בלבד — בהסבר שלך אל תחזור על הניתוח שלהן):'];
      for (const sib of siblings) {
        const stem = formatStem(sib);
        const correctText = formatOptionText(sib, sib.correct_idx);
        lines.push(`— שאלה ${sib.question_number}: ${stem}`);
        if (correctText) lines.push(`  התשובה הנכונה: ${correctText}`);
      }
      parts.push(lines.join('\n'));
    }
  } catch (e) {
    console.warn('[group-context] sibling fetch failed:', e?.message || e);
  }

  if (parts.length === 0) return null;
  return {
    contextPromptBlock: parts.join('\n\n'),
    contextImagePath: q.context_image_path || null,
  };
}
