// POST /api/exams/:examId/solution
// Upload a solution PDF to an existing exam without re-uploading the whole exam.
// Runs Gemini answer extraction and updates answer_confidence on all questions.

import { createClient } from '@supabase/supabase-js';
import { extractAnswersFromSolutionOnly } from '../_lib/gemini-solution.mjs';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

const MAX_PDF_BYTES = 15 * 1024 * 1024;

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

async function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.substring(7);
  const client = getAdmin() || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { userId: data.user.id, db: userClient(token) };
}

function rawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && Buffer.isBuffer(req.body)) return resolve(req.body);
    if (req.body && typeof req.body === 'string') return resolve(Buffer.from(req.body));
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_PDF_BYTES + 65536) { req.destroy(); reject(new Error('Body too large')); }
      chunks.push(c);
    });
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
    if (parts.length >= 5) throw new Error('Too many multipart parts');
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authenticate(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  // Extract examId from URL: /api/exams/:examId/solution
  const examId = req.url?.match(/\/api\/exams\/([^/]+)\/solution/)?.[1];
  if (!examId) return res.status(400).json({ error: 'Missing examId' });

  try {
    const buf = await rawBody(req);
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart')) return res.status(400).json({ error: 'Expected multipart/form-data' });

    const parts = parseMultipart(buf, ct);
    const solFile = parts.find(p => p.name === 'solFile' && p.filename);
    if (!solFile) return res.status(400).json({ error: 'Missing solFile' });
    if (!isPdf(solFile.data)) return res.status(400).json({ error: 'קובץ הפתרון אינו PDF תקני' });
    if (solFile.data.length > MAX_PDF_BYTES) return res.status(413).json({ error: 'הקובץ גדול מדי' });

    // Verify exam ownership
    const { data: exam, error: examErr } = await auth.db
      .from('ep_exams')
      .select('id, name, user_id')
      .eq('id', examId)
      .single();

    if (examErr || !exam) return res.status(404).json({ error: 'Exam not found' });
    if (exam.user_id !== auth.userId) return res.status(403).json({ error: 'Forbidden' });

    // Fetch question numbers
    const { data: questions, error: qErr } = await auth.db
      .from('ep_questions')
      .select('id, number')
      .eq('exam_id', examId)
      .order('number');

    if (qErr || !questions?.length) return res.status(404).json({ error: 'No questions found for this exam' });

    const questionNumbers = questions.map(q => q.number);
    const solBase64 = solFile.data.toString('base64');

    console.log(`[add-solution] exam=${examId} (${exam.name}) questions=${questionNumbers.length}`);

    const { answers, rawItems } = await extractAnswersFromSolutionOnly(solBase64, questionNumbers);
    const answered = Object.keys(answers).length;

    console.log(`[add-solution] extracted ${answered}/${questionNumbers.length} answers`);

    // Update each question that got an answer
    const updates = [];
    for (const q of questions) {
      const ans = answers[String(q.number)];
      if (ans != null) {
        updates.push(
          auth.db.from('ep_questions')
            .update({ correct_option: ans, answer_confidence: 'confirmed' })
            .eq('id', q.id)
        );
      }
    }
    if (updates.length > 0) await Promise.all(updates);

    const warnings = [];
    if (answered === 0) {
      warnings.push('לא הצלחנו לחלץ תשובות מקובץ הפתרון. ייתכן שהקובץ אינו קובץ פתרון, או שהפורמט שלו אינו נתמך. תוכל לסמן את התשובות ידנית.');
    } else if (answered / questionNumbers.length < 0.5) {
      warnings.push(`זוהו תשובות רק ל-${answered} מתוך ${questionNumbers.length} שאלות. תוכל להשלים את שאר התשובות ידנית.`);
    }

    res.json({ ok: true, answered, total: questionNumbers.length, ...(warnings.length && { warnings }) });
  } catch (e) {
    console.error('[add-solution] error:', e?.message || e);
    res.status(500).json({ error: 'שגיאה פנימית' });
  }
}
