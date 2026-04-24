// =====================================================
// Shared topic-extraction helper.
// =====================================================
// Labels ep_questions rows in a single course with short canonical topic
// strings ("גנטיקה מנדלית", "Design Patterns", "פוטוסינתזה") via Gemini,
// writing results into ep_questions.topic. The Insights page uses these
// labels to build its "what repeats" aggregate.
//
// Self-terminates: runs only on rows where topic IS NULL / empty, so calling
// it repeatedly is cheap when nothing's pending.
//
// Called from api/crud.mjs (POST /api/ai/extract-topics). Kept out of
// crud.mjs proper to avoid bloating that file.

import { MODEL_CHAIN } from './gemini-models.mjs';
import { getGeminiKeys } from './gemini-key.mjs';

const BATCH_SIZE = 25;
const MAX_QUESTIONS_PER_CALL = 300;

// ── Gemini: label a batch of questions ────────────────────────────────────────
// existingTopics: array of strings already used in this course. Prompt tells
// Gemini to reuse one of them when a question matches an existing theme, so
// clusters stay stable across successive uploads.
async function labelBatchWithGemini(batch, existingTopics, courseName) {
  const { paidKey, freeKey } = getGeminiKeys();
  if (!paidKey && !freeKey) return null;

  const vocabLine = existingTopics.length > 0
    ? `\nNOSHAIM_KAYAMIM (use one of these VERBATIM when a question matches; only invent a new label when truly none fits):\n${existingTopics.slice(0, 40).map(t => `- ${t}`).join('\n')}\n`
    : '';

  const qLines = batch.map(q => {
    const stem = (q.question_text || '').trim().replace(/\s+/g, ' ').slice(0, 400);
    const opts = q.options_text && typeof q.options_text === 'object'
      ? Object.values(q.options_text).filter(Boolean).slice(0, 4).map(o => String(o).trim().slice(0, 80)).join(' | ')
      : '';
    const bodyParts = [stem || '(ללא טקסט — הנושא לא ניתן לקביעה)'];
    if (opts) bodyParts.push(`אופציות: ${opts}`);
    return `[${q.id}] ${bodyParts.join(' — ')}`;
  }).join('\n');

  const prompt = `אתה מסווג שאלות בחינה אוניברסיטאית לפי הנושא הספציפי שלהן.
הקורס: "${courseName || 'לא ידוע'}".
${vocabLine}
לכל שאלה ברשימה, החזר תווית-נושא אחת בעברית — 1 עד 3 מילים, ספציפית אך מאחדת.
דוגמאות טובות: "גנטיקה מנדלית", "פוטוסינתזה", "אינטגרלים", "תרמודינמיקה", "Design Patterns", "SQL Joins", "נוירוביולוגיה", "אלגוריתמי חיפוש".
דוגמאות רעות: "שאלה", "כללי", "ביולוגיה" (רחב מדי), "שאלה על סעיף 3".

כללים:
- עברית תמציתית ומדעית. מונחי מפתח באנגלית מותרים (למשל "DNA", "Lambda Calculus").
- העדף תווית קצרה (2-3 מילים) על פני משפט.
- אם NOSHAIM_KAYAMIM מכיל תווית שמתאימה — השתמש בה בדיוק כפי שמופיעה.
- אם שאלה חסרה תוכן אמיתי, החזר עדיין תווית סבירה מתוך ההקשר (אופציות/מילות מפתח).
- לעולם אל תחזיר null או מחרוזת ריקה.

שאלות:
${qLines}

החזר JSON בלבד, ללא markdown:
{
  "labels": [
    {"id": <question id integer>, "topic": "<short Hebrew topic label>"}
  ]
}`;

  async function tryKey(apiKey) {
    for (const model of MODEL_CHAIN.extraction) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: 'application/json' },
          }),
          signal: AbortSignal.timeout(25000),
        });
        if (!r.ok) { if (r.status === 429) return { quota: true }; continue; }
        const j = await r.json();
        const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed?.labels)) return { labels: parsed.labels };
      } catch (e) {
        console.warn(`[topic-extractor] ${model} failed:`, e?.message);
      }
    }
    return null;
  }

  const primary = paidKey || freeKey;
  const fallback = paidKey && freeKey ? freeKey : null;
  let res = await tryKey(primary);
  if (res?.quota && fallback) {
    console.warn('[topic-extractor] primary quota exceeded — switching keys');
    res = await tryKey(fallback);
  }
  return res?.labels || null;
}

