// Gemini-based solution PDF analysis and exam MCQ detection.
// Extracted from api/upload.mjs so add-solution.mjs can share this logic.

import { MODEL_CHAIN, MODELS, STRONG_MODEL } from './gemini-models.mjs';
import { getGeminiKeys, withBackoff } from './gemini-key.mjs';

// =====================================================
async function analyzeExamWithGemini(examPdfBase64, solPdfBase64) {
  const { paidKey, freeKey } = getGeminiKeys();
  if (!freeKey && !paidKey) return null;

  const prompt = `Analyze this Hebrew university exam PDF. Find EVERY multiple-choice question (שאלות אמריקאיות / שאלות סגורות).

A multiple-choice question has ALL of:
1. A question number labeled in ANY of these ways:
   • "שאלה 1", "שאלה 2", ... (classic header format)
   • "1 (", "2 (", "3 (" — bare number followed by open-paren, common in biology/genetics/chemistry exams
   • "סעיף א", "(א)", "(ב)" (sub-questions inside a set)
   • Just "1." / "2." at the start of a line
2. 2-10 answer options labeled in ANY of these formats:
   • 1. / 2. / 3. / 4.   or   1) / 2) / 3) / 4)   or   (1) / (2) / (3) / (4)
   • א. / ב. / ג. / ד. / ה. / ו. / ז. / ח. / ט. / י.   (biology often has 6-10 options)
   • א) / ב) / ג) / ד)   or   (א) / (ב) / (ג) / (ד)
3. The student picks ONE answer

BE EXHAUSTIVE. Return EVERY question that matches. This is CRITICAL:
- Do NOT skip a question because its stem contains words like הוכיחו, הראו, הפריכו, חשבו, השלימו, הסבירו — MCQs often use these words inside the stem or inside their answer options.
- Include questions even if you are only ~80% sure they are MCQs.
- Scan ALL pages, including page 1.
- If questions are numbered 1..N, you should generally return N objects.
- BIOLOGY / CHEMISTRY / MEDICINE exams often present a scenario, experiment description, figure, or data table followed by several short sub-questions with options — every short sub-question with options IS an MCQ; extract each one separately with a shared group_id.
- Questions can appear mid-page between figures or passages — scan the full page, not just top/bottom.
- If you see short answer-option lines (1./2./3./4. or א./ב./ג./ד. or (1)/(2)/(3)/(4) or (א)/(ב)) near any question stem, that IS an MCQ even if the stem is only one sentence.

ONLY skip a question if:
- It has NO answer options at all (just a blank writing space)
- It sits under an explicit "שאלות פתוחות" section header
- It is pure instructions / cover page with no question stem

=== CONTEXT GROUPS ===
Some exams present a shared piece of content — a figure, diagram, passage, data table, chemical structure, or code snippet — BEFORE a numbered cluster of MCQs that ALL depend on it. Without the shared content, those questions CANNOT be answered.

A GROUP exists when ALL of these are true:
- A figure, image, diagram, passage, table, code snippet, or data set appears on the page, AND
- The sub-questions that follow CANNOT be answered without that shared content

NOT a group:
- Questions on the same topic but each independently states all needed information
- A section header like "חלק א" or "נושא: גנטיקה" without a concrete shared figure/passage
- Consecutive questions that share subject area but are self-contained

For each question in a group:
- Assign the SAME group_id string (e.g. "A", "B", "C") to all questions sharing the same context
- Report context_y_top: the percentage (0-100) from the TOP of context_page where the shared context element STARTS (very top edge of the figure, passage, code block, or table — not the question itself)
- Report context_page: the page number (1-based) where the shared context appears

=== ISRAELI SET FORMAT (very common) ===
Israeli exams frequently use "set" (סט) format WITHOUT an explicit linking instruction.

🔴 CRITICAL SET-DETECTION RULE:
If you see ANY question that begins with a back-reference phrase like
"לפי התוצאות", "לפי הטבלה", "לפי הניסוי", "לפי הנתונים", "בהתאם לנתונים",
"בהכלאה הנ״ל", or similar → that question DEPENDS on an earlier scenario.
Walk BACKWARDS from it to find the scenario (figure / data table / code /
passage / "סט N :" header). Then assign the SAME group_id to:
  • Every question that back-references the scenario, AND
  • EVERY question on the SAME PAGE as the scenario that appears BELOW it
    (e.g. Q1 right after "סט 1:" — this first question is ALSO part of the set,
    even if its stem doesn't explicitly say "לפי התוצאות").
The FIRST question of a set is STILL part of the set. Never leave Q1 with
group_id=null if its sub-siblings Q2, Q3, ... are grouped.

Two common variants:

Variant A (CS/math — sub-letters):
  שאלה 1 (15 נקודות)
  [context block — code, theorem, automaton, formula, diagram]
  (א) First sub-question...   (1) opt1  (2) opt2  (3) opt3  (4) opt4
  (ב) Second sub-question...  (1) opt1  (2) opt2  (3) opt3  (4) opt4
  (ג) Third sub-question...   ...

Variant B (biology/chemistry/genetics — numbered within set):
  סט 1 : [long scenario — experiment, crossbreeding, mutation data, population data]
  1 ( Question about the scenario  → א. opt1  ב. opt2  ג. opt3  ד. opt4  ה. opt5 ...
  2 ( Another question             → א. opt1  ב. opt2  ג. opt3  ד. opt4 ...

  סט 2 : [new scenario]
  7 ( ...
  8 ( ...

→ Treat EACH sub-question as a SEPARATE MCQ entry with the SAME group_id
→ For Variant B: each numbered question under "סט N" shares the group_id of that set; the set header "סט 1" / "סט 2" defines the context boundary
→ context_y_top = top of the scenario text block (right after the "סט N :" label)
→ context_page  = page where the scenario text starts
→ Biology/genetics MCQs commonly have 6-10 options (א through י)  — return all of them in the stem area; your job is to find the coordinates, not to list the options
→ Apply this detection even without an explicit "ענה על שאלות X-Y בהתבסס על..." instruction
=== END SET FORMAT ===

IMPORTANT: When in doubt, DO create a group — it is better to over-group than to miss a dependency. Missing a group makes the questions unanswerable for students.
=== END CONTEXT GROUPS ===

For EACH MCQ return:
{
  "n": question number (integer as printed),
  "page": PDF page number (1-based integer),
  "y_top": percentage from top of the question's BOUNDING BOX top edge.
      • MUST include the full question-number label ("שאלה N" / "N (" / "(א)")
      • Place y_top ~3–5% ABOVE the label line — err on the side of including
        too much whitespace above rather than clipping the number.
      • NEVER place y_top inside the question stem. It is the TOP edge.
      • (float 0-100, use one decimal e.g. 12.4),
  "y_bottom": percentage from top of the question's BOUNDING BOX bottom edge.
      • MUST include EVERY option line, down to the LAST visible character.
      • For 10-option biology questions, count down to "י" and go BELOW it.
      • Place y_bottom ~3–5% BELOW where the last option's text ends.
      • It is OK if this overlaps slightly into the next question — better to
        have some overlap than to clip the last option.
      • (float 0-100, use one decimal e.g. 78.2),
  "num_options": integer 2-10 — COUNT the visible answer options for THIS question (א,ב,ג,ד,ה,ו,ז,ח,ט,י = 1..10; biology/genetics/chemistry often have 5-10 options — COUNT them carefully; CS/math usually 4),
  "group_id": null if standalone; short string like "A" or "B" if this question shares a context block with others (all questions in the same context get the same group_id),
  "context_y_top": percentage from top of context_page where shared content STARTS — the very top of the figure/passage/table (only when group_id != null; null otherwise),
  "context_page": page number (1-based) where shared context lives (only when group_id != null; null otherwise),
  "context_text": ONLY for questions with group_id — the VERBATIM Hebrew/English text of the shared scenario/passage/data table/code block that precedes the sub-questions (for "סט N :" format: copy EVERYTHING between "סט N :" and the first sub-question number; include all data values, labels, and formulas; up to 1500 chars). Same value for every member of the same group_id. Use null when group_id is null. MATH: when the context contains mathematical notation (formulas, expressions, variables like n, O(n log n), ∑, ∫, π, √, fractions, subscripts/superscripts), WRAP each mathematical token with $...$ for inline and $$...$$ for display blocks. Do NOT wrap plain Hebrew or English words. Example: "חשב את $O(n \\log n)$ עבור $n > 0$". Leave natural language untouched,
  "correct": correct answer index (integer 1-10) ONLY if visually marked (yellow highlight, circle, checkmark, bold, handwritten mark) on the exam itself; null if no visible mark. Map א=1, ב=2, ג=3, ד=4, ה=5, ו=6, ז=7, ח=8, ט=9, י=10. BE EXHAUSTIVE — highlights are common in biology/genetics exams; scan every option carefully.,
  "page_w": page width in points (usually 595),
  "page_h": page height in points (usually 842)
}

Return ONLY a JSON array. Be complete — if the exam has 10 questions, return 10 objects.`;

  const parts = [
    { text: prompt },
    { inlineData: { mimeType: 'application/pdf', data: examPdfBase64 } },
  ];
  if (solPdfBase64) {
    parts.push({ text: '\n\nSolution PDF (use for correct answers):' });
    parts.push({ inlineData: { mimeType: 'application/pdf', data: solPdfBase64 } });
  }

  async function tryWithKey(apiKey) {
    for (const model of MODEL_CHAIN.extraction) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        console.log(`[gemini-fallback] trying ${model}...`);
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 16384,
              responseMimeType: 'application/json',
              mediaResolution: 'MEDIA_RESOLUTION_HIGH',
            },
          }),
          signal: AbortSignal.timeout(60000),
        });
        if (!r.ok) {
          console.warn(`[gemini-fallback] ${model} ${r.status}`);
          if (r.status === 429) return { quota_exceeded: true };
          continue;
        }
        const j = await r.json();
        const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        let parsed = null;
        try { parsed = JSON.parse(cleaned); } catch { continue; }
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log(`[gemini-fallback] ${model} found ${parsed.length} MCQs`);
          return { result: parsed };
        }
      } catch (e) {
        console.warn(`[gemini-fallback] ${model} failed:`, e.message);
      }
    }
    return null;
  }

  const primaryKey = paidKey || freeKey;
  const fallbackKey = paidKey ? freeKey : null;
  console.log(`[gemini-fallback] using ${paidKey ? 'paid' : 'free'} key as primary`);
  const primaryRes = await tryWithKey(primaryKey);
  if (primaryRes?.result) return primaryRes.result;
  if (primaryRes?.quota_exceeded && fallbackKey) {
    console.warn('[gemini-fallback] primary key quota exceeded — switching to fallback key');
    const fallbackRes = await tryWithKey(fallbackKey);
    if (fallbackRes?.result) return fallbackRes.result;
  }

  // Retry with an ultra-permissive prompt — for non-standard exam formats
  // (biology/chemistry exams with context-shared sets, unlabeled numbering, etc.).
  console.warn('[gemini-fallback] primary prompt returned 0 — retrying with permissive prompt');
  const loosePrompt = `You are scanning a Hebrew exam PDF. Your ONE job: locate EVERY question that has multiple answer choices the student picks from.

Be EXTREMELY INCLUSIVE. A question counts if it has:
• Any form of question text (a stem, prompt, or setup), AND
• 2+ visible answer options labeled in ANY of these ways:
  1./2./3./4.  |  1)/2)/3)/4)  |  (1)/(2)/(3)/(4)
  א./ב./ג./ד.  |  א)/ב)/ג)/ד)  |  (א)/(ב)/(ג)/(ד)  |  A./B./C./D.
  or even options on separate short lines under the stem.

The question "number" can be written as:
  "שאלה 1", "1.", "1)", "(1)", "סעיף א", "(א)", "א.",  "Question 1", or just a bold/standalone label.

CRITICAL FOR BIOLOGY/CHEMISTRY/MEDICINE EXAMS:
Many exams present a scenario/passage/figure/data-table ONCE, then ask 2–6 short MCQs about it. Each short MCQ with its own options is a SEPARATE question — return EACH one. Give them all the SAME group_id (a short letter) and the same context_y_top/context_page pointing at the top of the shared block.

DO NOT SKIP:
- Questions on page 1 (page 1 often has real questions, not just instructions)
- Questions whose stems use words like הסבירו/הוכיחו — if they still have labeled options, they are MCQs
- Questions in the middle of a passage or between figures
- Short "true/false" style questions with 2 options

Return ONLY a JSON array. If the exam appears to have 15 questions, return 15 objects. Empty array ONLY if the PDF truly contains zero multi-choice items.

For each question return:
{
  "n": integer question number (use the printed number; for (א)/(ב) sub-questions inside a set, number them 1,2,3 within the set),
  "page": 1-based page number,
  "y_top": % from top — place ~3–5% ABOVE the question number line so nothing clips,
  "y_bottom": % from top — place ~3–5% BELOW the last option line so the final option is fully visible,
  "num_options": integer 2-10 — count visible answer options,
  "group_id": null, OR short string shared by all questions in one context-set,
  "context_y_top": % from top where shared context begins (null if group_id is null),
  "context_page": page of shared context (null if group_id is null),
  "context_text": for grouped questions — verbatim text of the shared scenario/passage/data block (same value for every member; up to 1500 chars); null otherwise,
  "correct": 1-10 if the correct answer is visually marked (highlight/circle/check) else null,
  "page_w": page width in points (595 if unknown),
  "page_h": page height in points (842 if unknown)
}`;
  const looseParts = [
    { text: loosePrompt },
    { inlineData: { mimeType: 'application/pdf', data: examPdfBase64 } },
  ];
  async function tryLoose(apiKey) {
    // Upload-path retry — stay on FAST chain so a single slow model can't
    // keep the pipeline waiting past the 300s Vercel budget.
    for (const model of MODEL_CHAIN.extraction) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        console.log(`[gemini-fallback-loose] trying ${model}...`);
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: looseParts }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 16384,
              responseMimeType: 'application/json',
              mediaResolution: 'MEDIA_RESOLUTION_HIGH',
            },
          }),
          signal: AbortSignal.timeout(60000),
        });
        if (!r.ok) { if (r.status === 429) return { quota_exceeded: true }; continue; }
        const j = await r.json();
        const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        let parsed = null;
        try { parsed = JSON.parse(cleaned); } catch { continue; }
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log(`[gemini-fallback-loose] ${model} found ${parsed.length} MCQs`);
          return { result: parsed };
        }
      } catch (e) {
        console.warn(`[gemini-fallback-loose] ${model} failed:`, e.message);
      }
    }
    return null;
  }
  const looseRes = await tryLoose(primaryKey);
  if (looseRes?.result) return looseRes.result;
  if (looseRes?.quota_exceeded && fallbackKey) {
    const fb = await tryLoose(fallbackKey);
    if (fb?.result) return fb.result;
  }
  return null;
}

