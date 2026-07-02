// Smoke test de UI de claude-deck con puppeteer-core + chromium headless de playwright
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = fs.readFileSync('/path/to/claude-deck/.env', 'utf8')
  .match(/AUTH_TOKEN=(.+)/)[1].trim();

const shell = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell',
);

const results = [];
const ok = (name, cond) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}`);

const browser = await puppeteer.launch({
  executablePath: shell,
  headless: true,
  args: ['--no-sandbox', '--window-size=390,844'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

// 1. auth por ?token= → redirect a /
await page.goto(`http://127.0.0.1:7433/?token=${TOKEN}`, { waitUntil: 'networkidle2', timeout: 20000 });
ok('redirect a / tras ?token=', new URL(page.url()).pathname === '/' && !page.url().includes('token='));

// 2. xterm renderiza en pestaña Claude
await page.waitForSelector('#term-claude .xterm', { timeout: 10000 }).catch(() => {});
ok('xterm montado en pestaña Claude', !!(await page.$('#term-claude .xterm')));

// 3. WS conectado (indicador) + prompt visible en la terminal
await new Promise((r) => setTimeout(r, 2500));
ok('indicador de conexión ON', await page.$eval('#conn-claude', (el) => el.classList.contains('on')));
const termText = await page.$eval('#term-claude', (el) => el.innerText);
ok('la terminal muestra contenido de la sesión tmux', termText.trim().length > 0);

// 4. chips de sesión (el label es el primer span; el activo suma el ✕)
const chips = await page.$$eval('#session-chips .chip', (els) => els.map((e) => e.querySelector('span').textContent));
ok('chip de sesión "deck" presente y activo', chips.includes('deck'));
ok('chip activo tiene botón ✕ (matar sesión)', (await page.$('#session-chips .chip.active .chip-x')) !== null);
ok('botón 📷 de enviar imagen presente', (await page.$('#btn-img')) !== null);
ok('botón pegar del portapapeles presente', (await page.$('#btn-paste')) !== null);

// 5. barra de control abajo (zona del pulgar), entre la terminal y la tab bar
const geo = await page.evaluate(() => ({
  term: document.querySelector('#term-claude').getBoundingClientRect().top,
  bar: document.querySelector('.controlbar').getBoundingClientRect().top,
  tabs: document.querySelector('.tabbar').getBoundingClientRect().top,
}));
ok('controles debajo de la terminal y arriba de las tabs', geo.term < geo.bar && geo.bar < geo.tabs);

// teclas rápidas: Esc no rompe (envía por WS); la barra de Claude tiene "/"
await page.$eval('.quickkeys[data-term="claude"] [data-k="esc"]', (b) => {
  b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
});
ok('tecla rápida Esc enviada sin errores', consoleErrors.length === 0);
ok('tecla "/" primera en la barra de Claude (tras el divisor)', await page.$eval(
  '.quickkeys[data-term="claude"] button[data-k]',
  (b) => b.dataset.k === 'slash',
));

// 5b. adjuntar imagen = solo preview (dos pasos): el chip queda pendiente con
// el hint de "tocá para enviar" y NO se sube nada hasta confirmar con un tap
let pasteReqs = 0;
page.on('request', (r) => { if (r.url().includes('/api/paste-image')) pasteReqs++; });
const imgInput = await page.$('#img-input');
await imgInput.uploadFile(new URL('./shot-diff.png', import.meta.url).pathname);
await new Promise((r) => setTimeout(r, 1200));
const chipState = await page.evaluate(() => {
  const chip = document.querySelector('#img-chip');
  const hint = document.querySelector('#img-chip-hint');
  return {
    visible: !chip.classList.contains('hidden'),
    pending: chip.classList.contains('pending'),
    hintShown: hint && getComputedStyle(hint).display !== 'none',
  };
});
ok('adjuntar imagen muestra chip de preview pendiente', chipState.visible && chipState.pending);
ok('hint "tocá para enviar" visible en el chip', chipState.hintShown);
ok('no se subió nada sin confirmar (0 POSTs a paste-image)', pasteReqs === 0);
await page.screenshot({ path: new URL('./shot-img-pending.png', import.meta.url).pathname });
await page.click('#img-chip-close');
await new Promise((r) => setTimeout(r, 300));
ok('✕ descarta el preview sin enviar', await page.$eval('#img-chip', (el) => el.classList.contains('hidden')) && pasteReqs === 0);

// 5c. switchers de modo y modelo/esfuerzo (pills arriba de la fila de teclas)
const pd = (el) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
const swGeo = await page.evaluate(() => ({
  pills: document.querySelector('.switchrow').getBoundingClientRect().top,
  keys: document.querySelector('.quickkeys[data-term="claude"]').getBoundingClientRect().top,
}));
ok('pills de modo/modelo arriba de la fila de teclas', swGeo.pills < swGeo.keys);