function canonicalize(t) {
  return String(t || '').trim().replace(/\s+/g, ' ');
}

// ── Main entry — label every un-topic'd question in a course. ────────────────
// Caller handles auth + ownership checks before invoking this.
export async function extractTopicsForCourse({ admin, courseId, ownerUserId, courseName }) {
  if (!admin || !courseId || !ownerUserId) {
    return { ok: false, error: 'bad_args' };
  }

  const { data: pendingRaw, error: qErr } = await admin.from('ep_questions')
    .select('id, question_text, options_text, instructor_solution_text')
    .eq('course_id', courseId)
    .eq('user_id', ownerUserId)
    .is('deleted_at', null)
    .or('topic.is.null,topic.eq.')
    .limit(MAX_QUESTIONS_PER_CALL);
  if (qErr) {
    console.error('[topic-extractor] fetch pending:', qErr.message);
    return { ok: false, error: 'fetch_failed', detail: qErr.message };
  }

  const pending = (pendingRaw || []).filter(q => {
    const hasStem = q.question_text && String(q.question_text).trim().length >= 5;
    const hasOpts = q.options_text && typeof q.options_text === 'object'
      && Object.values(q.options_text).some(v => v && String(v).trim().length > 2);
    const hasInstructor = q.instructor_solution_text && String(q.instructor_solution_text).trim().length > 10;
    return hasStem || hasOpts || hasInstructor;
  });

  if (pending.length === 0) {
    return { ok: true, labeled: 0, skipped: (pendingRaw || []).length, reason: 'no_content' };
  }

  // For instructor-solution-only cases, fall back to that text as the stem.
  for (const q of pending) {
    const stem = q.question_text && String(q.question_text).trim();
    if (!stem && q.instructor_solution_text) {
      q.question_text = String(q.instructor_solution_text).slice(0, 400);
    }
  }

  // Seed vocabulary from already-labeled questions in the same course so
  // successive runs reuse existing labels instead of inventing synonyms.
  const { data: existing } = await admin.from('ep_questions')
    .select('topic')
    .eq('course_id', courseId)
    .eq('user_id', ownerUserId)
    .is('deleted_at', null)
    .not('topic', 'is', null)
    .limit(500);
  const discovered = new Set((existing || [])
    .map(r => canonicalize(r.topic))
    .filter(Boolean));

  console.log(`[topic-extractor] course=${courseId} pending=${pending.length} seedVocab=${discovered.size}`);

  let totalLabeled = 0;
  let totalFailed = 0;
  const tStart = Date.now();

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const vocab = Array.from(discovered).slice(0, 40);
    const labels = await labelBatchWithGemini(batch, vocab, courseName);
    if (!labels || labels.length === 0) {
      console.warn(`[topic-extractor] batch ${i}: no labels returned`);
      totalFailed += batch.length;
      continue;
    }

    const byId = new Map();
    for (const item of labels) {
      const id = parseInt(item?.id, 10);
      const topic = canonicalize(item?.topic);
      if (!id || !topic || topic.length > 120) continue;
      byId.set(id, topic);
    }

    for (const q of batch) {
      const topic = byId.get(q.id);
      if (!topic) { totalFailed++; continue; }
      const { error: upErr } = await admin.from('ep_questions')
        .update({ topic })
        .eq('id', q.id);
      if (upErr) {
        console.warn(`[topic-extractor] update ${q.id} failed:`, upErr.message);
        totalFailed++;
      } else {
        totalLabeled++;
        discovered.add(topic);
      }
    }
  }

  const elapsedMs = Date.now() - tStart;
  console.log(`[topic-extractor] course=${courseId} labeled=${totalLabeled}/${pending.length} failed=${totalFailed} topics=${discovered.size} in ${elapsedMs}ms`);

  return {
    ok: true,
    labeled: totalLabeled,
    failed: totalFailed,
    total_pending: pending.length,
    total_topics: discovered.size,
    elapsed_ms: elapsedMs,
  };
}