// =====================================================
async function classifyPdfWithGemini(pdfBase64) {
  const { paidKey, freeKey } = getGeminiKeys();
  const primaryKey = paidKey || freeKey;
  const fallbackKey = paidKey && freeKey ? freeKey : null;
  if (!primaryKey) return null;
  const prompt = `Look at this PDF and classify it. Reply with ONLY a JSON object (no markdown):
{ "type": "exam" | "solution" | "notes" | "blank" | "other", "reason": "one short sentence in Hebrew" }
exam = university exam with questions students must answer
solution = answer key / פתרון / answers to an exam
notes = lecture slides, notes, textbook pages
blank = empty or unreadable
other = anything else`;

  async function tryKey(apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.fallback}:generateContent?key=${apiKey}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 256, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(20000),
    });
  }

  try {
    let r = await tryKey(primaryKey);
    if (r.status === 429 && fallbackKey) {
      console.warn('[classify] primary quota exceeded — switching to fallback key');
      r = await tryKey(fallbackKey);
    }
    if (!r.ok) return null;
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch { return null; }
}

// =====================================================
// Unified solution-PDF analyzer: verifies the solution matches the exam AND
// extracts all answers in ONE Gemini call.
// Returns: { match: 'match'|'mismatch'|'unknown', confidence: 0-1,
//            answers: {qNumber: answerIdx}, rawItems, model, reasoning }
// =====================================================
async function analyzeSolutionPdf(examBase64, solutionBase64, questionNumbers) {
  const { paidKey, freeKey } = getGeminiKeys();
  if (!freeKey && !paidKey) return { match: 'unknown', confidence: 0, answers: {}, model: null };

  const nums = questionNumbers.slice(0, 60).join(', ');
  const prompt = `You are analyzing two Hebrew academic PDFs that a student just uploaded:
1. An EXAM PDF containing multiple-choice questions numbered approximately: ${nums}
2. A SOLUTION PDF that the student claims contains the answer key for that exam.

Your job has TWO parts, in one response:

PART A — VERIFICATION (strict):
Determine if the SOLUTION PDF is genuinely the answer key for THIS exam.
- Check that question numbers in the solution PDF overlap with the exam's numbers.
- Check that the topic/subject and terminology match between the two PDFs.
- Check that the number of questions is compatible.
- If the solution PDF looks like lecture notes, a different exam, a syllabus, a study guide, or unrelated content → that's a MISMATCH.
- Only answer "match: true" when you are confident the two documents are paired. When in doubt, say unsure.

PART B — ANSWER EXTRACTION:
For every exam question, determine the correct answer by reading the solution PDF carefully.
The solution PDF is the authoritative answer key — the user uploaded it specifically to provide answers.

Answers can come from any of these sources in the solution PDF:
  1. A SUMMARY TABLE ("שאלה | תשובה") — most reliable.
  2. A DEDICATED ANSWER KEY: "1. ב", "1) א", "תשובה 1: ב", "ת. 1: ג".
  3. AN EXPLICIT DECLARATION inline in the solution: "לכן התשובה היא ב", "התשובה הנכונה היא א", "התשובה הנכונה היתה ט'", "מסיח א הוסר, התשובה הנכונה היתה ט'", "הקיפו את אפשרות ב", "הפתרון: א".
  4. AN EXPLANATION PARAGRAPH whose CONCLUSION matches ONE SPECIFIC OPTION. Example: if the solution explains "r ו-b הם אללים של גנים שונים" and option ד reads exactly "b ו-r הם אללים של גנים שונים" — that's ד. Match the concluding logic of the explanation to the option text that expresses the same conclusion.
  5. A HIGHLIGHTED / CIRCLED option — colored highlight, hand-drawn circle, checkmark (✓), arrow (→). Also handwritten letter/digit in the margin.

⚠️ AVOID THE WRONG-OPTION TRAP:
Explanations often MENTION wrong options to dismiss them ("ג שגויה כי...", "אפשרות ב אינה נכונה"). DO NOT pick up the letter of a dismissed option — pick the one the explanation AFFIRMS as correct. If the explanation reviews several options and concludes with one affirmative statement, pick THAT one.

⚠️ HEBREW LETTER-TO-INDEX MAPPING — the single most common failure mode. Memorize exactly:
  א = 1 (alef)
  ב = 2 (bet)
  ג = 3 (gimel)
  ד = 4 (dalet)
  ה = 5 (he)
  ו = 6 (vav)
  ז = 7 (zayin)
  ח = 8 (chet)
  ט = 9 (tet)  ← SECOND-TO-LAST in a 10-option exam
  י = 10 (yod) ← LAST in a 10-option exam
COUNT from the beginning of the alphabet every single time. Do not guess from position.
In EVERY answer object include BOTH the letter you saw AND its numeric index, so they can be cross-checked.

⚠️ ג vs ד and ט vs י CONFUSION:
These letter pairs look similar in some Hebrew fonts and scans. Before committing, re-read the source one more time and verify you picked the correct letter. If the answer is genuinely ambiguous between two adjacent letters, LOWER the confidence to ≤ 0.5.

⚠️ RIGHT-TO-LEFT TABLE ALIGNMENT:
If answers appear in a "שאלה | תשובה" table, visually align each row: the answer for question N is in the SAME ROW as question N, not the row above or below it. RTL reading order means the leftmost column may be the answer but the rightmost may be the question number — verify by reading full rows, not by column position alone.

Accept both Hebrew letters and digits as input. In the output, return BOTH.

Be EXHAUSTIVE — aim to return every question that has a determinable answer. Skip a question ONLY if the solution PDF genuinely does not cover it or the text is too ambiguous to identify a single winner. Returning nothing is better than returning a wrong answer, but returning an answer you're confident about is better than over-omitting.

Return ONLY this JSON object (no markdown, no extra text):
{
  "match": true | false | null,
  "confidence": <float 0.0-1.0>,
  "reasoning": "<one short Hebrew sentence>",
  "answers": [
    {"q": <exam question number>, "ans": <integer 1..10>, "ans_letter": "<א|ב|ג|ד|ה|ו|ז|ח|ט|י>", "method": "<table|list|conclusion|explanation|highlight|handwritten|margin>", "confidence": <0.0-1.0>, "source_quote": "<brief quote or description from PDF, ≤120 chars>"}
  ]
}

Rules:
- "ans_letter" and "ans" MUST be consistent (א↔1, ב↔2, ג↔3, ד↔4, ה↔5, ו↔6, ז↔7, ח↔8, ט↔9, י↔10). The server validates this.
- "source_quote" is required — a concise quote or visual description.
- Report "confidence" honestly (the server accepts ≥ 0.3).
- If the solution PDF clearly does not match the exam, return "answers": [] and set "match": false.
- Scan EVERY page, including the last page where summary tables often live.`;

  async function callModel(model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const r = await withBackoff(() => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { text: '\n\n--- EXAM PDF ---' },
          { inlineData: { mimeType: 'application/pdf', data: examBase64 } },
          { text: '\n\n--- SOLUTION PDF ---' },
          { inlineData: { mimeType: 'application/pdf', data: solutionBase64 } },
        ] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          mediaResolution: 'MEDIA_RESOLUTION_HIGH',
        },
      }),
      signal: AbortSignal.timeout(60000),
    }), { maxRetries: 2, delaysMs: [2000, 8000], label: `solution-analyze/${model}` });
    if (!r || !r.ok) {
      const errText = r ? await r.text().catch(() => '') : '';
      const status = r?.status || 0;
      console.warn(`[solution-analyze] ${model} ${status}:`, errText.slice(0, 300));
      return status === 429 ? { quota_exceeded: true } : null;
    }
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    try {
      const parsed = JSON.parse(text.trim());
      return { parsed, model };
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { return { parsed: JSON.parse(m[0]), model }; } catch {} }
      return null;
    }
  }

  // Upload-path call — must stay fast. Uses FAST chain (flash models only).
  // The user-visible accuracy comes from the combination of analyzeSolutionPdf
  // + scanExamHighlights + pass1/pass2 text extraction, cross-verified with
  // Groq; a single flash call is plenty for answer-key extraction with the
  // hardened prompt. Pro-preview is reserved for on-demand per-question
  // enhancement where the user is waiting for a specific question.
  const models = MODEL_CHAIN.extraction;
  for (const model of models) {
    try {
      const primaryKey = paidKey || freeKey;
      const fallbackKey = paidKey ? freeKey : null;
      let res = primaryKey ? await callModel(model, primaryKey) : null;
      if (res?.quota_exceeded && fallbackKey) {
        console.warn(`[solution-analyze] ${model} primary key quota exceeded — switching to fallback key`);
        res = await callModel(model, fallbackKey);
      }
      if (!res?.parsed) continue;

      const p = res.parsed;
      let matchVerdict = 'unknown';
      if (p.match === true) matchVerdict = 'match';
      else if (p.match === false) matchVerdict = 'mismatch';
      const confidence = typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0;

      const LETTER_TO_IDX = { 'א':1, 'ב':2, 'ג':3, 'ד':4, 'ה':5, 'ו':6, 'ז':7, 'ח':8, 'ט':9, 'י':10 };
      const answers = {};
      const mismatches = [];
      if (Array.isArray(p.answers)) {
        for (const item of p.answers) {
          const q = parseInt(item?.q, 10);
          let ans = parseInt(item?.ans, 10);
          const letter = typeof item?.ans_letter === 'string' ? item.ans_letter.trim() : '';
          const letterIdx = LETTER_TO_IDX[letter] || null;
          let conf = typeof item?.confidence === 'number' ? item.confidence : 1;

          // Cross-check: when both are present and disagree, trust the letter
          // (less error-prone than index arithmetic) and drop confidence so
          // downstream cross-validation can flag it.
          if (letterIdx && ans >= 1 && ans <= 10 && letterIdx !== ans) {
            mismatches.push({ q, ans_numeric: ans, ans_letter: letter, picked: letterIdx });
            ans = letterIdx;
            conf = Math.min(conf, 0.5);
          } else if (letterIdx && (!ans || ans < 1 || ans > 10)) {
            ans = letterIdx;
          }

          if (q > 0 && ans >= 1 && ans <= 10 && conf >= 0.3) {
            answers[String(q)] = ans;
          }
        }
      }
      if (mismatches.length) {
        console.warn(`[solution-analyze] ${mismatches.length} letter/index mismatches — trusting letter:`, JSON.stringify(mismatches));
      }

      console.log(`[solution-analyze] ${model}: match=${matchVerdict} conf=${confidence.toFixed(2)} answers=${Object.keys(answers).length}/${questionNumbers.length} reasoning="${(p.reasoning || '').slice(0, 100)}"`);
      const rawItems = [];
      if (Array.isArray(p.answers) && p.answers.length > 0) {
        for (const item of p.answers) {
          const accepted = answers[String(parseInt(item?.q, 10))] !== undefined;
          const entry = { q: item?.q, ans: item?.ans, conf: item?.confidence, method: item?.method, accepted, quote: (item?.source_quote || '').slice(0, 120) };
          rawItems.push(entry);
          console.log(`[solution-analyze]   Q${item?.q}: ans=${item?.ans} conf=${item?.confidence?.toFixed?.(2) ?? item?.confidence} method=${item?.method} accepted=${accepted} quote="${entry.quote}"`);
        }
      }
      return { match: matchVerdict, confidence, answers, rawItems, model: res.model, reasoning: p.reasoning || null };
    } catch (e) {
      console.warn(`[solution-analyze] ${model} exception:`, e?.message || e);
    }
  }
  return { match: 'unknown', confidence: 0, answers: {}, model: null };
}

