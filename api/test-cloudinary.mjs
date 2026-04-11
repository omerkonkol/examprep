// One-shot test: verify Cloudinary PDF upload works
import { createHash } from 'node:crypto';

export default async function handler(req, res) {
  const cloud = (process.env.CLOUDINARY_CLOUD_NAME || '').replace(/\s+/g, '');
  const key = (process.env.CLOUDINARY_API_KEY || '').replace(/\s+/g, '');
  const secret = (process.env.CLOUDINARY_API_SECRET || '').replace(/\s+/g, '');

  if (!cloud || !key || !secret) {
    return res.json({ error: 'Missing CLOUDINARY env vars', cloud: !!cloud, key: !!key, secret: !!secret });
  }

  // Create a tiny 1-page PDF for testing
  const pdfContent = `%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
206
%%EOF`;

  const publicId = `examprep/test/cloudinary-test-${Date.now()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sigStr = `public_id=${publicId}&timestamp=${timestamp}${secret}`;
  const signature = createHash('sha1').update(sigStr).digest('hex');

  const base64 = Buffer.from(pdfContent).toString('base64');
  const dataUri = `data:application/pdf;base64,${base64}`;

  try {
    const cloudRes = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: dataUri, public_id: publicId, api_key: key, timestamp, signature }),
    });
    const body = await cloudRes.text();
    res.json({
      status: cloudRes.status,
      ok: cloudRes.ok,
      response: body.slice(0, 500),
      pageUrl: cloudRes.ok ? `https://res.cloudinary.com/${cloud}/image/upload/pg_1,w_400/${publicId}.png` : null,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
}
