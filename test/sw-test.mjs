// Test headless del handler notificationclick del service worker real
// (web/public/sw.js). No necesita browser ni server: carga el sw.js en un `self`
// mockeado (node:vm) y dispara clicks sintéticos.
//
// Regresión de la tarea 23: el tap en una Web Push abría el BROWSER en vez de la
// PWA instalada cuando ésta se había instalado desde un origen/puerto distinto
// al DECK_URL del server (p.ej. `tailscale serve` de una rama en :8443 mientras
// DECK_URL apunta al :443 de main). El fix re-basa el destino del click al scope
// del propio SW, así openWindow/navigate siempre apuntan al origen desde el que
// se instaló la PWA. Estos checks fijan ese contrato.
import fs from 'node:fs';
import vm from 'node:vm';

const SCOPE = 'https://macbook-pro-de-lucas.tail782ca2.ts.net:8443/'; // PWA instalada en :8443
const src = fs.readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8');

const results = [];
const ok = (n, c) => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}`);

function loadSw(clientsList) {
  const opened = [];
  const focused = [];
  const navigated = [];
  const listeners = {};
  clientsList.forEach((c) => {
    c.focus = async () => { focused.push(c.url); };
    c.navigate = async (u) => { navigated.push(u); return c; };
  });
  const self = {
    registration: { scope: SCOPE, showNotification: () => {} },
    addEventListener: (t, cb) => { listeners[t] = cb; },
    skipWaiting: () => {},
    clients: {
      claim: () => {},
      matchAll: async () => clientsList,
      openWindow: async (u) => { opened.push(u); },
    },
    __opened: opened, __focused: focused, __navigated: navigated, __listeners: listeners,
  };
  vm.runInContext(src, vm.createContext({ self, URL, console }));
  return self;
}

async function fireClick(self, dataUrl) {
  const waits = [];
  self.__listeners['notificationclick']({
    notification: { close: () => {}, data: dataUrl === undefined ? undefined : { url: dataUrl } },
    waitUntil: (p) => waits.push(p),
  });
  await Promise.all(waits);
}

const CROSS = 'https://macbook-pro-de-lucas.tail782ca2.ts.net/?session=deck'; // :443, otro origen

// 1. sin client vivo + payload ABSOLUTO cross-origin (:443) → openWindow
//    re-basado al scope (:8443), path/query preservados
{
  const self = loadSw([]);
  await fireClick(self, CROSS);
  ok('absoluto cross-origin sin client → openWindow re-basado al scope :8443',
    self.__opened.length === 1 && self.__opened[0] === `${SCOPE}?session=deck`);
}

// 2. sin client vivo + payload RELATIVO (lo que manda notify.sh) → openWindow al
//    scope con la query intacta
{
  const self = loadSw([]);
  await fireClick(self, '/?session=feat-x');
  ok('relativo sin client → openWindow scope + query', self.__opened[0] === `${SCOPE}?session=feat-x`);
}

// 3. client vivo (mismo origen que el SW) → focus + navigate al destino
//    re-basado (mismo origen → navigate no cruza orígenes), sin openWindow
{
  const client = { url: SCOPE, id: 'c1' };
  const self = loadSw([client]);
  await fireClick(self, CROSS);
  ok('client vivo → focus() y sin openWindow', self.__focused.length === 1 && self.__opened.length === 0);
  ok('client vivo → navigate al destino re-basado al scope', self.__navigated[0] === `${SCOPE}?session=deck`);
}

// 4. sin url en el payload → root del scope (nunca undefined / otro origen)
{
  const self = loadSw([]);
  await fireClick(self, undefined);
  ok('sin url → openWindow al root del scope', self.__opened[0] === SCOPE);
}

// 5. defensa: un origen ajeno en el payload igual se re-basa al scope
{
  const self = loadSw([]);
  await fireClick(self, 'https://evil.example.com/phish?session=deck');
  ok('origen ajeno en el payload → re-basado al scope (no abre el ajeno)',
    self.__opened[0] === `${SCOPE}phish?session=deck`);
}

console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
