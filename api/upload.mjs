// =====================================================
// Vercel Serverless Function — POST /api/upload
// =====================================================
// Upload exam PDF → extract questions via Gemini → store in DB
// =====================================================

import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

const MAX_PDF_BYTES = 15 * 1024 * 1024;

// ===== Supabase =====
let _admin = null;
function getAdmin() {
  if (!_admin && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    _admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  }
  return _admin;
}
function userClient(jwt) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ===== Auth =====
async function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.substring(7);
  const client = getAdmin() || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { userId: data.user.id, db: userClient(token) };
}

// ===== Multipart parsing =====
function rawBody(req, limit = MAX_PDF_BYTES + 512 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.body && Buffer.isBuffer(req.body)) return resolve(req.body);
    if (req.body && typeof req.body === 'string') return resolve(Buffer.from(req.body));
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new Error('Body too large')); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buf, contentType) {
  const bm = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!bm) throw new Error('No multipart boundary');
  const boundary = bm[1] || bm[2];
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let start = buf.indexOf(sep);
  while (start !== -1) {
    start += sep.length;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    const next = buf.indexOf(sep, start);
    if (next === -1) break;
    const part = buf.slice(start, next - 2);
    const hEnd = part.indexOf('\r\n\r\n');
    if (hEnd === -1) { start = next; continue; }
    const hdr = part.slice(0, hEnd).toString('utf8');
    parts.push({
      name: hdr.match(/name="([^"]+)"/)?.[1] || '',
      filename: hdr.match(/filename="([^"]+)"/)?.[1] || null,
      data: part.slice(hEnd + 4),
    });
    start = next;
  }
  return parts;
}

function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

// ===== Gemini =====
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
        }),
        signal: AbortSignal.timeout(50000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      return j.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch { continue; }
  }
  return null;
}

// ===== File validation helpers =====
function extractYears(text) {
  const matches = text.match(/\b(20[1-3]\d)\b/g);
  return [...new Set(matches || [])];
}

