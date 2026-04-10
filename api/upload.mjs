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

    const combinedText = solText ? `=== מבחן ===\n${examText}\n\n=== פתרון ===\n${solText}` : examText;

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
    });
  } catch (err) {
    console.error('[upload] fatal:', err?.message || err);
    res.status(500).json({ error: 'שגיאה פנימית בהעלאה' });
  }
}