// =====================================================
// Solution-only answer extractor — used by add-solution endpoint.
// Unlike analyzeSolutionPdf, this takes only the solution PDF (no exam PDF)
// and trusts that the question numbers provided are correct.
// Returns: { answers: {qNumber: answerIdx}, rawItems }
// =====================================================
async function extractAnswersFromSolutionOnly(solutionBase64, questionNumbers) {
  const { paidKey, freeKey } = getGeminiKeys();
  if (!freeKey && !paidKey) return { answers: {}, rawItems: [] };

  const nums = questionNumbers.slice(0, 60).join(', ');
  const prompt = `You are analyzing a Hebrew university exam SOLUTION PDF (answer key).

The exam has questions numbered: ${nums}

Extract the correct answer for EVERY question from this solution PDF.

Answers can come from any of these sources:
  1. A SUMMARY TABLE ("שאלה | תשובה") — most reliable.
  2. A DEDICATED ANSWER KEY: "1. ב", "1) א", "תשובה 1: ב", "ת. 1: ג".
  3. AN EXPLICIT DECLARATION inline: "לכן התשובה היא ב", "התשובה הנכונה היא א", "הפתרון: א", "התשובה הנכונה היתה ט'".
  4. AN EXPLANATION PARAGRAPH whose CONCLUSION matches ONE SPECIFIC OPTION.
  5. A HIGHLIGHTED / CIRCLED option — colored highlight, circle, checkmark (✓), arrow (→).

⚠️ AVOID THE WRONG-OPTION TRAP:
Explanations often MENTION wrong options to dismiss them ("ג שגויה כי...", "אפשרות ב אינה נכונה"). DO NOT pick the letter of a dismissed option — pick the one AFFIRMED as correct.

IMPORTANT — 10-option exams: biology/genetics/chemistry exams commonly have 6–10 options labeled א,ב,ג,ד,ה,ו,ז,ח,ט,י. Map letters to indices:
  א=1, ב=2, ג=3, ד=4, ה=5, ו=6, ז=7, ח=8, ט=9, י=10
Accept both Hebrew letters and digits. Return numeric index in "ans".

Return ONLY this JSON object (no markdown):
{
  "answers": [
    {"q": <question number>, "ans": <integer 1..10>, "method": "<table|list|conclusion|explanation|highlight>", "confidence": <0.0-1.0>, "source_quote": "<brief quote ≤120 chars>"}
  ]
}

Rules:
- "source_quote" is required for every entry.
- Report "confidence" honestly (the server accepts ≥ 0.3).
- Scan EVERY page, including the last page where summary tables often live.
- Be EXHAUSTIVE — return every question that has a determinable answer.`;

  async function callModel(model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inlineData: { mimeType: 'application/pdf', data: solutionBase64 } },
        ] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          mediaResolution: 'MEDIA_RESOLUTION_HIGH',
        },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn(`[solution-only] ${model} ${r.status}:`, errText.slice(0, 300));
      return r.status === 429 ? { quota_exceeded: true } : null;
    }
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    try {
      const parsed = JSON.parse(text.trim());
      return { parsed, model };
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { return { parsed: JSON.parse(m[0]), model }; } catch {} }
      return null;
    }
  }

  const models = MODEL_CHAIN.critical;
  for (const model of models) {
    try {
      const primaryKey = paidKey || freeKey;
      const fallbackKey = paidKey ? freeKey : null;
      let res = primaryKey ? await callModel(model, primaryKey) : null;
      if (res?.quota_exceeded && fallbackKey) {
        console.warn(`[solution-only] ${model} primary key quota exceeded — switching to fallback key`);
        res = await callModel(model, fallbackKey);
      }
      if (!res?.parsed) continue;

      const p = res.parsed;
      const answers = {};
      const rawItems = [];

      if (Array.isArray(p.answers)) {
        for (const item of p.answers) {
          const q = parseInt(item?.q, 10);
          const ans = parseInt(item?.ans, 10);
          const conf = typeof item?.confidence === 'number' ? item.confidence : 1;
          const quote = (typeof item?.source_quote === 'string' ? item.source_quote : '');
          // Trust Gemini. No quote-based rejection — it was blocking valid
          // answers whenever Gemini happened to cite a dismissal sentence.
          const accepted = q > 0 && ans >= 1 && ans <= 10 && conf >= 0.3;
          rawItems.push({ q, ans, conf, method: item?.method, accepted, quote: quote.slice(0, 120) });
          if (accepted) {
            answers[String(q)] = ans;
            console.log(`[solution-only]   Q${q}: ans=${ans} conf=${conf.toFixed(2)} method=${item?.method}`);
          }
        }
      }

      console.log(`[solution-only] ${model}: extracted ${Object.keys(answers).length}/${questionNumbers.length} answers`);
      return { answers, rawItems };
    } catch (e) {
      console.warn(`[solution-only] ${model} exception:`, e?.message || e);
    }
  }
  return { answers: {}, rawItems: [] };
}

