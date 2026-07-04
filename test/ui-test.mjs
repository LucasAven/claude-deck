// Smoke test de UI de claude-deck con puppeteer-core + chromium headless de playwright
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
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
// el nombre del chip activo renombra al tocarlo — no se clickea (abriría un
// prompt() que headless descarta y no queremos renombrar la sesión real)
ok('nombre del chip activo tocable para renombrar', await page.$eval(
  '#session-chips .chip.active .chip-name',
  (el) => el.title === 'Renombrar sesión',
).catch(() => false));
ok('botón + (adjuntar) presente', (await page.$('#btn-attach')) !== null);
ok('botones viejos de cámara/pegar retirados', (await page.$('#btn-img')) === null && (await page.$('#btn-paste')) === null);

// 5. barra de control abajo (zona del pulgar), entre la terminal y la tab bar
const geo = await page.evaluate(() => ({
  term: document.querySelector('#term-claude').getBoundingClientRect().top,
  bar: document.querySelector('.controlbar').getBoundingClientRect().top,
  tabs: document.querySelector('.tabbar').getBoundingClientRect().top,
}));
ok('controles debajo de la terminal y arriba de las tabs', geo.term < geo.bar && geo.bar < geo.tabs);

// teclas rápidas: Esc no rompe (envía por WS). Desde la tarea 12 la acción
// dispara en pointerup (tap con slop), no en pointerdown: hay que mandar el par
await page.$eval('.quickkeys[data-term="claude"] [data-k="esc"]', (b) => {
  b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
});
ok('tecla rápida Esc enviada sin errores', consoleErrors.length === 0);

// 5-tap. tap vs scroll (tarea 12): apoyar el dedo en un botón y arrastrar para
// scrollear la fila NO debe dispararlo; el tap (aun con micro-movimiento) sí.
// Se espía claudeConn.sendKeys para que nada llegue a la sesión real.
const sentKeys = await page.evaluate(() => {
  window.__sentKeys = [];
  const orig = claudeConn.sendKeys;
  claudeConn.sendKeys = (d) => { window.__sentKeys.push(d); };
  const b = document.querySelector('.quickkeys[data-term="claude"] [data-k="esc"]');
  const r = b.getBoundingClientRect();
  const fire = (type, x) => b.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: r.y + 10 }));
  fire('pointerdown', r.x + 10);
  fire('pointerup', r.x + 14);   // micro-movimiento < slop: cuenta como tap
  fire('pointerdown', r.x + 10);
  fire('pointerup', r.x + 60);   // drag (scroll de la fila): no dispara
  claudeConn.sendKeys = orig;
  return window.__sentKeys;
});
ok('tap con micro-movimiento dispara la tecla (1 sola vez)', sentKeys.length === 1 && sentKeys[0] === '\x1b');
ok('drag sobre un quickkey NO dispara (scroll de la fila)', !sentKeys[1]);
// orden de la barra de Claude: "nl" primero (acceso rápido, pedido del usuario),
// "/" segundo. El botón nl (newline suave, ESC+CR) no se tapea: mandaría un
// salto de línea al prompt de la sesión deck real.
const keyOrder = await page.$$eval(
  '.quickkeys[data-term="claude"] button[data-k]',
  (bs) => bs.map((b) => b.dataset.k),
);
ok('teclas "nl" y "/" primeras en la barra de Claude', keyOrder[0] === 'nl' && keyOrder[1] === 'slash');
ok('una sola barra de teclas (Shell retirado)', (await page.$$('.quickkeys')).length === 1);

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

// 5b2. botón + (tarea 13): chooser cámara/pegar en el popover compartido, y
// pegar texto del portapapeles → term.paste (bracketed paste: no submitea).
// Los taps disparan en pointerup (tarea 12): hay que mandar el par.
const tapSel = (sel) => page.$eval(sel, (b) => {
  b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
});
await tapSel('#btn-attach');
const attachMenu = await page.evaluate(() => {
  const menu = document.querySelector('#switch-menu');
  return {
    open: !menu.classList.contains('hidden') && menu.dataset.kind === 'attach',
    labels: [...menu.querySelectorAll('.mi span')].map((s) => s.textContent),
    icons: menu.querySelectorAll('.mi svg').length,
  };
});
ok('tap en + abre el chooser de adjuntar', attachMenu.open);
ok('chooser con Cámara y Pegar (con íconos)', attachMenu.labels.length === 2
  && /Cámara/.test(attachMenu.labels[0]) && /Pegar/.test(attachMenu.labels[1]) && attachMenu.icons === 2);
