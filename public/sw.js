// Inert service worker. Previous versions had a network-first fetch handler
// that intercepted EVERY request including cross-origin Supabase POSTs,
// which caused login calls to hang in some browser states. This version does
// NOT intercept fetches at all — all network traffic goes straight through.
// On activate, it deletes ALL old caches so stale cached code cannot
// resurrect itself.
self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {}
    try { await self.clients.claim(); } catch {}
  })());
});
// No fetch handler — the browser handles all requests natively.