// =====================================================
// Dedicated VISUAL highlight scanner.
// The main analyzeExamWithGemini prompt asks Gemini to do many things at once
// (MCQ detection + coordinates + groups + option counts + correct answer).
// Highlight detection falls through the cracks.
// This function's ONE job: find highlighted/circled/checkmarked answers.
// Called as a safety net when the main pass didn't populate any answers.
// Returns: { "q": ansIdx, ... }
// =====================================================
async function scanExamHighlights(examBase64, questionNumbers) {
  const { paidKey, freeKey } = getGeminiKeys();
  if (!freeKey && !paidKey) return {};
  // questionNumbers is optional. When an empty array is passed (e.g. when
  // the scanner runs in the initial parallel phase BEFORE MCQ detection),
  // Gemini is instructed to find every marked question on its own.

  const nums = (questionNumbers && questionNumbers.length > 0)
    ? questionNumbers.slice(0, 80).join(', ')
    : 'ALL';
  const prompt = `You are scanning a Hebrew exam PDF that has visible marks on correct answers.
Your ONE job: for each question, identify the CORRECT answer from visible marks.

Questions to check: ${nums === 'ALL' ? 'EVERY question found in the PDF — scan page by page.' : nums}

Scan EVERY option of EVERY question for ANY of these marks:
  • YELLOW / green / blue / pink / gray HIGHLIGHT over the option text or its letter
  • CIRCLE drawn around the option letter (א / ב / ג / ד / ה / ו / ז / ח / ט / י or 1-10)
  • CHECKMARK (✓ / V / ✔) next to the option
  • ARROW (→ ← ⇦) pointing at the option
  • Hand-drawn pen / pencil mark (stroke, underline, star, X-out of others)
  • BOLD / italic / underline / different color on ONE option while others are normal
  • ANY visual differentiation — one option formatted differently from the others

The exam FILE typically has ONE visible mark per question, on the correct option.
Do NOT guess theoretically. ONLY report answers for questions where you SEE a mark.

⚠️ CRITICAL — Hebrew letter → index mapping (memorize):
  א=1   ב=2   ג=3   ד=4   ה=5
  ו=6   ז=7   ח=8   ט=9   י=10
  (digits 1-10 work directly)

⚠️ ט vs י CONFUSION: In 10-option biology/genetics exams the highlight often
lands on the LAST option "י" (10). "ט" (9) is the SECOND-TO-LAST. Before
committing, COUNT options from top to bottom on that question and confirm the
row position. If the marked option is the LAST one, answer MUST be י (10),
not ט (9).

⚠️ For every answer, ALSO copy the verbatim TEXT of the marked option
(up to 80 chars) into "option_text". The server uses this to cross-check
against the extracted option list — if your letter disagrees with the text,
we mark the answer uncertain so the user can verify.

Scan the ENTIRE PDF — every page, every option. Be exhaustive.
Return ONLY this JSON (no markdown):
{
  "answers": [
    {
      "q": <question number>,
      "ans": <integer 1-10>,
      "option_text": "<verbatim text of the marked option, ≤80 chars>",
      "total_options": <integer 2-10: how many options this question has>,
      "mark": "<highlight|circle|check|arrow|bold|handwritten|other>",
      "note": "<one-phrase Hebrew description of where/how the mark appears, ≤80 chars>"
    }
  ]
}

Rules:
- Include ONLY questions with a clearly visible mark. Skip if no mark.
- If TWO options look marked, pick the more strongly marked one.
- "option_text" is REQUIRED — do NOT omit it.
- "total_options" is REQUIRED — count all options for that specific question.
- Return as many as you find — aim for ALL marked questions.`;

  async function callModel(model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inlineData: { mimeType: 'application/pdf', data: examBase64 } },
        ] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
          mediaResolution: 'MEDIA_RESOLUTION_HIGH',
        },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn(`[highlight-scan] ${model} ${r.status}:`, errText.slice(0, 200));
      return r.status === 429 ? { quota_exceeded: true } : null;
    }
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    try { return { parsed: JSON.parse(text.trim()), model }; }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { return { parsed: JSON.parse(m[0]), model }; } catch {} }
      return null;
    }
  }

  const primaryKey = paidKey || freeKey;
  const fallbackKey = paidKey && freeKey ? freeKey : null;
  // Upload-path call — must stay fast. Uses FAST chain (flash models only).
  // Highlight scan is one of several answer sources; pro-preview here would
  // block the whole upload on a single parallel task. 2.5-flash is very good
  // at visual highlight detection with the hardened prompt.
  for (const model of MODEL_CHAIN.extraction) {
    let res = await callModel(model, primaryKey);
    if (res?.quota_exceeded && fallbackKey) {
      console.warn(`[highlight-scan] ${model}: switching to fallback key`);
      res = await callModel(model, fallbackKey);
    }
    if (!res?.parsed) continue;
    const out = {};
    const details = {}; // { qNum: { ans, optionText, totalOptions } }
    if (Array.isArray(res.parsed.answers)) {
      for (const item of res.parsed.answers) {
        const q = parseInt(item?.q, 10);
        const ans = parseInt(item?.ans, 10);
        if (q > 0 && ans >= 1 && ans <= 10) {
          out[String(q)] = ans;
          details[String(q)] = {
            ans,
            optionText: (item?.option_text || '').toString().trim().slice(0, 200),
            totalOptions: parseInt(item?.total_options, 10) || null,
            mark: item?.mark || null,
          };
          console.log(`[highlight-scan]   Q${q}: ans=${ans}/${item?.total_options || '?'} text="${(item?.option_text || '').slice(0, 40)}" mark=${item?.mark || '?'}`);
        }
      }
    }
    console.log(`[highlight-scan] ${model}: found ${Object.keys(out).length}/${questionNumbers.length} marks`);
    if (Object.keys(out).length > 0) {
      // Attach details under a non-enumerable-ish key so existing callers
      // that do Object.entries(result) still get only the answers.
      Object.defineProperty(out, '_details', { value: details, enumerable: false });
      return out;
    }
  }
  return {};
}

