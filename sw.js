// 推播通知用的 Service Worker：只處理「收到推播就顯示」與「點通知打開系統」，不做任何快取，不影響頁面載入與更新。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: '碳金 Hub', body: event.data ? event.data.text() : '' }; }
  // iOS 規定：收到推播一定要顯示通知（userVisibleOnly），不能靜默處理
  event.waitUntil(self.registration.showNotification(d.title || '碳金 Hub', {
    body: d.body || '',
    icon: '/assets/icons/icon-192.png',
    badge: '/assets/icons/favicon-32.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) { try { if ('navigate' in c) await c.navigate(url); } catch (e) {} return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
