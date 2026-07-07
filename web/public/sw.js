// Service worker de la PWA. Instalable + Web Push (tarea 23).
// Sin caché offline agresiva — el fetch va todo a la red (passthrough).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // passthrough: dejar que el navegador resuelva contra la red
});

// Web Push (tarea 23): el server manda {title, body, url, tag} como JSON. Se
// muestra la notificación; el dato url viaja en notification.data para el tap.
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : '' };
  }
  const title = d.title || 'claude-deck';
  e.waitUntil(
    self.registration.showNotification(title, {
      body: d.body || '',
      tag: d.tag || undefined,
      data: { url: d.url || '/' },
      icon: '/icon.svg',
      badge: '/icon.svg',
    }),
  );
});

// El tap DEBE caer en la PWA instalada (motivo de la tarea): si ya hay una
// ventana de la app, se enfoca (y se navega al deep-link de la sesión); si no,
// se abre una — que en una PWA instalada es la propia app, no una pestaña de
// Safari.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if ('focus' in w) {
          await w.focus();
          if (url && url !== '/' && 'navigate' in w) {
            try {
              await w.navigate(url);
            } catch {
              /* navigate falla entre orígenes/estados: el focus ya alcanzó */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});
