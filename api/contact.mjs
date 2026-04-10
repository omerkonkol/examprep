// =====================================================
// Vercel Serverless Function — POST /api/contact
// =====================================================
// Saves contact form submissions to Supabase and optionally
// sends an email notification via Resend.
// =====================================================

import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 10 };

// Lazy-init shared clients
let _supabase = null;
function supabaseAdmin() {
  if (!_supabase && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return _supabase;
}

let _resend = null;
async function resend() {
  if (!_resend && process.env.RESEND_API_KEY) {
    const { Resend } = await import('resend');
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, subject, message } = req.body || {};
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'missing fields' });
  }
  if (message.length > 5000) {
    return res.status(400).json({ error: 'message too long' });
  }

  const safeName = name.slice(0, 200);
  const safeEmail = email.slice(0, 320);
  const safeSubject = (subject || 'general').slice(0, 100);
  const safeMessage = message.slice(0, 5000);

  // Store in DB
  const sb = supabaseAdmin();
  if (sb) {
    const { error } = await sb.from('ep_contact_messages').insert({
      name: safeName, email: safeEmail, subject: safeSubject, message: safeMessage,
    });
    if (error) console.error('[CONTACT] DB insert failed:', error.message);
  }

  // Send email notification
  const CONTACT_NOTIFY_EMAIL = process.env.CONTACT_NOTIFY_EMAIL || '';
  const r = await resend();
  if (r && CONTACT_NOTIFY_EMAIL) {
    const subjectMap = {
      general: 'שאלה כללית', support: 'תמיכה טכנית', billing: 'חיוב ומנויים',
      education: 'תוכנית Education', partnership: 'שיתוף פעולה',
      accessibility: 'נגישות', other: 'אחר',
    };
    const subjectLabel = subjectMap[safeSubject] || safeSubject;
    r.emails.send({
      from: 'ExamPrep <support@try-examprep.com>',
      to: CONTACT_NOTIFY_EMAIL,
      subject: `[ExamPrep] הודעה חדשה: ${subjectLabel}`,
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;">
          <h2 style="color:#1d4ed8;">הודעה חדשה מטופס יצירת קשר</h2>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px;font-weight:bold;color:#666;">שם:</td><td style="padding:8px;">${safeName}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;color:#666;">אימייל:</td><td style="padding:8px;"><a href="mailto:${safeEmail}">${safeEmail}</a></td></tr>
            <tr><td style="padding:8px;font-weight:bold;color:#666;">נושא:</td><td style="padding:8px;">${subjectLabel}</td></tr>
          </table>
          <div style="margin-top:16px;padding:16px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0;white-space:pre-wrap;">${safeMessage}</p>
          </div>
          <p style="margin-top:16px;font-size:12px;color:#94a3b8;">ניתן להשיב ישירות ל-${safeEmail}</p>
        </div>
      `,
      replyTo: safeEmail,
    }).catch(err => console.error('[CONTACT] email send failed:', err));
  }

  console.log(`[CONTACT] from=${safeEmail} subject=${safeSubject} name=${safeName}`);
  return res.json({ ok: true });
}
