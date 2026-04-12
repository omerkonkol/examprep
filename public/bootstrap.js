// Bootstrap scripts extracted from index.html so the page can ship without
// `script-src 'unsafe-inline'` in its CSP. Loaded with `defer` from index.html.

// ---- Cookie consent banner ----
(function () {
  if (localStorage.getItem('cookie-consent')) return;
  var banner = document.getElementById('cookie-banner');
  if (banner) banner.hidden = false;
  var acceptBtn = document.getElementById('cookie-accept');
  if (acceptBtn) {
    acceptBtn.addEventListener('click', function () {
      localStorage.setItem('cookie-consent', '1');
      if (banner) banner.hidden = true;
    });
  }
})();

// ---- Service worker + PWA install prompt capture ----
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/public/sw.js').catch(function () {});
}
window.__pwaPrompt = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  window.__pwaPrompt = e;
});
