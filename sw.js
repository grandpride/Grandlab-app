/* ============================================================
   Grandlab Service Worker — push notifications only (no caching)
   Upload as sw.js in the SAME folder as index.html
   (served from the app's own origin, e.g. app.grandlab.com.my/sw.js)
   ------------------------------------------------------------
   VERSION: 2026-07-07  (push-only)
   Bump this date whenever you change this file so you can tell
   which copy is deployed (check via DevTools > Application > SW).
   ============================================================ */
const SW_VERSION = '2026-11-03';

// Derive URLs from where this worker is actually served, instead of hardcoding a
// domain. The previous build pointed at grandpride.github.io and at icon-192.png,
// which did not exist in the repo - so notification icons were broken and a tap
// opened the old Pages URL rather than app.grandlab.com.my.
const BASE = self.registration.scope;                 // e.g. https://app.grandlab.com.my/
const ICON = BASE + 'icon-192.png';

// Receive a push from the server and show it
self.addEventListener('push', function(event){
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch(e){ data = { title:'Grandlab', body: (event.data && event.data.text()) || '' }; }

  const title = data.title || 'Grandlab';
  const options = {
    body: data.body || '',
    icon: data.icon || ICON,
    badge: data.badge || ICON,
    data: { url: data.url || BASE },
    tag: data.tag || undefined,            // same tag replaces older notif
    renotify: !!data.tag
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// When the user taps the notification, open/focus the app
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || BASE;

  event.waitUntil((async function(){
    const list = await clients.matchAll({ type:'window', includeUncontrolled:true });
    // prefer focusing an already-open Grandlab tab
    for (const c of list){
      try{
        if ('focus' in c){
          // try to move it to the target page, but focus even if navigate fails
          if ('navigate' in c){ try{ await c.navigate(target); }catch(e){} }
          return await c.focus();
        }
      }catch(e){ /* try the next client */ }
    }
    // none open (or focus failed) -> open a new window
    if (clients.openWindow) return clients.openWindow(target);
  })());
});

// Browser may silently rotate the push subscription; log it so we know if
// pushes stop arriving. (Re-subscribe happens in the app on next open.)
self.addEventListener('pushsubscriptionchange', function(event){
  // No server re-subscribe here to keep this file self-contained; the app
  // re-subscribes when the user next opens it. This handler prevents an
  // unhandled event and documents the behaviour.
  console.log('[sw] pushsubscriptionchange — app will re-subscribe on next open');
});

// Activate immediately on update
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(event){ event.waitUntil(self.clients.claim()); });