// =====================================================
function normalizeGeminiMcqs(raw) {
  if (!Array.isArray(raw)) return [];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return raw
    .filter(q => q && (typeof q.n === 'number' || typeof q.n === 'string') && String(q.n).trim() !== '' && !isNaN(parseInt(q.n, 10)))
    .map(q => {
      const rawNumOpts = parseInt(q.num_options, 10);
      const numOptions = Number.isFinite(rawNumOpts) ? clamp(rawNumOpts, 2, 10) : 4;
      const ctxFromGemini = (q.context_text && typeof q.context_text === 'string' && q.group_id)
        ? q.context_text.trim().slice(0, 4000) || null
        : null;

      // Compute bounding-box in PDF points. Modest top padding only — the
      // bottom is clamped in upload.mjs to avoid bleeding into the next MCQ.
      const pageH = q.page_h || 842;
      const rawYtopRaw = q.y_top;
      const rawYbotRaw = q.y_bottom;
      const rawYtopPct = Math.max(0, Math.min(100, (rawYtopRaw ?? 0)));
      const rawYbotPct = Math.max(0, Math.min(100, (rawYbotRaw ?? (rawYtopPct + 25))));
      let yTop = Math.max(0, (rawYtopPct / 100) * pageH - 12);
      let yBottom = (rawYbotPct / 100) * pageH;
      // Guarantee a sane minimum height so degenerate Gemini boxes
      // (y_top=47 / y_bottom=48) don't produce 5-pixel crops. The
      // clampYBottomToNextMcq pass in upload.mjs will shrink this again
      // if it would overlap the next MCQ.
      const minHeightPt = Math.max(80, numOptions * 18 + 30);
      if (yBottom - yTop < minHeightPt) {
        yBottom = Math.min(pageH - 5, yTop + minHeightPt);
      }
      // Flag degenerate bbox: Gemini returned no y_top/y_bottom or both ~0.
      // Upload pipeline uses this to fall back to a full-page crop instead
      // of producing a tiny header-strip image.
      const _bboxInvalid =
        (rawYtopRaw == null && rawYbotRaw == null) ||
        (rawYtopPct === 0 && rawYbotPct <= 25);

      const rawPage = parseInt(q.page, 10);
      const safePage = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

      return {
        section: String(q.n),
        number: typeof q.n === 'number' ? q.n : parseInt(q.n, 10),
        page: safePage,
        yTop,
        yBottom,
        pageWidth: q.page_w || 595,
        pageHeight: pageH,
        numOptions,
        _geminiCorrect: (q.correct != null && Number.isFinite(parseInt(q.correct, 10)))
          ? clamp(parseInt(q.correct, 10), 1, 10) : null,
        _fromGemini: true,
        _bboxInvalid,
        groupId: q.group_id || null,
        contextYTop: (q.context_y_top != null && q.group_id)
          ? Math.max(0, (q.context_y_top / 100) * pageH - 5)
          : null,
        contextPage: (q.context_page != null && q.group_id) ? q.context_page : null,
        contextTextFromGemini: ctxFromGemini,
      };
    });
}

