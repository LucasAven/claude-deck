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

// Re-basar el destino del tap al scope del PROPIO service worker. La PWA se
// puede haber instalado desde un origen/puerto distinto al DECK_URL del server
// (p.ej. `tailscale serve` de una rama en :8443 mientras DECK_URL apunta al
// :443 de main). Una URL ABSOLUTA a otro origen cae FUERA del scope de la PWA
// instalada → iOS abre el browser en vez de enfocar la app (el bug de la tarea).
// Tomamos solo path+query+hash del payload y lo resolvemos contra
// self.registration.scope, así el click siempre apunta al origen desde el que
// se instaló la PWA — venga el payload absoluto (compat) o relativo.
function clickTarget(raw) {
  const scope = self.registration.scope;
  try {
    const u = new URL(raw || '/', scope);
    return new URL(u.pathname + u.search + u.hash, scope).href;
  } catch {
    return scope;
  }
}

// El tap DEBE caer en la PWA instalada (motivo de la tarea): si ya hay una
// ventana de la app, se enfoca (y se navega al deep-link de la sesión); si no,
// se abre una — que en una PWA instalada es la propia app, no una pestaña de
// Safari.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = clickTarget(e.notification.data && e.notification.data.url);
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if ('focus' in w) {
          await w.focus();
          // target ya es del mismo origen que el SW → navigate no cruza orígenes
          if ('navigate' in w) {
            try {
              await w.navigate(target);
            } catch {
              /* navigate puede fallar por estado; el focus ya alcanzó */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});