// modo: label fijo ("Mode switcher"), cada tap manda UN shift+tab real sin
// tocar el label; 3 taps = ciclo completo → la sesión tmux queda como estaba
ok('pill de modo con label fijo', (await page.$eval('#mode-label', (el) => el.textContent)) === 'Mode switcher');
for (let i = 1; i <= 3; i++) {
  await page.$eval('#btn-mode', pd);
  await new Promise((r) => setTimeout(r, 150));
}
ok('el label no cambia tras 3 taps (shift+tab reales)',
  (await page.$eval('#mode-label', (el) => el.textContent)) === 'Mode switcher');

// modelo/esfuerzo: solo abrir e inspeccionar (elegir mandaría /model y /effort
// a la sesión real); cerrar tocando afuera
await page.$eval('#btn-model', pd);
await new Promise((r) => setTimeout(r, 200));
ok('menú de modelo: 4 modelos + 4 niveles de esfuerzo',
  (await page.$$('#switch-menu .mi')).length === 4
  && (await page.$$('#switch-menu .mi-efforts button')).length === 4);
await page.screenshot({ path: new URL('./shot-switchers.png', import.meta.url).pathname });
await page.$eval('#term-claude', pd);
await new Promise((r) => setTimeout(r, 200));
ok('tap afuera cierra el menú', await page.$eval('#switch-menu', (el) => el.classList.contains('hidden')));

// 5d. teclado virtual → tabbar oculta: headless no puede abrir el teclado de
// iOS, así que se simula la clase que setea updateViewportGeometry y se
// verifica el CSS; el heurístico real (innerHeight − vv.height > 100) lo
// confirma el usuario en el celular
const kbSim = await page.evaluate(() => {
  const tabbar = document.querySelector('.tabbar');
  const before = tabbar.offsetHeight;
  document.body.classList.add('kb-open');
  const hidden = tabbar.offsetHeight;
  document.body.classList.remove('kb-open');
  return { before, hidden, after: tabbar.offsetHeight };
});
ok('body.kb-open oculta la tabbar (simulado)',
  kbSim.before > 0 && kbSim.hidden === 0 && kbSim.after === kbSim.before);

// 6. pestaña Cambios: header + lista de archivos
await page.click('.tab[data-tab="changes"]');
await new Promise((r) => setTimeout(r, 1500));
const branch = await page.$eval('#git-branch', (el) => el.textContent);
ok('header muestra la rama', branch.includes('main'));
const rows = await page.$$('#file-list .file-row');
ok('lista archivos modificados', rows.length > 0);
// 6b. cada fila tiene su botón de stage/unstage (no se clickea: tocaría el repo real)
const actBtns = await page.$$('#file-list .file-act');
ok('cada fila tiene botón stage/unstage (+/−)', rows.length > 0 && actBtns.length === rows.length);

// 7. tap en un archivo → diff renderizado con diff2html
await rows[0].click();
await page.waitForSelector('#diff-view .d2h-wrapper, #diff-view .d2h-file-wrapper', { timeout: 8000 }).catch(() => {});
ok('diff renderizado con diff2html', !!(await page.$('#diff-view .d2h-file-wrapper')));
ok('modo line-by-line (no side-by-side)', !(await page.$('#diff-view .d2h-file-side-diff')));

// 8. botón ← vuelve a la lista
await page.click('#btn-diff-back');
await new Promise((r) => setTimeout(r, 300));
ok('botón ← vuelve a la lista', !(await page.$eval('#file-list', (el) => el.classList.contains('hidden'))));

// 9. pestaña Shell: terminal conectada
await page.click('.tab[data-tab="shell"]');
await new Promise((r) => setTimeout(r, 2500));
ok('xterm montado en pestaña Shell', !!(await page.$('#term-shell .xterm')));
ok('shell conectada (indicador ON)', await page.$eval('#conn-shell', (el) => el.classList.contains('on')));

// 10. service worker registrado + manifest
const swReg = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return !!reg;
});
ok('service worker registrado', swReg);

// 11. sin errores JS en consola
ok(`sin errores JS en consola (${consoleErrors.length})`, consoleErrors.length === 0);
if (consoleErrors.length) console.log('ERRORES:', consoleErrors.slice(0, 5).join('\n'));

await page.screenshot({ path: new URL('./shot-shell.png', import.meta.url).pathname });
await page.click('.tab[data-tab="claude"]');
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: new URL('./shot-claude.png', import.meta.url).pathname });

await browser.close();
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