// Legacy wrapper — kept for upload.mjs call-sites.
async function verifySolutionMatchesExam(examBase64, solutionBase64, questionNumbers) {
  const r = await analyzeSolutionPdf(examBase64, solutionBase64, questionNumbers);
  return r.match;
}

// ── shared Gemini JSON caller ────────────────────────────────────────────────
// Used exclusively by reanalyzeSingleQuestion for focused per-question work.
// Uses ACCURATE chain (pro-preview first) because:
//   1. The user is waiting for ONE question — latency matters less than
//      accuracy (correct bounding box / correct answer identification).
//   2. The payload is a SINGLE page image or a small prompt, so pro-preview
//      responds fast here even though it's slow on full PDFs.
async function callGeminiJson(parts, freeKey, paidKey, label) {
  async function tryModel(model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          mediaResolution: 'MEDIA_RESOLUTION_HIGH',
        },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn(`[${label}] ${model} ${r.status}:`, errText.slice(0, 200));
      return r.status === 429 ? 'quota' : null;
    }
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    try { return JSON.parse(text.trim()); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch {} }
      return null;
    }
  }
  const primaryKey = paidKey || freeKey;
  const fallbackKey = paidKey && freeKey ? freeKey : null;
  for (const model of MODEL_CHAIN.critical) {
    let result = await tryModel(model, primaryKey);
    if (result === 'quota' && fallbackKey) result = await tryModel(model, fallbackKey);
    if (result && result !== 'quota') return result;
  }
  return null;
}

