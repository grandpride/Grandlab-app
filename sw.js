/* ============================================================
   Grandlab Service Worker — handles incoming push notifications
   Upload this as sw.js in the SAME folder as index.html
   (grandpride.github.io/Grandlab-app/sw.js)
   ============================================================ */

// Receive a push from the server and show it
self.addEventListener('push', function(event){
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e){ data = { title:'Grandlab', body: (event.data && event.data.text()) || '' }; }

  const title = data.title || 'Grandlab';
  const options = {
    body: data.body || '',
    icon: data.icon || 'https://grandpride.github.io/Grandlab-app/icon-192.png',
    badge: data.badge || 'https://grandpride.github.io/Grandlab-app/icon-192.png',
    data: { url: data.url || 'https://grandpride.github.io/Grandlab-app/' },
    tag: data.tag || undefined,            // same tag replaces older notif
    renotify: !!data.tag
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// When the user taps the notification, open/focus the app
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(list){
      for (const c of list){ if ('focus' in c){ c.navigate(url); return c.focus(); } }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// Activate immediately on update
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(event){ event.waitUntil(self.clients.claim()); });
