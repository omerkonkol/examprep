// =====================================================
// Vercel Serverless Function — POST /api/client-error
// =====================================================
// Tiny error sink: receives client-side errors (window.onerror +
// unhandledrejection) and logs them. No DB writes, no Supabase dependency.
// Logs go to `console.error` which shows up in Vercel function logs.
//
// Rate limiting is opportunistic: per-IP bucket in function memory. Serverless
// instances are short-lived so this doesn't survive cold starts, but it's
// enough to block abuse bursts within a warm container.
// =====================================================

export const config = { maxDuration: 5 };

const MAX_BODY_BYTES = 8 * 1024;
const MAX_FIELD_LEN = 2000;
const RATE_LIMIT_PER_IP = 60; // per minute
const _ipBuckets = new Map();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const bucket = _ipBuckets.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 60_000; }
  bucket.count += 1;
  _ipBuckets.set(ip, bucket);
  return bucket.count > RATE_LIMIT_PER_IP;
}

function truncate(s) {
  if (typeof s !== 'string') return '';
  return s.length > MAX_FIELD_LEN ? s.slice(0, MAX_FIELD_LEN) + '…' : s;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'rate limited' });
  }
  const body = await readJson(req);
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid body' });
  }

  const type = truncate(body.type || 'unknown');
  const msg = truncate(body.msg || '');
  const stack = truncate(body.stack || '');
  const url = truncate(body.url || '');
  const ua = truncate(body.ua || req.headers['user-agent'] || '');
  const extra = body.extra && typeof body.extra === 'object' ? body.extra : null;

  // Single-line log so Vercel's log view groups it cleanly.
  console.error(
    `[client-error] ${type} ip=${ip} url=${url} msg="${msg}" ua="${ua}"` +
    (stack ? ` stack="${stack.replace(/\n/g, ' | ')}"` : '') +
    (extra ? ` extra=${JSON.stringify(extra).slice(0, 500)}` : '')
  );

  return res.status(204).end();
}
