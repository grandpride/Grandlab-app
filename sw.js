/* ============================================================
   GRANDPRIDE HUB — SERVICE WORKER  (network-first)
   ------------------------------------------------------------
   Strategy: ALWAYS try the network first, so every Netlify
   deploy reaches staff immediately. The cache is only a
   fallback for when the phone is offline.

   If you ever need to force-reset everyone's cache, bump
   the CACHE version below and redeploy.
   ============================================================ */

const CACHE = 'gp-hub-v51';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

/* ---- PUSH NOTIFICATIONS ---- */
self.addEventListener('push', (e) => {
  let data = { title: 'Grandpride Hub', body: '' };
  try { data = e.data.json(); } catch (_) { if (e.data) data.body = e.data.text(); }
  e.waitUntil(
    self.registration.showNotification(data.title || 'Grandpride Hub', {
      body: data.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url: './index.html' }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return clients.openWindow('./index.html');
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;            // never touch POST/PATCH (Supabase etc.)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never intercept Supabase/ImgBB/external calls

  e.respondWith(
    fetch(req)
      .then((res) => {
        // good network response — refresh the cache copy, then serve it
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        // offline — serve last known copy; for page navigations fall back to the hub shell
        caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))
      )
  );
});
