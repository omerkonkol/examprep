// Gemini-based solution PDF analysis and exam MCQ detection.
// Extracted from api/upload.mjs so add-solution.mjs can share this logic.

// =====================================================
async function analyzeExamWithGemini(examPdfBase64, solPdfBase64) {
  const freeKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  const paidKey = (process.env.GEMINI_API_KEY_PAID || '').replace(/\\n/g, '').trim();
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
  "y_top": percentage from top where the "שאלה N" LABEL LINE starts — must be AT or ABOVE the top edge of the "שאלה X" text itself, not below it. If unsure, subtract ~2% from your estimate to ensure the label is included. (0-100),
  "y_bottom": percentage from top where the LAST option ends (0-100),
  "group_id": null if standalone; short string like "A" or "B" if this question shares a context block with others (all questions in the same context get the same group_id),
  "context_y_top": percentage from top of context_page where shared content STARTS — the very top of the figure/passage/table (only when group_id != null; null otherwise),
  "context_page": page number (1-based) where shared context lives (only when group_id != null; null otherwise),
  "correct": correct answer index (1-4) if known, else null,
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
    for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash']) {
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
              // responseSchema omitted — uppercase types cause silent failures in some API versions
            },
          }),
          signal: AbortSignal.timeout(40000),
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
  "y_top": % from top where the question label/stem begins (0-100),
  "y_bottom": % from top where the last option ends (0-100),
  "group_id": null, OR short string shared by all questions in one context-set,
  "context_y_top": % from top where shared context begins (null if group_id is null),
  "context_page": page of shared context (null if group_id is null),
  "correct": 1-4 if the correct answer is visually marked (highlight/circle/check) else null,
  "page_w": page width in points (595 if unknown),
  "page_h": page height in points (842 if unknown)
}`;
  const looseParts = [
    { text: loosePrompt },
    { inlineData: { mimeType: 'application/pdf', data: examPdfBase64 } },
  ];
  async function tryLoose(apiKey) {
    for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash']) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        console.log(`[gemini-fallback-loose] trying ${model}...`);
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: looseParts }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 16384, responseMimeType: 'application/json' },
          }),
          signal: AbortSignal.timeout(45000),
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
  const freeKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  const paidKey = (process.env.GEMINI_API_KEY_PAID || '').replace(/\\n/g, '').trim();
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
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
  const freeKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  const paidKey = (process.env.GEMINI_API_KEY_PAID || '').replace(/\\n/g, '').trim();
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

IMPORTANT — 10-option exams: biology/genetics/chemistry exams commonly have 6–10 options labeled א,ב,ג,ד,ה,ו,ז,ח,ט,י. Map letters to indices:
  א=1, ב=2, ג=3, ד=4, ה=5, ו=6, ז=7, ח=8, ט=9, י=10
Accept both Hebrew letters and digits. Return numeric index in "ans".

Be EXHAUSTIVE — aim to return every question that has a determinable answer. Skip a question ONLY if the solution PDF genuinely does not cover it or the text is too ambiguous to identify a single winner. Returning nothing is better than returning a wrong answer, but returning an answer you're confident about is better than over-omitting.

Return ONLY this JSON object (no markdown, no extra text):
{
  "match": true | false | null,
  "confidence": <float 0.0-1.0>,
  "reasoning": "<one short Hebrew sentence>",
  "answers": [
    {"q": <exam question number>, "ans": <integer 1..10>, "method": "<table|list|conclusion|explanation|highlight|handwritten|margin>", "confidence": <0.0-1.0>, "source_quote": "<brief quote or description from PDF, ≤120 chars>"}
  ]
}

Rules:
- "source_quote" is required — a concise quote or visual description.
- "confidence" < 0.65 → omit that answer.
- If the solution PDF clearly does not match the exam, return "answers": [] and set "match": false.
- Scan EVERY page, including the last page where summary tables often live.`;

  async function callModel(model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
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
        generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn(`[solution-analyze] ${model} ${r.status}:`, errText.slice(0, 300));
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

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
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

      const answers = {};
      if (Array.isArray(p.answers)) {
        for (const item of p.answers) {
          const q = parseInt(item?.q, 10);
          const ans = parseInt(item?.ans, 10);
          const conf = typeof item?.confidence === 'number' ? item.confidence : 1;
          const hasQuote = typeof item?.source_quote === 'string' && item.source_quote.trim().length > 0;
          if (!hasQuote) continue;
          const quote = (item.source_quote || '');
          const affirmativeMarkers = /(התשוב(?:ה|ות)\s+(?:ה)?נכונ(?:ה|ות)|הפתרון|לכן\s+התשובה|הקיפו|המסיח\s+הנכון|התשובה\s+היא|התשובה\s+היתה|: ?answer|correct\s+answer)/i;
          const hasAffirmative = affirmativeMarkers.test(quote);
          const stronglyNegated = /^[\s"״׳'()\[\]]*(?:אפשרות\s+)?[\u0590-\u05FFa-z\d]+['״׳]?\s*(?:שגוי|שגויה|אינה נכון|אינו נכון|לא נכון)/i.test(quote);
          if (stronglyNegated && !hasAffirmative) {
            console.warn(`[solution-analyze] Q${q}: REJECTED — source_quote looks like wrong-option explanation: "${quote.slice(0, 120)}"`);
            continue;
          }
          if (q > 0 && ans >= 1 && ans <= 10 && conf >= 0.65) {
            answers[String(q)] = ans;
          }
        }
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
  const freeKey = (process.env.GEMINI_API_KEY || '').replace(/\\n/g, '').trim();
  const paidKey = (process.env.GEMINI_API_KEY_PAID || '').replace(/\\n/g, '').trim();
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
- "confidence" < 0.65 → omit that answer.
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
        generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json' },
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

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
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
          const hasQuote = typeof item?.source_quote === 'string' && item.source_quote.trim().length > 0;
          if (!hasQuote) continue;
          const quote = (item.source_quote || '');
          const affirmativeMarkers = /(התשוב(?:ה|ות)\s+(?:ה)?נכונ(?:ה|ות)|הפתרון|לכן\s+התשובה|הקיפו|התשובה\s+היא|התשובה\s+היתה)/i;
          const hasAffirmative = affirmativeMarkers.test(quote);
          const stronglyNegated = /^[\s"״׳'()\[\]]*(?:אפשרות\s+)?[\u0590-\u05FFa-z\d]+['״׳]?\s*(?:שגוי|שגויה|אינה נכון|אינו נכון|לא נכון)/i.test(quote);
          if (stronglyNegated && !hasAffirmative) {
            console.warn(`[solution-only] Q${q}: REJECTED wrong-option quote: "${quote.slice(0, 120)}"`);
            continue;
          }
          const accepted = q > 0 && ans >= 1 && ans <= 10 && conf >= 0.65;
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
function normalizeGeminiMcqs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(q => q && (typeof q.n === 'number' || typeof q.n === 'string') && String(q.n).trim() !== '' && !isNaN(parseInt(q.n, 10)))
    .map(q => ({
      section: String(q.n),
      number: typeof q.n === 'number' ? q.n : parseInt(q.n, 10),
      page: q.page || 2,
      yTop: Math.max(0, ((q.y_top ?? 0) / 100) * (q.page_h || 842) - 25),
      yBottom: ((q.y_bottom ?? Math.min((q.y_top ?? 0) + 25, 100)) / 100) * (q.page_h || 842),
      pageWidth: q.page_w || 595,
      pageHeight: q.page_h || 842,
      numOptions: 4,
      _geminiCorrect: q.correct ?? null,
      _fromGemini: true,
      groupId: q.group_id || null,
      contextYTop: (q.context_y_top != null && q.group_id)
        ? Math.max(0, (q.context_y_top / 100) * (q.page_h || 842) - 5)
        : null,
      contextPage: (q.context_page != null && q.group_id) ? q.context_page : null,
    }));
}

// Legacy wrapper — kept for upload.mjs call-sites.
async function verifySolutionMatchesExam(examBase64, solutionBase64, questionNumbers) {
  const r = await analyzeSolutionPdf(examBase64, solutionBase64, questionNumbers);
  return r.match;
}

export {
  analyzeExamWithGemini,
  classifyPdfWithGemini,
  analyzeSolutionPdf,
  extractAnswersFromSolutionOnly,
  normalizeGeminiMcqs,
  verifySolutionMatchesExam,
};