function extractSemester(text) {
  if (/סמסטר\s*[אa'׳]/i.test(text)) return 'א';
  if (/סמסטר\s*[בb'׳]/i.test(text)) return 'ב';
  if (/סמסטר\s*(?:קיץ|ג|c)/i.test(text)) return 'קיץ';
  return null;
}

function extractMoed(text) {
  if (/מועד\s*[אa'׳]/i.test(text)) return 'א';
  if (/מועד\s*[בb'׳]/i.test(text)) return 'ב';
  if (/מועד\s*(?:מיוחד|ג|c)/i.test(text)) return 'מיוחד';
  return null;
}

function extractCourseName(text) {
  const patterns = [
    /(?:קורס|מקצוע|נושא)[:\s]+([^\n,]{3,40})/,
    /(?:בחינה|מבחן)\s+ב([^\n,]{3,40})/,
    /(?:course|subject)[:\s]+([^\n,]{3,40})/i,
  ];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1].trim(); }
  return null;
}

function extractQuestionCount(text) {
  const m = text.match(/(\d+)\s*(?:שאלות|questions)/i);
  return m ? parseInt(m[1]) : null;
}

function commonWords(a, b) {
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 2));
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return wordsA.size > 0 ? common / wordsA.size : 0;
}

function validateFiles(name, examHeader, solHeader) {
  const warnings = [];

  const pdfYears = extractYears(examHeader);
  const nameYears = extractYears(name);
  const pdfMoed = extractMoed(examHeader);
  const nameMoed = extractMoed(name);
  const pdfCourse = extractCourseName(examHeader);

  // 1. Year mismatch: name vs PDF
  if (nameYears.length && pdfYears.length && !pdfYears.includes(nameYears[0])) {
    warnings.push(`שים לב: רשמת "${nameYears[0]}" בשם, אבל בקובץ מופיעה השנה ${pdfYears.join('/')}.`);
  }

  // 2. Moed mismatch: name vs PDF
  if (nameMoed && pdfMoed && nameMoed !== pdfMoed) {
    warnings.push(`שים לב: רשמת "מועד ${nameMoed}" בשם, אבל בקובץ כתוב "מועד ${pdfMoed}".`);
  }

  // 3. Solution vs exam validation
  if (solHeader) {
    const solYears = extractYears(solHeader);
    const solMoed = extractMoed(solHeader);
    const solSem = extractSemester(solHeader);
    const examSem = extractSemester(examHeader);
    const solCourse = extractCourseName(solHeader);

    // Year mismatch
    if (pdfYears.length && solYears.length && !pdfYears.some(y => solYears.includes(y))) {
      warnings.push(`שים לב: המבחן משנת ${pdfYears[0]} אבל הפתרון משנת ${solYears[0]}. ודא שהעלית את הפתרון הנכון.`);
    }
    // Moed mismatch
    if (pdfMoed && solMoed && pdfMoed !== solMoed) {
      warnings.push(`שים לב: המבחן ממועד ${pdfMoed} אבל הפתרון ממועד ${solMoed}.`);
    }
    // Semester mismatch
    if (examSem && solSem && examSem !== solSem) {
      warnings.push(`שים לב: המבחן מסמסטר ${examSem} אבל הפתרון מסמסטר ${solSem}.`);
    }
    // Course name mismatch
    if (pdfCourse && solCourse && commonWords(pdfCourse, solCourse) < 0.3) {
      warnings.push(`שים לב: נראה שהמבחן בנושא "${pdfCourse}" אבל הפתרון בנושא "${solCourse}".`);
    }
    // Very low text similarity — likely unrelated files
    if (examHeader.length > 100 && solHeader.length > 100) {
      const sim = commonWords(examHeader, solHeader);
      if (sim < 0.1) {
        warnings.push('שים לב: הקבצים נראים שונים מאוד — ודא שהפתרון מתאים למבחן.');
      }
    }
  }

  return warnings;
}

function buildExtractionPrompt(text, hasSolution) {
  return `אתה מומחה בחילוץ שאלות אמריקאיות ממבחנים. חלץ את כל השאלות מהטקסט הבא.

עבור כל שאלה, החזר:
- מספר השאלה
- טקסט השאלה
- רשימת התשובות (מספר 1 עד N)
- ${hasSolution ? 'אינדקס התשובה הנכונה (1-based)' : 'אינדקס התשובה הנכונה אם ניתן לזהות, אחרת 1'}

החזר JSON בלבד, ללא markdown, בפורמט הבא:
[{"n":1,"q":"טקסט השאלה","opts":["תשובה 1","תשובה 2","תשובה 3","תשובה 4"],"correct":2}]

הטקסט:
${text.slice(0, 50000)}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Missing or invalid authorization' });

  try {
    // Parse multipart
    const buf = await rawBody(req);
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart')) return res.status(400).json({ error: 'Expected multipart/form-data' });
    const parts = parseMultipart(buf, ct);

    const getField = (name) => parts.find(p => p.name === name && !p.filename)?.data?.toString('utf8');
    const getFile = (name) => parts.find(p => p.name === name && p.filename);

    const courseId = getField('courseId');
    const name = getField('name');
    const examFile = getFile('examPdf');
    const solFile = getFile('solutionPdf');

    if (!courseId) return res.status(400).json({ error: 'חסר courseId' });
    if (!name || name.length < 2 || name.length > 200) return res.status(400).json({ error: 'שם מבחן לא תקין' });
    if (!examFile) return res.status(400).json({ error: 'חסר קובץ PDF של המבחן' });
    if (!isPdf(examFile.data)) return res.status(400).json({ error: 'קובץ הבחינה אינו PDF תקני' });
    if (examFile.data.length > MAX_PDF_BYTES) return res.status(413).json({ error: 'הקובץ גדול מדי' });
    if (solFile && !isPdf(solFile.data)) return res.status(400).json({ error: 'קובץ הפתרון אינו PDF תקני' });

    // Verify course ownership
    const { data: course } = await auth.db.from('ep_courses').select('id').eq('id', courseId).maybeSingle();
    if (!course) return res.status(403).json({ error: 'אין גישה לקורס' });

    // Create exam record
    const { data: exam, error: examErr } = await auth.db.from('ep_exams')
      .insert({ course_id: courseId, user_id: auth.userId, name, status: 'processing' })
      .select().single();
    if (examErr) {
      console.error('[upload] insert exam:', examErr.message);
      return res.status(500).json({ error: 'שגיאה ביצירת רשומת מבחן' });
    }

    // Extract text from PDF
    let examText = '';
    let solText = '';
    try {
      const { extractText } = await import('unpdf');
      const result = await extractText(new Uint8Array(examFile.data), { mergePages: true });
      examText = result?.text?.trim() || '';
      if (solFile) {
        const solResult = await extractText(new Uint8Array(solFile.data), { mergePages: true });
        solText = solResult?.text?.trim() || '';
      }
    } catch (e) {
      console.error('[upload] text extraction failed:', e.message);
    }

    // Validate files match what user claimed
    const fileWarnings = validateFiles(
      name,
      examText.slice(0, 1000),
      solText ? solText.slice(0, 1000) : null
    );

    const combinedText = solText ? `=== מבחן ===\n${examText}\n\n=== פתרון ===\n${solText}` : examText;

    // Try to improve the exam name from PDF content
    let finalName = name;
    if (examText.length > 50) {
      const header = examText.slice(0, 500);
      // Look for common Hebrew exam headers
      const patterns = [
        /מבחן\s+ב?(.{3,40})/,
        /בחינה\s+ב?(.{3,40})/,
        /מועד\s+[אב׳']\s*/i,
        /סמסטר\s+[אב׳']\s*/i,
        /\d{4}\s*[-–]\s*\d{4}/,
      ];
      const found = [];
      for (const p of patterns) { const m = header.match(p); if (m) found.push(m[0].trim()); }
      if (found.length && name.length < 10) {
        finalName = `${name} - ${found.join(' ')}`.slice(0, 100);
        await auth.db.from('ep_exams').update({ name: finalName }).eq('id', exam.id);
      }
    }

    // Use Gemini to extract questions
    let questions = [];
    if (combinedText.length > 100) {
      const aiResponse = await callGemini(buildExtractionPrompt(combinedText, !!solFile));
      if (aiResponse) {
        try {
          const cleaned = aiResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          questions = JSON.parse(cleaned);
          if (!Array.isArray(questions)) questions = [];
        } catch { console.error('[upload] failed to parse Gemini response'); }
      }
    }

    // Store questions in DB
    if (questions.length > 0) {
      const qRecords = questions.map((q, i) => ({
        exam_id: exam.id,
        course_id: parseInt(courseId),
        user_id: auth.userId,
        question_number: q.n || (i + 1),
        image_path: 'text-only',
        num_options: q.opts?.length || 4,
        correct_idx: q.correct || 1,
        option_labels: q.opts || null,
        general_explanation: q.q || null,
        is_ai_generated: true,
      }));

      const { error: qErr } = await auth.db.from('ep_questions').insert(qRecords);
      if (qErr) console.error('[upload] insert questions:', qErr.message);
    }

    // Update exam status
    await auth.db.from('ep_exams').update({
      status: questions.length > 0 ? 'ready' : 'pending',
      question_count: questions.length,
      processed_at: new Date().toISOString(),
    }).eq('id', exam.id);

    // Update course counters
    const [{ count: qCount }, { count: pdfCount }] = await Promise.all([
      auth.db.from('ep_questions').select('id', { count: 'exact', head: true })
        .eq('course_id', courseId).is('deleted_at', null),
      auth.db.from('ep_exams').select('id', { count: 'exact', head: true }).eq('course_id', courseId),
    ]);
    await auth.db.from('ep_courses').update({ total_questions: qCount, total_pdfs: pdfCount }).eq('id', courseId);

    res.json({
      ok: true,
      exam_id: exam.id,
      question_count: questions.length,
      mode: questions.length > 0 ? 'text' : 'pending',
      ...(fileWarnings.length && { warnings: fileWarnings }),
    });
  } catch (err) {
    console.error('[upload] fatal:', err?.message || err);
    res.status(500).json({ error: 'שגיאה פנימית בהעלאה' });
  }
}
