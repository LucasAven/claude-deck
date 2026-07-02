// Service worker mínimo: solo para que la PWA sea instalable.
// Sin caché offline agresiva — todo va a la red.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // passthrough: dejar que el navegador resuelva contra la red
});
