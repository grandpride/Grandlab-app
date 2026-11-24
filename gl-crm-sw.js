/* Grandlab CRM service worker (24 Nov). Does two things only: shows a push
   notification when the bridge sends one, and opens the CRM when it is tapped.
   It has NO fetch handler and caches nothing, so it can never serve stale data
   and cannot interfere with the customer app's own service worker (sw.js):
   it is registered with a scope of gl-crm.html only. */
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Grandlab CRM', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'New WhatsApp message', {
    body: d.body || '', tag: d.tag || 'gl-crm', renotify: true,
    icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || 'gl-crm.html#pipeline' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || 'gl-crm.html#pipeline', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.indexOf('gl-crm.html') > -1 && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