// =====================================================
// Focused single-question re-analysis — THREE PHASES:
//   Phase 1 (existing image)   → validate completeness + OCR (cheap, fast)
//   Phase 2 (exam PDF only)    → re-locate + new bounding box (only if Phase 1 fails)
//   Phase 3 (solution PDF)     → correct answer identification (image context included)
//
// Phase 1 preserves a good existing crop instead of overwriting it with imprecise
// PDF-scan coordinates. Phase 3 sends the question image alongside the solution PDF
// so Gemini can visually confirm which question it is answering.
// =====================================================
async function reanalyzeSingleQuestion(examBase64, solBase64, questionNumber, contextPromptBlock, existingImageBase64 = null, expectedNumOptions = 0, fetchPageImageFn = null) {
  const { paidKey, freeKey } = getGeminiKeys();
  if (!freeKey && !paidKey) return null;
  const qNum = parseInt(questionNumber, 10);
  if (!Number.isFinite(qNum) || qNum < 1) return null;

  const ctxSection = contextPromptBlock
    ? `\n\n=== KNOWN CONTEXT ===\n${contextPromptBlock}\n=== END CONTEXT ===\n`
    : '';

  let loc = null;
  let imageOk = false;

  // ── PHASE 1: validate existing question image ────────────────────────────
  if (existingImageBase64) {
    const valPrompt = `You are analyzing a Hebrew multiple-choice exam question image.
The target question is number ${qNum}. The image MUST contain only question ${qNum}.

Examine the image carefully and return ONLY this JSON (no markdown):
{
  "question_header_visible": <true if the header of question ${qNum} ("שאלה ${qNum}", "${qNum}.", "(${qNum})") appears in the TOP THIRD of the image>,
  "single_question": <true ONLY when the image contains exactly the content of question ${qNum} — its stem and all its options — AND NO heading/stem/options of any OTHER question number. false if you see any line like "${Math.max(1, qNum - 1)}.", "${qNum + 1}.", "שאלה ${qNum + 1}", or any other question number anywhere in the image>,
  "complete": <true ONLY when question_header_visible=true AND single_question=true AND every option of question ${qNum} is fully readable with no text cut off>,
  "num_options": <integer 2-10, count ONLY options that clearly belong to question ${qNum}, not options of neighboring questions>,
  "question_text": "<verbatim Hebrew stem of question ${qNum} only, up to 800 chars>",
  "options": {"1": "<option 1 text>", "2": "<option 2 text>", ...}
}
Rules:
- question_header_visible=false if the question number heading is absent or appears below the top third of the image.
- single_question=false if ANY visible line looks like a DIFFERENT question's heading (another "N.", "שאלה N", or "(N)" for N≠${qNum}).
- complete=false whenever single_question=false or question_header_visible=false or ANY option text is cut off at an edge.
- Count only FULL option labels for question ${qNum} — do not count options of adjacent questions, and do not guess missing ones.`;

    const valParts = [
      { text: valPrompt },
      { inlineData: { mimeType: 'image/png', data: existingImageBase64 } },
    ];

    const val = await callGeminiJson(valParts, freeKey, paidKey, 'reanalyze-validate');
    // Require: complete=true, header visible, single_question=true, AND at least as many options as stored
    const minOpts = Math.max(2, expectedNumOptions || 0);
    const optsOk = typeof val?.num_options === 'number' && val.num_options >= minOpts;
    const singleOk = val?.single_question === true;
    if (val && val.complete === true && val.question_header_visible === true && singleOk && optsOk) {
      console.log(`[reanalyze-validate] Q${qNum}: image OK — ${val.num_options} options visible`);
      loc = {
        num_options: val.num_options,
        question_text: val.question_text,
        options: val.options,
        image_ok: true,
      };
      imageOk = true;
    } else {
      console.warn(`[reanalyze-validate] Q${qNum}: image rejected (complete=${val?.complete}, header=${val?.question_header_visible}, single=${val?.single_question}, opts=${val?.num_options}/${minOpts}) — falling back to PDF scan`);
    }
  }

  // ── PHASE 2: locate question using rendered page image ───────────────────
  // Strategy: ask Gemini only "which page?" (simple, reliable), then fetch
  // that page as a rendered PNG from Cloudinary and ask Gemini for PIXEL
  // coordinates on the image (far more accurate than PDF percentage guesses).
  if (!imageOk) {
    if (!examBase64) {
      console.warn(`[reanalyze-q] Q${qNum}: no exam PDF and no usable image — cannot proceed`);
      return null;
    }

    // Step 2a: find page number from full PDF (simple question → very reliable)
    const pagePrompt = `In the attached Hebrew exam PDF, which 1-based page number contains question number ${qNum}?
Look for a heading such as "שאלה ${qNum}", "(${qNum})" or "${qNum}." at the start of a question block.
Return ONLY this JSON: {"page": <integer>}
If not found return {"page": null}.`;

    const pageParts = [
      { text: pagePrompt },
      { inlineData: { mimeType: 'application/pdf', data: examBase64 } },
    ];

    const pageResult = await callGeminiJson(pageParts, freeKey, paidKey, 'reanalyze-page');
    const questionPage = pageResult?.page != null ? parseInt(pageResult.page, 10) : null;

    if (fetchPageImageFn && Number.isInteger(questionPage) && questionPage >= 1 && questionPage <= 100) {
      // Step 2b: fetch the full rendered page image (already at CLOUDINARY_RENDER_W pixels wide)
      console.log(`[reanalyze-page] Q${qNum}: found on page ${questionPage} — fetching rendered image`);
      const pageImg = await fetchPageImageFn(questionPage);

      if (pageImg?.base64) {
        // Step 2c: locate bounding box in pixel space on the rendered image.
        // Ask Gemini for the EXACT header-line y and the last-option y separately.
        const lastOptHint = expectedNumOptions >= 2 ? `option ${expectedNumOptions} (the last one)` : 'the last visible option';
        const bboxPrompt = `You are looking at a rendered page of a Hebrew university exam (1600px wide PNG).
${ctxSection}
TASK: Find question number ${qNum} and report its exact pixel bounding box.

STEP 1 — Locate the question header:
Search for the text "שאלה ${qNum}" or "${qNum}." or "(${qNum})" or "${qNum})" in the image.
This is the question's OWN header line. Write down the pixel row (y coordinate from image top) of the FIRST character of that header text.

⚠️ CRITICAL — Do NOT start above the "שאלה ${qNum}" header:
  • Any block labeled "הבהרה", "הערה", "הגדרה", or containing a separate question number OTHER than ${qNum} that appears BEFORE "שאלה ${qNum}" is part of a DIFFERENT question.
  • y_top_px must be the row of "שאלה ${qNum}" itself — not the row of any earlier content.

STEP 2 — Locate the last answer option:
Count every answer option for question ${qNum} (labeled א/ב/ג/ד or 1/2/3/4).
We expect ${expectedNumOptions >= 2 ? expectedNumOptions : 'at least 2'} options. Find ${lastOptHint} and write down the pixel row of its last text line.
y_bottom_px = that row (the last line of the last option text).

Return ONLY this JSON (no markdown, no extra keys):
{
  "y_top_px": <integer — row of "שאלה ${qNum}" header line>,
  "y_bottom_px": <integer — row of last option's final text line>,
  "num_options": <integer 2-10>,
  "question_text": "<verbatim Hebrew question stem only, up to 800 chars>",
  "options": {"1": "<text>", "2": "<text>", ...}
}
If "שאלה ${qNum}" is not visible on this page, return {"error": "not_found"}.`;

        const bboxParts = [
          { text: bboxPrompt },
          { inlineData: { mimeType: 'image/png', data: pageImg.base64 } },
        ];

        const bbox = await callGeminiJson(bboxParts, freeKey, paidKey, 'reanalyze-bbox');
        if (bbox && !bbox.error && Number.isFinite(bbox.y_top_px) && Number.isFinite(bbox.y_bottom_px) && bbox.y_bottom_px > bbox.y_top_px) {
          console.log(`[reanalyze-bbox] Q${qNum}: p${questionPage} y=[${bbox.y_top_px}px,${bbox.y_bottom_px}px] opts=${bbox.num_options}`);
          loc = {
            page: questionPage,
            y_top_px: bbox.y_top_px,
            y_bottom_px: bbox.y_bottom_px,
            num_options: bbox.num_options,
            question_text: bbox.question_text,
            options: bbox.options,
            image_ok: false,
            pixel_coords: true,
          };
        } else {
          console.warn(`[reanalyze-bbox] Q${qNum}: bbox call failed or not_found on page ${questionPage}`);
        }
      } else {
        console.warn(`[reanalyze-page] Q${qNum}: could not fetch rendered page ${questionPage} image`);
      }
    }

    // Fallback: percentage-based PDF scan (used when no fetchPageImageFn or page-render path failed)
    if (!loc) {
      const locPrompt = `You are analyzing ONE Hebrew university MCQ. Target: question number ${qNum}.
${ctxSection}
Find question #${qNum} in the attached exam PDF and return its bounding box and verbatim content.

Rules for the bounding box:
  • y_top    = % from top of the page where the question-number line starts. Err ~5% ABOVE to avoid cutting off the header.
  • y_bottom = % from top where the LAST option's text ends. Err ~5% BELOW. Must include ALL answer options.
  • The box must contain: question number, full stem, AND every option (up to 10 for biology exams).

Return ONLY this JSON (no markdown, no extra keys):
{
  "page": <1-based page number>,
  "y_top": <float 0–100>,
  "y_bottom": <float 0–100>,
  "page_w": <page width in pt, usually 595>,
  "page_h": <page height in pt, usually 842>,
  "num_options": <integer 2–10, count every visible option>,
  "question_text": "<verbatim Hebrew stem, up to 800 chars>",
  "options": {"1": "<option 1 text>", "2": "<option 2 text>", ...}
}
If question #${qNum} cannot be found, return {"error": "not_found"}.`;

      const locParts = [
        { text: locPrompt },
        { text: '\n\n--- EXAM PDF ---' },
        { inlineData: { mimeType: 'application/pdf', data: examBase64 } },
      ];

      const locResult = await callGeminiJson(locParts, freeKey, paidKey, 'reanalyze-locate');
      if (!locResult || locResult.error === 'not_found') {
        console.warn(`[reanalyze-q] Q${qNum}: locate call failed or not_found`);
        return null;
      }
      if (typeof locResult.y_top !== 'number' || typeof locResult.y_bottom !== 'number') {
        console.warn(`[reanalyze-q] Q${qNum}: locate call missing y coords`);
        return null;
      }
      console.log(`[reanalyze-locate] Q${qNum}: p${locResult.page} y=[${locResult.y_top},${locResult.y_bottom}] opts=${locResult.num_options}`);
      loc = { ...locResult, image_ok: false, pixel_coords: false };
    }
  }

  // ── PHASE 3: identify correct answer from solution PDF ───────────────────
  if (solBase64) {
    const stem = (loc.question_text || `שאלה ${qNum}`).slice(0, 500);
    const ansPrompt = `You are finding the correct answer for question number ${qNum} in an official Hebrew university solution document.

The question stem is: "${stem}"
${existingImageBase64 ? 'The attached image shows the question as it appears in the exam — use it to visually confirm you are reading the right question in the solution.\n' : ''}
Search the solution document in this EXACT priority order:
1. SUMMARY TABLE — find row ${qNum} in a grid with columns "שאלה | תשובה" or "Q | A". That cell's letter is the answer.
2. EXPLICIT KEY LINE — e.g. "${qNum}. א", "${qNum}) ב", "תשובה ${qNum}: א", "ת. ${qNum}: ב", "${qNum}: א".
3. EXPLICIT DECLARATION — a sentence like: "לכן התשובה היא א", "הפתרון: ב", "התשובה הנכונה: א", "אם כן, א נכונה".
4. EXPLANATION CONCLUSION — the option the solution text AFFIRMS at the very end of the explanation.
5. VISUAL MARK — a highlighted, circled, or checked option in the solution document.

⚠️ WRONG-OPTION TRAP — READ THIS CAREFULLY:
Solution explanations often MENTION wrong options to dismiss them:
  "ג שגויה כי...", "אפשרות ב אינה נכונה", "מסיח ג שגוי כי...", "ב אינה התשובה"
These are DISTRACTORS being eliminated. DO NOT pick them as the answer.
The CORRECT option is the one the document AFFIRMS, not the one it argues against.
The affirmation language is: "לכן", "אם כן", "מכאן ש", "הנכונה היא", "הפתרון הוא", "נסיק כי".

Hebrew letter → number: א=1  ב=2  ג=3  ד=4  ה=5  ו=6  ז=7  ח=8  ט=9  י=10

Return ONLY this JSON (no markdown):
{
  "correct_idx": <integer 1–10, or null if truly not determinable>,
  "confidence": <0.0–1.0>,
  "found_via": "<summary_table|explicit_key|declaration|explanation_conclusion|visual_mark|not_found>",
  "quote": "<exact phrase from the document that reveals the answer, max 200 chars>"
}`;

    const ansParts = [
      // Only include the existing image in Phase 3 when Phase 1 confirmed it is complete.
      // Passing a broken/cropped image would mislead Gemini about which options exist.
      ...(imageOk && existingImageBase64 ? [{ inlineData: { mimeType: 'image/png', data: existingImageBase64 } }] : []),
      { text: ansPrompt },
      { text: '\n\n--- SOLUTION PDF ---' },
      { inlineData: { mimeType: 'application/pdf', data: solBase64 } },
    ];

    const ans = await callGeminiJson(ansParts, freeKey, paidKey, 'reanalyze-answer');
    if (ans && ans.correct_idx != null) {
      const idx = parseInt(ans.correct_idx, 10);
      if (Number.isFinite(idx) && idx >= 1 && idx <= 10) {
        console.log(`[reanalyze-answer] Q${qNum}: correct_idx=${idx} via=${ans.found_via} conf=${ans.confidence} quote="${(ans.quote || '').slice(0, 120)}"`);
        loc.correct_idx = idx;
        loc.confidence  = typeof ans.confidence === 'number' ? ans.confidence : 0.85;
      } else {
        console.warn(`[reanalyze-answer] Q${qNum}: invalid idx=${ans.correct_idx}`);
        loc.correct_idx = null;
        loc.confidence  = 0;
      }
    } else {
      console.warn(`[reanalyze-answer] Q${qNum}: no answer found in solution PDF (found_via=${ans?.found_via})`);
      loc.correct_idx = null;
      loc.confidence  = 0;
    }
  } else {
    loc.correct_idx = null;
    loc.confidence  = 0;
  }

  return loc;
}