await page.evaluate(() => document.querySelector('#term-claude')
  .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
ok('tap afuera cierra el chooser', await page.$eval('#switch-menu', (el) => el.classList.contains('hidden')));

// texto en el portapapeles → "Pegar" lo mete en el prompt vía term.paste
// (clipboard.read mockeado y term.paste espiado: nada llega a la sesión real)
const pastedTexts = await page.evaluate(async () => {
  const orig = claudeConn.term.paste.bind(claudeConn.term);
  const calls = [];
  claudeConn.term.paste = (t) => calls.push(t);
  navigator.clipboard.read = async () => [{
    types: ['text/plain'],
    getType: async () => new Blob(['hola texto pegado']),
  }];
  const tap = (el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  };
  tap(document.querySelector('#btn-attach'));
  tap([...document.querySelectorAll('#switch-menu .mi')].find((m) => m.textContent.includes('Pegar')));
  await new Promise((r) => setTimeout(r, 300));
  claudeConn.term.paste = orig;
  return calls;
});
ok('pegar texto llama term.paste con el texto del portapapeles',
  pastedTexts.length === 1 && pastedTexts[0] === 'hola texto pegado');
ok('el chooser se cierra al elegir una opción', await page.$eval('#switch-menu', (el) => el.classList.contains('hidden')));

// 5c. switchers de modo y modelo/esfuerzo (pills arriba de la fila de teclas)
// pd = tap completo: desde la tarea 12 las pills disparan en pointerup
const pd = (el) => {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
};
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
// 6-pre. badge de la tab Cambios: refreshGit corre desde cualquier tab (init +
// polling de 8 s), así que el badge debe estar visible ANTES de entrar a
// Cambios (asume árbol sucio, igual que "lista archivos modificados" de abajo)
const badgePre = await page.$eval('#tab-changes-badge', (el) => ({
  hidden: el.classList.contains('hidden'),
  n: Number(el.textContent),
}));
ok('badge de Cambios visible desde la pestaña Claude', !badgePre.hidden && badgePre.n > 0);
await page.click('.tab[data-tab="changes"]');
await new Promise((r) => setTimeout(r, 1500));
const branch = await page.$eval('#git-branch', (el) => el.textContent);
ok('header muestra la rama', branch.includes('main'));
const rows = await page.$$('#file-list .file-row');
ok('lista archivos modificados', rows.length > 0);
// badge y lista salen del mismo refreshGit (el de switchTab), tienen que coincidir;
// no se compara contra badgePre: correr el test pisa los shot-*.png trackeados
// y el conteo puede moverse entre el init y esta sección
const badgeN = await page.$eval('#tab-changes-badge', (el) => Number(el.textContent));
ok('badge coincide con la cantidad de archivos listados', badgeN === rows.length);
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

// 9. pestaña Archivos (reemplazó a Shell): árbol read-only del dir de la sesión
await page.click('.tab[data-tab="files"]');
await page.waitForSelector('#file-tree .ft-row', { timeout: 8000 }).catch(() => {});
const ftRows = await page.$$('#file-tree .ft-row');
ok('árbol de archivos renderiza filas', ftRows.length > 0);
// iconos SVG estilo VS Code: carpeta en dirs, icono por tipo en files
const icoStats = await page.evaluate(() => ({
  dirs: document.querySelectorAll('#file-tree .ft-row.dir').length,
  dirSvgs: document.querySelectorAll('#file-tree .ft-row.dir .ft-ico svg').length,
  files: document.querySelectorAll('#file-tree .ft-row.file').length,
  fileSvgs: document.querySelectorAll('#file-tree .ft-row.file .ft-ico svg').length,
}));
ok('todas las filas tienen icono SVG', icoStats.dirs > 0 && icoStats.dirs === icoStats.dirSvgs
  && icoStats.files > 0 && icoStats.files === icoStats.fileSvgs);
// dirs primero en el nivel raíz (los hijos van en .ft-kids, no son hijos directos)
const topTypes = await page.$$eval('#file-tree > .ft-row', (rows) => rows.map((r) => r.classList.contains('dir')));
ok('carpetas primero en el árbol', topTypes.length > 0
  && topTypes.every((isDir, i) => i === 0 || topTypes[i - 1] || !isDir));
// expandir la primera carpeta → carga lazy de hijos (solo lectura)
await page.click('#file-tree > .ft-row.dir');
await new Promise((r) => setTimeout(r, 1000));
ok('expandir carpeta carga sus hijos', (await page.$$('#file-tree .ft-kids .ft-row, #file-tree .ft-kids .empty-state')).length > 0);
// tarea 14: el poll relistea la raíz pero NO re-renderiza si no cambió — el
// marcador en un nodo del DOM y la carpeta expandida deben sobrevivir
const pollKept = await page.evaluate(async () => {
  document.querySelector('#file-tree .ft-row').dataset.marker = 'kept';
  await refreshTree(false);
  return {
    marker: document.querySelector('#file-tree .ft-row').dataset.marker === 'kept',
    expanded: [...document.querySelectorAll('#file-tree .ft-kids')].some((k) => !k.classList.contains('hidden')),
  };
});
ok('poll con raíz sin cambios no re-renderiza el árbol', pollKept.marker && pollKept.expanded);
await page.screenshot({ path: new URL('./shot-files.png', import.meta.url).pathname });
// el botón de vista renderizada no aparece en el árbol (solo con un .md abierto)
ok('botón markdown oculto en la vista de árbol', await page.$eval('#btn-md-render', (el) => el.classList.contains('hidden')));
// abrir un archivo del nivel raíz → vista de contenido; ← vuelve al árbol
// (se elige uno de texto con extensión resaltable: el primero podría ser
// binario —.DS_Store— o texto plano sin lenguaje)
const fileIdx = await page.$$eval('#file-tree > .ft-row.file .ft-name', (ns) => {
  const i = ns.findIndex((n) => /\.(md|json|mjs|js|ts|css|html|yml|yaml)$/i.test(n.textContent));
  return i === -1 ? 0 : i;
});
await (await page.$$('#file-tree > .ft-row.file'))[fileIdx].click();
await page.waitForSelector('#file-view .file-pre', { timeout: 8000 }).catch(() => {});
const fileOpen = await page.evaluate(() => ({
  viewShown: !document.querySelector('#file-view').classList.contains('hidden'),
  treeHidden: document.querySelector('#file-tree').classList.contains('hidden'),
  content: (document.querySelector('#file-view .file-pre') || {}).textContent || '',
  hlSpans: document.querySelectorAll('#file-view .file-pre code.hljs span').length,
}));
ok('tap en un archivo abre la vista con contenido', fileOpen.viewShown && fileOpen.treeHidden && fileOpen.content.length > 0);
ok('contenido con syntax highlighting (hljs)', fileOpen.hlSpans > 0);
// 9b. toggle de vista renderizada de markdown: asegurarse de tener un .md
// abierto (el regex de arriba puede haber elegido otro tipo)
const openedIsMd = await page.$eval('#files-title', (el) => /\.md$/i.test(el.textContent));
if (!openedIsMd) {
  await page.click('#btn-file-back');
  await new Promise((r) => setTimeout(r, 300));
  const mdIdx = await page.$$eval('#file-tree > .ft-row.file .ft-name', (ns) =>
    ns.findIndex((n) => /\.md$/i.test(n.textContent)));
  await (await page.$$('#file-tree > .ft-row.file'))[mdIdx].click();
  await page.waitForSelector('#file-view .file-pre', { timeout: 8000 }).catch(() => {});
}
ok('botón markdown visible con un .md abierto', !(await page.$eval('#btn-md-render', (el) => el.classList.contains('hidden'))));
await page.click('#btn-md-render');
await new Promise((r) => setTimeout(r, 300));
const mdRendered = await page.evaluate(() => ({
  body: !!document.querySelector('#file-view .md-body'),
  elems: document.querySelectorAll('#file-view .md-body h1, #file-view .md-body h2, #file-view .md-body h3, #file-view .md-body p').length,
  active: document.querySelector('#btn-md-render').classList.contains('active'),
}));
ok('toggle → markdown renderizado (.md-body con elementos)', mdRendered.body && mdRendered.elems > 0);
ok('botón markdown marcado como activo', mdRendered.active);
await page.click('#btn-md-render');
await new Promise((r) => setTimeout(r, 300));
const mdSource = await page.evaluate(() => ({
  pre: !!document.querySelector('#file-view .file-pre'),
  body: !!document.querySelector('#file-view .md-body'),
  active: document.querySelector('#btn-md-render').classList.contains('active'),
}));
ok('segundo toggle vuelve a la fuente', mdSource.pre && !mdSource.body && !mdSource.active);
await page.click('#btn-file-back');
await new Promise((r) => setTimeout(r, 300));
ok('botón ← vuelve al árbol', !(await page.$eval('#file-tree', (el) => el.classList.contains('hidden'))));

// 10. service worker registrado + manifest
const swReg = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return !!reg;
});
ok('service worker registrado', swReg);

// 11. sin errores JS en consola
ok(`sin errores JS en consola (${consoleErrors.length})`, consoleErrors.length === 0);
if (consoleErrors.length) console.log('ERRORES:', consoleErrors.slice(0, 5).join('\n'));

// 12. deep-link del push (tarea 1): ?session= selecciona la sesión antes del
// primer attach e history.replaceState limpia la URL (un reload posterior no
// queda pineado). Se usa la default —existe seguro—; la selección de una
// no-default, el rechazo de nombres inválidos y el fallback sin resurrección
// de una muerta los cubre el scratch puppeteer del agente.
await page.goto('http://127.0.0.1:7433/?session=deck', { waitUntil: 'networkidle2', timeout: 20000 });
await new Promise((r) => setTimeout(r, 1500));
const deepLink = await page.evaluate(() => ({
  urlClean: !location.search.includes('session='),
  active: (document.querySelector('#session-chips .chip.active span') || {}).textContent,
}));
ok('deep-link ?session= selecciona la sesión y limpia la URL', deepLink.urlClean && deepLink.active === 'deck');

await page.click('.tab[data-tab="claude"]');
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: new URL('./shot-claude.png', import.meta.url).pathname });

await browser.close();
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
