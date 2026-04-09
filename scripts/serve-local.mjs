// Tiny zero-deps static server for local development of ExamPrep.
// Run: node scripts/serve-local.mjs   (default port 3000)
// Then visit http://localhost:3000
//
// All admin testing can happen against this — no Supabase, no Express needed.
import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '3000', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // SPA fallback: any non-asset, non-/public path serves index.html
  // (so direct visits to /dashboard, /login etc. work after refresh)
  let filePath;
  if (urlPath === '/' || urlPath === '') {
    filePath = path.join(ROOT, 'public', 'index.html');
  } else if (urlPath.startsWith('/public/')) {
    filePath = path.join(ROOT, urlPath.slice(1));
  } else if (urlPath.startsWith('/legal/')) {
    filePath = path.join(ROOT, urlPath.slice(1));
  } else if (urlPath.startsWith('/data/')) {
    // Convenience: serve /data/* the same as /public/data/*
    filePath = path.join(ROOT, 'public', urlPath.slice(1));
  } else {
    // Unknown route → SPA fallback
    filePath = path.join(ROOT, 'public', 'index.html');
  }

  // Security: prevent path traversal outside ROOT
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Fallback to index.html for SPA
      const fallback = path.join(ROOT, 'public', 'index.html');
      fs.readFile(fallback, (e2, data) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data);
      });
      return;
    }
    fs.readFile(filePath, (e, data) => {
      if (e) { res.writeHead(500); res.end('Read error'); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`\n  ExamPrep dev server running:`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`\n  Press Ctrl+C to stop\n`);
});