// =====================================================
// detectSolutionPages — for each question number, find which page of the
// solution PDF contains that question's answer/explanation.
//
// Called by upload.mjs (once per exam upload) so the frontend "תקן תשובה"
// button can open the solution PDF directly at the right page. Uses the FAST
// model chain — this is a single scan, not per-question, and latency matters
// since upload already has a 300s maxDuration ceiling.
//
// Returns: { <questionNumber>: <solutionPage>, ... }. Missing entries mean
// "didn't find" — caller falls back to exam pdf_page or page 1.
// =====================================================
async function detectSolutionPages(solutionBase64, questionNumbers) {
  const { paidKey, freeKey } = getGeminiKeys();
  if (!freeKey && !paidKey) return {};
  if (!solutionBase64 || !Array.isArray(questionNumbers) || questionNumbers.length === 0) return {};

  const nums = questionNumbers.slice(0, 80).join(', ');
  const prompt = `You are analyzing a Hebrew university exam SOLUTION PDF.

The exam has questions numbered: ${nums}

For EVERY question, identify which page (1-based) of this solution PDF contains the answer or explanation for that question. A question may have its solution on the SAME page as another question's solution — that's fine. Scan all pages.

Signs that a page contains a specific question's solution:
- The question number appears at the start of a block ("שאלה 5", "5.", "ת. 5", "תשובה 5:", "5)", "(5)").
- An explanation paragraph that clearly addresses that question (refers to its options or its stem topic).
- A summary table entry for that question number — the page containing the table counts as that question's solution page.
- A highlighted/circled option that corresponds to that question number.

Return ONLY this JSON (no markdown):
{
  "pages": [
    {"q": <question number>, "page": <integer 1-based>, "confidence": <0.0-1.0>}
  ]
}

Rules:
- Include every exam question number you can locate; skip only those you genuinely cannot find.
- "page" MUST be a positive integer. If a solution spans two pages, return the page where the answer DECLARATION (the letter/number) appears.
- Report confidence honestly; values ≥ 0.4 will be accepted.`;

  async function callModel(model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inlineData: { mimeType: 'application/pdf', data: solutionBase64 } },
        ] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
        },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn(`[detect-sol-pages] ${model} ${r.status}:`, errText.slice(0, 200));
      return r.status === 429 ? { quota_exceeded: true } : null;
    }
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    try { return { parsed: JSON.parse(text.trim()), model }; }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { return { parsed: JSON.parse(m[0]), model }; } catch {} }
      return null;
    }
  }

  // Use the FAST chain — this is time-sensitive (upload has a 300s ceiling).
  const models = MODEL_CHAIN.extraction;
  for (const model of models) {
    try {
      const primaryKey = paidKey || freeKey;
      const fallbackKey = paidKey ? freeKey : null;
      let res = primaryKey ? await callModel(model, primaryKey) : null;
      if (res?.quota_exceeded && fallbackKey) {
        console.warn(`[detect-sol-pages] ${model} quota exceeded — switching to fallback key`);
        res = await callModel(model, fallbackKey);
      }
      if (!res?.parsed) continue;
      const out = {};
      const items = Array.isArray(res.parsed.pages) ? res.parsed.pages : [];
      for (const item of items) {
        const q = parseInt(item?.q, 10);
        const pg = parseInt(item?.page, 10);
        const conf = typeof item?.confidence === 'number' ? item.confidence : 1;
        if (q > 0 && pg > 0 && conf >= 0.4) out[String(q)] = pg;
      }
      console.log(`[detect-sol-pages] ${model}: mapped ${Object.keys(out).length}/${questionNumbers.length} questions → pages`);
      return out;
    } catch (e) {
      console.warn(`[detect-sol-pages] ${model} exception:`, e?.message || e);
    }
  }
  return {};
}

export {
  analyzeExamWithGemini,
  classifyPdfWithGemini,
  analyzeSolutionPdf,
  extractAnswersFromSolutionOnly,
  scanExamHighlights,
  reanalyzeSingleQuestion,
  detectSolutionPages,
  normalizeGeminiMcqs,
  verifySolutionMatchesExam,
};
