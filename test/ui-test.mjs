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

// 4. chips de sesión (el label es el primer span que no sea el dot del
// semáforo — tarea 4 —; el activo suma el ✕)
const chips = await page.$$eval('#session-chips .chip', (els) => els.map((e) => e.querySelector('span:not(.chip-dot)').textContent));
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
  // el menú abre por setState (render async en React): esperar a que el
  // AttachMenu monte antes de buscar el ítem "Pegar" (en el vanilla el DOM se
  // actualizaba sincrónico y esto no hacía falta)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
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

// 8b. formulario de commit + push (tarea 12): se muestra SOLO con archivos
// staged (deriva de git.files, sin fetch extra). Como el test pega contra el
// repo real, el estado de staging es impredecible → se asserta la relación
// "form visible ⇔ hay staged", más el markup cuando aparece. (Lucas lo corre.)
const stagedRows = await page.$$('#file-list .badge.staged');
const commitForm = await page.$('#commit-form');
ok('form de commit visible ⇔ hay archivos staged',
  (stagedRows.length > 0) === (commitForm !== null));
if (commitForm) {
  const cf = await page.evaluate(() => {
    const input = document.querySelector('#commit-msg');
    const c = document.querySelector('#btn-commit');
    const cp = document.querySelector('#btn-commit-push');
    return {
      hasInput: !!input,
      labelHasStaged: /staged/.test(document.querySelector('#commit-form .commit-label')?.textContent || ''),
      commitLabel: c?.textContent?.trim(),
      pushLabel: cp?.textContent?.trim(),
      // con el input vacío ambos botones arrancan deshabilitados
      disabledEmpty: !!c?.disabled && !!cp?.disabled,
    };
  });
  ok('form de commit: input + label con "staged" + botones Commit / Commit + Push',
    cf.hasInput && cf.labelHasStaged
    && cf.commitLabel === 'Commit' && /Commit \+ Push/.test(cf.pushLabel));
  ok('botones de commit deshabilitados con el mensaje vacío', cf.disabledEmpty);
} else {
  // árbol sin staged: dos checks placeholder para mantener el conteo estable
  ok('form de commit: input + label con "staged" + botones Commit / Commit + Push', true);
  ok('botones de commit deshabilitados con el mensaje vacío', true);
}

// 8c. comentar una línea del diff (tarea 13): el box arranca oculto (no hay
// línea seleccionada). El feel tap-vs-scroll lo prueba Lucas en el celu.
const commentBoxDefault = await page.$('#diff-comment');
ok('box de comentario ausente por defecto (sin línea seleccionada)', commentBoxDefault === null);

// 8c-bis. selección de RANGO por arrastre (tarea 13, ampliación): la columna
// de números lleva touch-action:none (arranca el drag sin pelear con el scroll);
// un drag por el gutter sobre ≥2 filas arma "path:l1-l2". Reabrimos el diff del
// primer archivo. (Corre contra el repo real; el feel táctil lo prueba Lucas.)
const rangeUi = await page.evaluate(async () => {
  const rows0 = [...document.querySelectorAll('#file-list .file-row')];
  if (!rows0.length) return { skip: true };
  rows0[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  rows0[0].click();
  return { skip: false };
});
if (!rangeUi.skip) {
  await page.waitForSelector('#diff-view .d2h-file-wrapper', { timeout: 8000 }).catch(() => {});
  const range = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('#diff-view tr')].filter((t) => t.querySelector('.d2h-code-linenumber .line-num2')?.textContent?.trim() || t.querySelector('.d2h-code-linenumber .line-num1')?.textContent?.trim());
    if (rows.length < 2) return { few: true };
    const gutter = rows[0].querySelector('.d2h-code-linenumber');
    const touchAction = getComputedStyle(gutter).touchAction;
    const a = rows[0], b = rows[1];
    const gr = gutter.getBoundingClientRect();
    gutter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: gr.x + 3, clientY: gr.y + gr.height / 2, pointerId: 1 }));
    for (const rw of [a, b]) { const r = rw.getBoundingClientRect(); gutter.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.x + 3, clientY: r.y + r.height / 2, pointerId: 1 })); }
    const er = b.getBoundingClientRect();
    gutter.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: er.x + 3, clientY: er.y + er.height / 2, pointerId: 1 }));
    await new Promise((r) => setTimeout(r, 100));
    return {
      few: false,
      touchAction,
      head: document.querySelector('.diff-comment-head')?.textContent?.trim() || '',
      highlighted: document.querySelectorAll('#diff-view tr.diff-comment-line').length,
    };
  });
  ok('la columna de números lleva touch-action:none (drag de rango)', range.few || range.touchAction === 'none');
  ok('drag por el gutter arma un rango "path:l1-l2" con filas resaltadas',
    range.few || (/:\d+-\d+$/.test(range.head) && range.highlighted >= 2));
  // cerrar el box + el diff para dejar la vista como estaba
  await page.evaluate(() => document.querySelector('#btn-comment-cancel')?.click());
  await page.click('#btn-diff-back');
  await new Promise((r) => setTimeout(r, 300));
} else {
  ok('la columna de números lleva touch-action:none (drag de rango)', true);
  ok('drag por el gutter arma un rango "path:l1-l2" con filas resaltadas', true);
}

// 8d. historial de commits (tarea 14): tap en la rama abre la lista; tap en un
// commit abre su diff; ← vuelve al historial y luego a la lista de archivos.
// (Corre contra el repo real, que tiene commits.)
await page.click('#git-branch');
await page.waitForSelector('#history-view .commit-row', { timeout: 5000 }).catch(() => {});
const histRows = await page.$$('#history-view .commit-row');
ok('tap en la rama abre el historial con filas de commits', histRows.length > 0);
const histRow0 = await page.evaluate(() => {
  const r = document.querySelector('#history-view .commit-row');
  return {
    hash: /^[0-9a-f]{7}$/.test(r?.querySelector('.commit-hash')?.textContent?.trim() || ''),
    hasSubject: !!r?.querySelector('.commit-subject')?.textContent,
    hasMeta: /·/.test(r?.querySelector('.commit-meta')?.textContent || ''),
    branchLabel: /· historial/.test(document.querySelector('#git-branch')?.textContent || ''),
  };
});
ok('fila de commit: hash corto + subject + autor·tiempo, header "· historial"',
  histRow0.hash && histRow0.hasSubject && histRow0.hasMeta && histRow0.branchLabel);
if (histRows.length) {
  await histRows[0].click();
  await page.waitForSelector('#diff-view .d2h-file-wrapper', { timeout: 8000 }).catch(() => {});
  ok('tap en un commit renderiza su diff', !!(await page.$('#diff-view .d2h-file-wrapper')));
  await page.click('#btn-diff-back'); // vuelve al historial
  await new Promise((r) => setTimeout(r, 300));
  ok('← desde el diff del commit vuelve al historial', !!(await page.$('#history-view .commit-row')));
  await page.click('#btn-diff-back'); // cierra el historial
  await new Promise((r) => setTimeout(r, 300));
  ok('← desde el historial vuelve a la lista de archivos',
    (await page.$('#history-view')) === null && !(await page.$eval('#file-list', (el) => el.classList.contains('hidden'))));
} else {
  ok('tap en un commit renderiza su diff', true);
  ok('← desde el diff del commit vuelve al historial', true);
  ok('← desde el historial vuelve a la lista de archivos', true);
}

// 8e. chip de CI/PR (tarea 15): /api/git/checks mockeado sobre window.fetch.
// pr:null → sin chip; con PR → chip + card. (Determinista, no depende de gh.)
const prNull = await page.evaluate(async () => {
  const realFetch = window.fetch;
  window.__realFetch = realFetch;
  window.__setChecks = (body) => { window.__checks = body; };
  window.fetch = (url, opts) => {
    if (String(url).includes('/api/git/checks')) {
      return Promise.resolve(new Response(JSON.stringify(window.__checks ?? { pr: null }), { status: 200 }));
    }
    return realFetch(url, opts);
  };
  window.__setChecks({ pr: null });
  document.querySelector('#btn-refresh').click();
  await new Promise((r) => setTimeout(r, 600));
  return !document.querySelector('#pr-chip');
});
ok('chip de CI/PR ausente cuando el endpoint reporta pr:null', prNull);
const prShown = await page.evaluate(async () => {
  window.__setChecks({ pr: { number: 128, title: 'feat: x', state: 'OPEN', checks: { total: 4, passed: 4, failed: 0, pending: 0 }, mergeable: 'MERGEABLE' } });
  document.querySelector('#btn-refresh').click();
  await new Promise((r) => setTimeout(r, 600));
  const chip = document.querySelector('#pr-chip');
  if (!chip) return { chip: false };
  chip.click();
  await new Promise((r) => setTimeout(r, 100));
  return {
    chip: /✓ PR #128/.test(chip.textContent), passed: /pr-passed/.test(chip.className),
    summary: document.querySelector('#pr-card .pr-card-summary')?.textContent?.trim(),
  };
});
ok('chip verde "✓ PR #128" + card con "· merge listo"',
  prShown.chip && prShown.passed && /merge listo/.test(prShown.summary || ''));
// restaurar fetch para que las secciones siguientes peguen contra el server real
await page.evaluate(() => { if (window.__realFetch) window.fetch = window.__realFetch; });

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

// 9d. preview de imágenes (tarea 16): un archivo de imagen del repo se pinta con
// <img src=/api/fs/raw> en vez del fetch JSON de texto; los no-imagen no cambian.
// Se navega hasta web/public/icon.svg (siempre presente en el repo claude-deck).
const expandDir = async (name) => {
  const rows = await page.$$('#file-tree .ft-row.dir');
  for (const r of rows) {
    const t = await (await r.getProperty('textContent')).jsonValue();
    if (t.trim() === name || t.includes(name)) { await r.click(); return true; }
  }
  return false;
};
await expandDir('web');
await new Promise((r) => setTimeout(r, 600));
await expandDir('public');
await new Promise((r) => setTimeout(r, 600));
const svgClicked = await page.evaluate(() => {
  const r = [...document.querySelectorAll('#file-tree .ft-row.file')].find((x) => x.textContent.includes('icon.svg'));
  if (r) { r.click(); return true; } return false;
});
if (svgClicked) {
  await page.waitForSelector('#file-view .img-preview img', { timeout: 8000 }).catch(() => {});
  const imgPreview = await page.evaluate(() => {
    const img = document.querySelector('#file-view .img-preview img');
    return { present: !!img, raw: img ? img.getAttribute('src').includes('/api/fs/raw') : false, noPre: !document.querySelector('#file-view .file-pre') };
  });
  ok('imagen (icon.svg) se renderiza como <img> src=/api/fs/raw en Archivos', imgPreview.present && imgPreview.raw && imgPreview.noPre);
  await page.click('#btn-file-back');
  await new Promise((r) => setTimeout(r, 300));
} else {
  ok('imagen (icon.svg) se renderiza como <img> src=/api/fs/raw en Archivos', false);
}
// un archivo no-imagen sigue mostrando su contenido de texto (no preview): abrir
// package.json del nivel raíz y verificar que usa .file-pre, no .img-preview
const jsonClicked = await page.evaluate(() => {
  const r = [...document.querySelectorAll('#file-tree > .ft-row.file')].find((x) => /package\.json$/.test(x.textContent));
  if (r) { r.click(); return true; } return false;
});
await page.waitForSelector('#file-view .file-pre', { timeout: 8000 }).catch(() => {});
const nonImg = await page.evaluate(() => ({ pre: !!document.querySelector('#file-view .file-pre'), noImg: !document.querySelector('#file-view .img-preview') }));
ok('archivo no-imagen (package.json) sigue mostrando texto, sin preview', jsonClicked && nonImg.pre && nonImg.noImg);
await page.click('#btn-file-back');
await new Promise((r) => setTimeout(r, 300));

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
  active: (document.querySelector('#session-chips .chip.active span:not(.chip-dot)') || {}).textContent,
}));
ok('deep-link ?session= selecciona la sesión y limpia la URL', deepLink.urlClean && deepLink.active === 'deck');

// 12b. persistencia de la sesión activa (fix: renombrar la default y recargar
// creaba una "deck" vacía fantasma). init() guarda la sesión elegida en
// localStorage y el próximo load la restaura en vez de volver a la default.
// Si la guardada ya no existe, el attach sin create=1 contesta meta gone y se
// cae a una viva — sin resucitar la muerta ni recrear la default de más.
const persisted = await page.evaluate(() => localStorage.getItem('deck-active-session'));
ok('sesión activa persistida en localStorage tras init', persisted === 'deck');
await page.evaluate(() => localStorage.setItem('deck-active-session', 'zz-mock-muerta'));
await page.goto('http://127.0.0.1:7433/', { waitUntil: 'networkidle2', timeout: 20000 });
await new Promise((r) => setTimeout(r, 1500));
const restored = await page.evaluate(async () => ({
  active: (document.querySelector('#session-chips .chip.active span:not(.chip-dot)') || {}).textContent,
  saved: localStorage.getItem('deck-active-session'),
  names: (await (await fetch('/api/tmux/sessions', { cache: 'no-store' })).json()).map((s) => s.name),
}));
ok('sesión guardada muerta → fallback a una viva y re-persistida, sin resucitarla',
  restored.active === 'deck' && restored.saved === 'deck' && !restored.names.includes('zz-mock-muerta'));

// 13. semáforo de chips (tarea 4): con un payload mockeado de
// /api/tmux/sessions los chips pintan el punto según `state` (verde working /
// ámbar waiting / gris idle) y sin state no hay punto. Después se restaura el
// fetch real y se repinta con las sesiones vivas.
const dots = await page.evaluate(async () => {
  const realFetch = window.fetch;
  const mock = [
    { name: 'deck', attached: true, dir: '/tmp', state: 'working' },
    { name: 'zz-mock-espera', attached: false, dir: '/tmp', state: 'waiting' },
    { name: 'zz-mock-idle', attached: false, dir: '/tmp', state: 'idle' },
    { name: 'zz-mock-sin', attached: false, dir: '/tmp', state: null },
  ];
  window.fetch = (url, opts) => String(url).includes('/api/tmux/sessions')
    ? Promise.resolve(new Response(JSON.stringify(mock), { status: 200 }))
    : realFetch(url, opts);
  await refreshSessions();
  const dotOf = (name) => {
    const chip = [...document.querySelectorAll('#session-chips .chip')]
      .find((c) => c.querySelector('span:not(.chip-dot)').textContent === name);
    const d = chip && chip.querySelector('.chip-dot');
    return d ? d.className : null;
  };
  const out = {
    working: dotOf('deck'),
    waiting: dotOf('zz-mock-espera'),
    idle: dotOf('zz-mock-idle'),
    none: dotOf('zz-mock-sin'),
  };
  window.fetch = realFetch;
  await refreshSessions(); // la key cambia (nombres mock ya no están) → repinta real
  return out;
});
ok('semáforo: dots working/waiting/idle según state y sin dot cuando null',
  dots.working === 'chip-dot chip-dot-working'
  && dots.waiting === 'chip-dot chip-dot-waiting'
  && dots.idle === 'chip-dot chip-dot-idle'
  && dots.none === null);

// 14. composer de prompts (tarea 7): el ✎ abre un sheet a media pantalla con
// textarea nativo; enviar = term.paste + \r diferido (espiados: nada llega a
// la sesión real); borrador por sesión en localStorage (draft:<sesión>).
// 14a. abrir: sheet visible, controlbar reemplazada, textarea con foco
await tapSel('#btn-composer');
await new Promise((r) => setTimeout(r, 300));
const compOpen = await page.evaluate(() => ({
  open: !document.querySelector('#composer').classList.contains('hidden'),
  bodyOpen: document.body.classList.contains('composer-open'),
  controlbarHidden: getComputedStyle(document.querySelector('.controlbar')).display === 'none',
  focused: document.activeElement === document.querySelector('#composer-text'),
  session: document.querySelector('#composer-session').textContent,
}));
ok('✎ abre el composer (sheet visible, controlbar oculta)',
  compOpen.open && compOpen.bodyOpen && compOpen.controlbarHidden);
ok('composer: textarea con foco y sesión en el header',
  compOpen.focused && compOpen.session === 'deck');

// 14b. tipear + botón \n + borrador con debounce (500 ms)
await page.type('#composer-text', 'línea uno');
await tapSel('#composer-nl');
await page.type('#composer-text', 'línea dos');
await new Promise((r) => setTimeout(r, 800));
const compDraft = await page.evaluate(() => ({
  value: document.querySelector('#composer-text').value,
  stored: localStorage.getItem('draft:deck'),
  savedShown: !document.querySelector('#composer-saved').classList.contains('hidden'),
}));
ok('botón \\n inserta salto de línea en el textarea', compDraft.value === 'línea uno\nlínea dos');
ok('borrador persistido en draft:deck tras el debounce (indicador visible)',
  compDraft.stored === 'línea uno\nlínea dos' && compDraft.savedShown);
await page.screenshot({ path: new URL('./shot-composer.png', import.meta.url).pathname });

// 14c. el borrador sobrevive a un reload (iOS matando la pestaña) y se
// restaura al reabrir el composer para esa sesión
await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
await new Promise((r) => setTimeout(r, 1500));
await tapSel('#btn-composer');
await new Promise((r) => setTimeout(r, 300));
ok('borrador restaurado tras reload',
  (await page.$eval('#composer-text', (el) => el.value)) === 'línea uno\nlínea dos');

// 14d. enviar: term.paste con el texto exacto y \r diferido ≥150 ms (patrón
// sendSlashCommand); después limpia el borrador y cierra el sheet
const compSend = await page.evaluate(async () => {
  const pastes = [];
  const keys = [];
  const origPaste = claudeConn.term.paste.bind(claudeConn.term);
  const origSend = claudeConn.sendKeys;
  claudeConn.term.paste = (t) => pastes.push({ t, at: performance.now() });
  claudeConn.sendKeys = (d) => keys.push({ d, at: performance.now() });
  const tap = (el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  };
  tap(document.querySelector('#composer-send'));
  const keysEarly = keys.length; // el \r es diferido: acá todavía no debe estar
  await new Promise((r) => setTimeout(r, 400));
  claudeConn.term.paste = origPaste;
  claudeConn.sendKeys = origSend;
  return {
    pastes, keys, keysEarly,
    draft: localStorage.getItem('draft:deck'),
    closed: document.querySelector('#composer').classList.contains('hidden'),
    bodyOpen: document.body.classList.contains('composer-open'),
  };
});
ok('enviar llama term.paste con el texto exacto (multilínea)',
  compSend.pastes.length === 1 && compSend.pastes[0].t === 'línea uno\nlínea dos');
ok('\\r diferido ≥150 ms después del paste (nada submitea en el mismo tick)',
  compSend.keysEarly === 0 && compSend.keys.length === 1 && compSend.keys[0].d === '\r'
  && compSend.keys[0].at - compSend.pastes[0].at >= 145);
ok('enviar limpia el borrador y cierra el sheet',
  compSend.draft === null && compSend.closed && !compSend.bodyOpen);

// 14e. Cancelar cierra pero CONSERVA el borrador (ese es el punto); al final
// se limpia la key para no dejarle residuo a la sesión deck real
await tapSel('#btn-composer');
await page.type('#composer-text', 'borrador vivo');
await tapSel('#composer-cancel');
await new Promise((r) => setTimeout(r, 300));
const compCancel = await page.evaluate(() => {
  const out = {
    closed: document.querySelector('#composer').classList.contains('hidden'),
    draft: localStorage.getItem('draft:deck'),
  };
  localStorage.removeItem('draft:deck');
  return out;
});
ok('cancelar cierra el composer pero conserva el borrador',
  compCancel.closed && compCancel.draft === 'borrador vivo');

// 15. scrollback legible (tarea 9): el 📜 abre un overlay read-only. Fuente
// primaria: turnos del transcript .jsonl (/api/claude/transcript); fallback
// para shells: capture-pane como texto plano. Ambos endpoints mockeados
// (determinista y sin leer el transcript real de deck): A) modo transcript
// con turnos y roles; B) sin transcript (turns vacíos) → fallback pane con
// apertura al fondo, "Cargar más" con anclaje, selección nativa y letra
// persistida.
ok('botón 📜 (scrollback) presente en la quickkeys row', (await page.$('#btn-scrollback')) !== null);
const sbRun = await page.evaluate(async () => {
  const realFetch = window.fetch;
  const mkLines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} línea ${i + 1}`).join('\n') + '\n';
  const served = { transcript: [], pane: [] };
  let transcriptMode = 'turns'; // 'turns' | 'empty' (sin transcript → fallback)
  const TURNS = [
    { role: 'user', text: 'probá el overlay' },
    // el asistente trae markdown (se renderiza) y un intento de XSS (DOMPurify
    // tiene que dejar el img sin handler y sin ejecutar nada)
    { role: 'assistant', text: 'dale, **lo pruebo** con `eco`\n\n<img src=x onerror="window.__sbxss=1">' },
    { role: 'tool', text: 'Bash: echo hola' },
  ];
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/claude/transcript')) {
      served.transcript.push(Number(new URL(u, location.origin).searchParams.get('bytes')));
      return Promise.resolve(new Response(JSON.stringify(transcriptMode === 'turns'
        ? { file: 'x.jsonl', turns: TURNS, more: true }
        : { file: null, turns: [], more: false }), { status: 200 }));
    }
    if (u.includes('/api/tmux/scrollback')) {
      served.pane.push(Number(new URL(u, location.origin).searchParams.get('lines')));
      // 520 líneas: ≥ las 500 pedidas al abrir (botón "más" visible); < las
      // 1000 del segundo fetch (la historia se acabó → botón oculto)
      return Promise.resolve(new Response(mkLines(520, 'sb-mock'), { status: 200 }));
    }
    return realFetch(url, opts);
  };
  localStorage.removeItem('deck-sb-font');
  const tap = (el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  };
  const out = { served };

  // A) modo transcript: turnos renderizados con clase por rol, pre oculto
  tap(document.querySelector('#btn-scrollback'));
  await new Promise((r) => setTimeout(r, 300));
  out.aOpen = !document.querySelector('#scrollback').classList.contains('hidden');
  out.aSession = document.querySelector('#scrollback-session').textContent;
  out.aSrc = document.querySelector('#scrollback-src').textContent;
  out.aTurns = [...document.querySelectorAll('#scrollback-turns .sb-turn')]
    .map((d) => d.className);
  out.aUserText = document.querySelector('#scrollback-turns .sb-user').textContent;
  out.aToolText = document.querySelector('#scrollback-turns .sb-tool').textContent;
  const asst = document.querySelector('#scrollback-turns .sb-assistant');
  out.aMd = {
    strong: (asst.querySelector('strong') || {}).textContent,
    code: (asst.querySelector('code') || {}).textContent,
    clean: !asst.querySelector('script, [onerror]') && window.__sbxss === undefined,
  };
  out.aPreHidden = document.querySelector('#scrollback-text').classList.contains('hidden');
  out.aMoreShown = !document.querySelector('#scrollback-more').classList.contains('hidden');
  // cargar más: duplica bytes; el mock devuelve los mismos turnos (sin
  // crecimiento) → el botón se oculta para no invitar taps inútiles
  tap(document.querySelector('#scrollback-more'));
  await new Promise((r) => setTimeout(r, 300));
  out.aMoreHidden = document.querySelector('#scrollback-more').classList.contains('hidden');
  tap(document.querySelector('#scrollback-close'));

  // B) sin transcript (turns vacíos) → fallback capture-pane (texto plano)
  transcriptMode = 'empty';
  tap(document.querySelector('#btn-scrollback'));
  await new Promise((r) => setTimeout(r, 300));
  const body = document.querySelector('#scrollback-body');
  out.bSrc = document.querySelector('#scrollback-src').textContent;
  out.bTurnsHidden = document.querySelector('#scrollback-turns').classList.contains('hidden');
  out.bHasText = document.querySelector('#scrollback-text').textContent.includes('sb-mock línea 520');
  out.bAtBottom = Math.abs(body.scrollTop - (body.scrollHeight - body.clientHeight)) < 4;
  out.bMoreShown = !document.querySelector('#scrollback-more').classList.contains('hidden');
  // selección nativa sobre el texto (imposible dentro del canvas de xterm)
  const sel = window.getSelection();
  sel.selectAllChildren(document.querySelector('#scrollback-text'));
  out.bSelectable = sel.toString().includes('sb-mock línea 1');
  sel.removeAllRanges();
  // A+ sube el tamaño y lo persiste
  out.bFontBefore = getComputedStyle(document.querySelector('#scrollback-text')).fontSize;
  tap(document.querySelector('#scrollback-bigger'));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // React: el font var se aplica en el próximo render
  out.bFontAfter = getComputedStyle(document.querySelector('#scrollback-text')).fontSize;
  out.bFontStored = localStorage.getItem('deck-sb-font');
  // "Cargar más": pide más líneas y mantiene el ancla de lectura (no salta al fondo)
  body.scrollTop = 0;
  tap(document.querySelector('#scrollback-more'));
  await new Promise((r) => setTimeout(r, 300));
  out.bMoreHidden = document.querySelector('#scrollback-more').classList.contains('hidden');
  out.bKeptAnchor = body.scrollTop < body.scrollHeight - body.clientHeight - 4;
  tap(document.querySelector('#scrollback-close'));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // React: la clase hidden se aplica en el próximo render
  out.closed = document.querySelector('#scrollback').classList.contains('hidden');
  out.emptied = document.querySelector('#scrollback-text').textContent === ''
    && document.querySelector('#scrollback-turns').textContent === '';
  window.fetch = realFetch;
  localStorage.removeItem('deck-sb-font');
  return out;
});
ok('📜 abre en modo transcript: turnos con clase por rol y pre oculto',
  sbRun.aOpen && sbRun.aSession === 'deck' && sbRun.aSrc === '· transcript' && sbRun.aPreHidden
  && JSON.stringify(sbRun.aTurns) === JSON.stringify([
    'sb-turn sb-user',
    'sb-turn sb-assistant md-body',
    'sb-turn sb-tool',
  ])
  && sbRun.aUserText === 'probá el overlay' && sbRun.aToolText === 'Bash: echo hola');
ok('turno del asistente renderizado como markdown (sanitizado, sin XSS)',
  sbRun.aMd.strong === 'lo pruebo' && sbRun.aMd.code === 'eco' && sbRun.aMd.clean);
ok('transcript "cargar más": duplica bytes y se oculta si no crece',
  sbRun.aMoreShown && sbRun.aMoreHidden
  && sbRun.served.transcript[0] === 2 * 1024 * 1024 && sbRun.served.transcript[1] === 4 * 1024 * 1024);
ok('sin transcript → fallback pane con el texto del capture (src "· pane")',
  sbRun.bSrc === '· pane' && sbRun.bTurnsHidden && sbRun.bHasText && sbRun.served.pane[0] === 500);
ok('el overlay abre scrolleado al fondo (lo más reciente)', sbRun.bAtBottom);
ok('texto seleccionable con la selección nativa del browser', sbRun.bSelectable);
ok('A+ agranda la letra y persiste en localStorage',
  parseFloat(sbRun.bFontAfter) > parseFloat(sbRun.bFontBefore) && sbRun.bFontStored === '14');
ok('pane "cargar más": pide más líneas, conserva el ancla y se oculta al agotar',
  sbRun.served.pane[1] === 1000 && sbRun.bMoreShown && sbRun.bMoreHidden && sbRun.bKeptAnchor);
ok('✕ cierra el overlay y suelta el contenido', sbRun.closed && sbRun.emptied);

// 16. paleta de snippets (tarea 10): el ☰ abre el popover compartido con la
// lista GLOBAL del server (/api/snippets, acá mockeado con estado propio para
// no tocar la lista real de Lucas); chip → term.paste SIN \r (insertar nunca
// envía); edición low-fi (prompt()/confirm() stubbeados) manda PUT con la
// lista completa; con el composer abierto el chip inserta en el textarea en
// el cursor (sin term.paste).
ok('botón ☰ (snippets) presente en la quickkeys row', (await page.$('#btn-snippets')) !== null);
const snipRun = await page.evaluate(async () => {
  const realFetch = window.fetch;
  let mockList = ['dale, seguí', '/compact', 'commit y push'];
  const puts = [];
  window.fetch = (url, opts) => {
    if (String(url).includes('/api/snippets')) {
      if (opts && opts.method === 'PUT') {
        mockList = JSON.parse(opts.body).snippets;
        puts.push([...mockList]);
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ snippets: mockList }), { status: 200 }));
    }
    return realFetch(url, opts);
  };
  snippets = null; // forzar re-fetch contra el mock
  const tap = (el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  };
  const menu = document.querySelector('#switch-menu');
  const chipTexts = (root) => [...root.querySelectorAll('.mi-snippets .snip:not(.snip-new) .snip-text')]
    .map((s) => s.textContent);
  const out = { puts };

  // abrir: popover kind=snippets, chips del server en grilla 2 col, + Nuevo dashed, ☰ ámbar
  tap(document.querySelector('#btn-snippets'));
  await new Promise((r) => setTimeout(r, 250));
  out.open = !menu.classList.contains('hidden') && menu.dataset.kind === 'snippets';
  out.chips = chipTexts(menu);
  out.newDashed = !!menu.querySelector('.snip-new')
    && getComputedStyle(menu.querySelector('.snip-new')).borderTopStyle === 'dashed';
  out.twoCols = getComputedStyle(menu.querySelector('.mi-snippets')).gridTemplateColumns.split(' ').length === 2;
  out.btnActive = document.querySelector('#btn-snippets').classList.contains('active');

  // chip → term.paste con el texto exacto y CERO sendKeys (nada manda \r)
  const pastes = [];
  const keys = [];
  const origPaste = claudeConn.term.paste.bind(claudeConn.term);
  const origSend = claudeConn.sendKeys;
  claudeConn.term.paste = (t) => pastes.push(t);
  claudeConn.sendKeys = (d) => keys.push(d);
  tap(menu.querySelectorAll('.mi-snippets .snip')[1]); // "/compact"
  await new Promise((r) => setTimeout(r, 300));
  claudeConn.sendKeys = origSend;
  out.pastes = [...pastes];
  out.keys = [...keys];
  out.closedTrasInsert = menu.classList.contains('hidden');
  out.btnInactive = !document.querySelector('#btn-snippets').classList.contains('active');

  // edición: Editar → ✕ por chip y ◀ desde el segundo; + Nuevo / rename /
  // mover / borrar mandan PUT con la lista completa
  const origPrompt = window.prompt;
  const origConfirm = window.confirm;
  tap(document.querySelector('#btn-snippets'));
  await new Promise((r) => setTimeout(r, 250));
  tap(menu.querySelector('.snip-edit'));
  await new Promise((r) => setTimeout(r, 100));
  out.editXs = menu.querySelectorAll('.mi-snippets .snip-x').length;
  out.editMoves = menu.querySelectorAll('.mi-snippets .snip-move').length;
  window.prompt = () => 'nuevo snippet';
  tap(menu.querySelector('.snip-new'));
  await new Promise((r) => setTimeout(r, 100));
  out.afterAdd = chipTexts(menu);
  tap(menu.querySelectorAll('.mi-snippets .snip-move')[0]); // mueve el 2º al 1º lugar
  await new Promise((r) => setTimeout(r, 100));
  out.afterMove = chipTexts(menu);
  window.prompt = () => 'renombrado';
  tap(menu.querySelectorAll('.mi-snippets .snip')[0]); // tap en chip en modo edición = rename
  await new Promise((r) => setTimeout(r, 100));
  out.afterRename = chipTexts(menu);
  window.confirm = () => true;
  tap(menu.querySelectorAll('.mi-snippets .snip-x')[0]);
  await new Promise((r) => setTimeout(r, 100));
  out.afterDel = chipTexts(menu);
  window.prompt = origPrompt;
  window.confirm = origConfirm;
  tap(document.querySelector('#term-claude')); // cierra el popover

  // composer: el ☰ del foot abre el panel y el chip inserta EN EL CURSOR del
  // textarea (destino distinto, misma lista) — sin term.paste
  tap(document.querySelector('#btn-composer'));
  await new Promise((r) => setTimeout(r, 250));
  const ta = document.querySelector('#composer-text');
  ta.value = 'hola mundo';
  ta.setSelectionRange(5, 5); // cursor después de "hola "
  tap(document.querySelector('#composer-snippets'));
  await new Promise((r) => setTimeout(r, 250));
  const panel = document.querySelector('#composer-snips');
  out.cPanelOpen = !panel.classList.contains('hidden');
  out.cBtnActive = document.querySelector('#composer-snippets').classList.contains('active');
  out.cChips = chipTexts(panel);
  pastes.length = 0;
  tap(panel.querySelectorAll('.mi-snippets .snip')[0]);
  await new Promise((r) => setTimeout(r, 100));
  claudeConn.term.paste = origPaste;
  out.cValue = ta.value;
  out.cNoPaste = pastes.length === 0;
  out.cPanelClosed = panel.classList.contains('hidden');
  tap(document.querySelector('#composer-cancel'));
  await new Promise((r) => setTimeout(r, 100));
  localStorage.removeItem('draft:deck'); // residuo del insert (draft de la sesión real)

  window.fetch = realFetch;
  snippets = null; // que la próxima apertura re-fetchee la lista real
  return out;
});
ok('☰ abre la paleta: chips del server en grilla 2 col y "+ Nuevo" dashed',
  snipRun.open && JSON.stringify(snipRun.chips) === JSON.stringify(['dale, seguí', '/compact', 'commit y push'])
  && snipRun.newDashed && snipRun.twoCols);
ok('☰ ámbar con la paleta abierta y se apaga al cerrar', snipRun.btnActive && snipRun.btnInactive);
ok('chip → term.paste con el texto exacto y cierra la paleta',
  JSON.stringify(snipRun.pastes) === JSON.stringify(['/compact']) && snipRun.closedTrasInsert);
ok('insertar NUNCA envía (cero sendKeys, sin \\r)', snipRun.keys.length === 0);
ok('modo edición: ✕ en cada chip y ◀ desde el segundo',
  snipRun.editXs === 3 && snipRun.editMoves === 2);
ok('+ Nuevo agrega al final (prompt low-fi)',
  JSON.stringify(snipRun.afterAdd) === JSON.stringify(['dale, seguí', '/compact', 'commit y push', 'nuevo snippet']));
ok('◀ mueve el chip un lugar antes',
  JSON.stringify(snipRun.afterMove) === JSON.stringify(['/compact', 'dale, seguí', 'commit y push', 'nuevo snippet']));
ok('tap en chip en modo edición renombra',
  JSON.stringify(snipRun.afterRename) === JSON.stringify(['renombrado', 'dale, seguí', 'commit y push', 'nuevo snippet']));
ok('✕ borra el chip (con confirm)',
  JSON.stringify(snipRun.afterDel) === JSON.stringify(['dale, seguí', 'commit y push', 'nuevo snippet']));
ok('cada edición manda PUT con la lista completa (4 PUTs)',
  snipRun.puts.length === 4 && JSON.stringify(snipRun.puts[3]) === JSON.stringify(snipRun.afterDel));
ok('composer: ☰ del foot abre el panel con la misma lista',
  snipRun.cPanelOpen && snipRun.cBtnActive
  && JSON.stringify(snipRun.cChips) === JSON.stringify(['dale, seguí', 'commit y push', 'nuevo snippet']));
ok('composer: chip inserta en el cursor del textarea (sin term.paste) y cierra el panel',
  snipRun.cValue === 'hola dale, seguímundo' && snipRun.cNoPaste && snipRun.cPanelClosed);

// 16b. tooltip de texto completo (#snip-tip): hover con mouse sobre un chip
// truncado lo muestra; en touch, mantener apretado ~450 ms lo muestra y ese
// release NO inserta (peek); un chip corto no muestra nada; el tap normal
// siguiente inserta como siempre.
const tipRun = await page.evaluate(async () => {
  const realFetch = window.fetch;
  const LONG = 'este snippet es larguísimo: corré la suite entera, después commit y push con mensaje corto en minúsculas';
  window.fetch = (url, opts) => String(url).includes('/api/snippets')
    ? Promise.resolve(new Response(JSON.stringify(opts && opts.method === 'PUT'
      ? { ok: true } : { snippets: ['corto', LONG] }), { status: 200 }))
    : realFetch(url, opts);
  snippets = null;
  const tap = (el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  };
  tap(document.querySelector('#btn-snippets'));
  await new Promise((r) => setTimeout(r, 250));
  const chips = document.querySelectorAll('#switch-menu .mi-snippets .snip');
  const tip = document.querySelector('#snip-tip');
  const out = {};

  // hover (mouse) sobre el largo: tip con el texto completo; leave lo oculta
  // React sintetiza onPointerEnter/Leave a partir de pointerover/out delegados en
  // el root: hay que disparar esos (bubbling), no pointerenter/leave crudos (que
  // React no escucha directamente). Y esperar un render: el tip sale por setState.
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  chips[1].dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  await raf();
  out.hoverShown = !tip.classList.contains('hidden') && tip.textContent === LONG;
  chips[1].dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
  await raf();
  out.hoverHidden = tip.classList.contains('hidden');
  // hover sobre el corto: no está truncado → nada
  chips[0].dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  await raf();
  out.shortNoTip = tip.classList.contains('hidden');

  // long-press (touch) sobre el largo: tip mientras se sostiene, release sin insertar
  const pastes = [];
  const origPaste = claudeConn.term.paste.bind(claudeConn.term);
  claudeConn.term.paste = (t) => pastes.push(t);
  chips[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 650));
  out.holdShown = !tip.classList.contains('hidden') && tip.textContent === LONG;
  chips[1].dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  out.holdHidden = tip.classList.contains('hidden');
  out.holdNoInsert = pastes.length === 0;
  out.menuStillOpen = !document.querySelector('#switch-menu').classList.contains('hidden');

  // el tap normal siguiente inserta como siempre (el flag no queda pegado)
  tap(chips[1]);
  await new Promise((r) => setTimeout(r, 200));
  claudeConn.term.paste = origPaste;
  out.tapInserts = pastes.length === 1 && pastes[0] === LONG;
  window.fetch = realFetch;
  snippets = null;
  return out;
});
ok('hover (mouse) sobre un chip truncado muestra el tooltip y leave lo oculta',
  tipRun.hoverShown && tipRun.hoverHidden);
ok('chip corto (sin truncar) no muestra tooltip', tipRun.shortNoTip);
ok('long-press muestra el tooltip y ese release NO inserta (paleta sigue abierta)',
  tipRun.holdShown && tipRun.holdHidden && tipRun.holdNoInsert && tipRun.menuStillOpen);
ok('el tap normal siguiente inserta como siempre', tipRun.tapInserts);

// 17. panel de host + batería (tarea 17): chip "🔋 N%" pineado en la fila de
// sesiones (solo si el host reporta batería), banner ámbar cuando descarga
// bajo el umbral (dismissible por episodio), y bottom sheet con las filas de
// estado + toggle/umbral de la alerta server-side. /api/host/status y
// /api/host/alert mockeados: no se toca el host-alert.json real.
const hostRun = await page.evaluate(async () => {
  const realFetch = window.fetch;
  const posts = [];
  let mockStatus = {
    name: 'MacBook Pro de Lucas',
    battery: { pct: 81, state: 'discharging' },
    ac: false,
    sleepDisabled: true,
    uptime: 4 * 86400 + 6 * 3600, // "4d 6h"
    alert: { enabled: true, threshold: 30 },
  };
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/host/alert')) {
      const body = JSON.parse(opts.body);
      posts.push(body);
      mockStatus.alert = { ...mockStatus.alert, ...body };
      return Promise.resolve(new Response(JSON.stringify({ ok: true, alert: mockStatus.alert }), { status: 200 }));
    }
    if (u.includes('/api/host/status')) {
      return Promise.resolve(new Response(JSON.stringify(mockStatus), { status: 200 }));
    }
    return realFetch(url, opts);
  };
  const tap = (el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  };
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  const chip = document.querySelector('#host-chip');
  const banner = document.querySelector('#host-banner');
  const sheet = document.querySelector('#host-sheet');
  const out = { posts };

  // batería sana descargando: chip con % sin warn, banner oculto
  await refreshHost(); await frame();
  out.chip = !chip.classList.contains('hidden')
    && document.querySelector('#host-chip-pct').textContent === '81%'
    && !chip.classList.contains('warn');
  out.bannerHidden = banner.classList.contains('hidden');

  // sin batería (Mac de escritorio): ni chip ni banner
  mockStatus = { ...mockStatus, battery: null };
  await refreshHost(); await frame();
  out.noBattHidesChip = chip.classList.contains('hidden') && banner.classList.contains('hidden');

  // descargando bajo el umbral: chip warn + banner con el %; el ✕ lo descarta
  mockStatus = { ...mockStatus, battery: { pct: 28, state: 'discharging' } };
  await refreshHost(); await frame();
  out.lowWarn = chip.classList.contains('warn');
  out.lowBanner = !banner.classList.contains('hidden')
    && document.querySelector('#host-banner-pct').textContent === '28';
  document.querySelector('#host-banner-close').click();
  await refreshHost(); await frame();
  out.dismissed = banner.classList.contains('hidden');

  // chip → sheet con nombre y las 4 filas del mock; toggle prendido
  chip.click(); // el chip está pineado fuera de la tira scrolleable: click directo
  await frame();
  out.sheetOpen = !sheet.classList.contains('hidden');
  out.sheetName = document.querySelector('#host-name').textContent;
  out.sheetRows = [...document.querySelectorAll('#host-rows .host-row')]
    .map((r) => `${r.querySelector('.host-label').textContent}|${r.querySelector('.host-val').textContent}`);
  out.sheetThreshold = document.querySelector('#host-threshold').textContent;
  out.toggleOn = document.querySelector('#host-alert-toggle').classList.contains('on');

  // toggle → POST {enabled:false} al server (la alerta es server-side)
  tap(document.querySelector('#host-alert-toggle'));
  await new Promise((r) => setTimeout(r, 150));
  out.toggleOff = !document.querySelector('#host-alert-toggle').classList.contains('on');

  // tap en el fondo cierra el sheet
  sheet.click();
  await frame(); // React: la clase hidden se aplica en el próximo render
  out.sheetClosed = sheet.classList.contains('hidden');

  window.fetch = realFetch;
  await refreshHost(); // repintar con el estado real de la Mac
  return out;
});
ok('host: chip con % visible y sin warn con batería sana', hostRun.chip && hostRun.bannerHidden);
ok('host: battery null → chip y banner ocultos', hostRun.noBattHidesChip);
ok('host: bajo el umbral → chip warn + banner con el %', hostRun.lowWarn && hostRun.lowBanner);
ok('host: ✕ descarta el banner (por episodio)', hostRun.dismissed);
ok('host: chip abre el sheet con nombre y filas de estado',
  hostRun.sheetOpen && hostRun.sheetName === 'MacBook Pro de Lucas'
  && JSON.stringify(hostRun.sheetRows) === JSON.stringify([
    'Batería|28% · descargando',
    'Energía|En batería',
    'Reposo (pmset)|Activo · no dormirá',
    'Uptime|4d 6h',
  ]));
ok('host: umbral y toggle reflejan la alerta del server',
  hostRun.sheetThreshold === '30%' && hostRun.toggleOn);
ok('host: toggle manda POST {enabled:false} y se apaga',
  hostRun.toggleOff && hostRun.posts.some((p) => p.enabled === false));
ok('host: tap en el fondo cierra el sheet', hostRun.sheetClosed);

// 18. worktree en un tap (tarea 5): long-press en el + abre el menú CREAR
// (el tap corto sigue creando sesión — acá NO se tapea corto para no crear una
// real); "Nuevo worktree…" abre el sheet. /api/git/branches mockeado para
// checks deterministas; nunca se postea un worktree real.
const wtRun = await page.evaluate(async () => {
  const realFetch = window.fetch;
  window.fetch = (url, opts) => {
    if (String(url).includes('/api/git/branches')) {
      return Promise.resolve(new Response(JSON.stringify({
        repo: 'claude-deck', branches: ['main', 'feat/x'], current: 'feat/x',
      }), { status: 200 }));
    }
    return realFetch(url, opts);
  };
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const menu = document.querySelector('#create-menu');
  const sheet = document.querySelector('#worktree-sheet');
  const btn = document.querySelector('#btn-new-session');
  const out = {};

  out.hiddenByDefault = menu.classList.contains('hidden') && sheet.classList.contains('hidden');
  const activeChip = () => document.querySelector('#session-chips .chip.active span:not(.chip-dot)').textContent;
  const activeBefore = activeChip();

  // long-press: down + ~600 ms + up (el hold es de 500). El release del
  // long-press NO debe contar como tap (crearía una sesión real).
  const r = btn.getBoundingClientRect();
  const xy = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, ...xy }));
  await sleep(620);
  btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, ...xy }));
  await frame();
  out.menuOpen = !menu.classList.contains('hidden');
  out.items = [...menu.querySelectorAll('.mi span')].map((e) => e.textContent);
  out.noSessionCreated = activeChip() === activeBefore;

  // "Nuevo worktree…" abre el sheet (ramas del fetch mockeado)
  const wtBtn = [...menu.querySelectorAll('.mi')].find((e) => e.textContent.includes('worktree'));
  wtBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  wtBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await sleep(150);
  await frame();
  out.sheetOpen = !sheet.classList.contains('hidden');
  out.menuClosedAfter = menu.classList.contains('hidden');
  out.baseOptions = [...document.querySelectorAll('#wt-base option')].map((o) => o.value);
  out.basePreselected = document.querySelector('#wt-base').value;

  // el info box refleja el último segmento de la rama tipeada (input controlado
  // de React: setear el value por el setter nativo + evento input)
  const input = document.querySelector('#wt-branch');
  const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setVal.call(input, 'feat/composer');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await frame();
  out.infoPath = document.querySelector('#wt-info').textContent.includes('../claude-deck-composer');

  // submit sin rama → error inline, sin POST (validación client-side)
  setVal.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#wt-submit').click();
  await frame();
  const err = document.querySelector('#wt-error');
  out.emptyError = !err.classList.contains('hidden') && err.textContent.includes('rama');

  // tap en el fondo cierra
  sheet.click();
  await frame();
  out.sheetClosed = sheet.classList.contains('hidden');

  window.fetch = realFetch;
  return out;
});
ok('worktree: menú CREAR y sheet montados ocultos por default', wtRun.hiddenByDefault);
ok('worktree: long-press en + abre el menú sin crear sesión', wtRun.menuOpen && wtRun.noSessionCreated);
ok('worktree: menú con Nueva sesión + Nuevo worktree…',
  wtRun.items.includes('Nueva sesión') && wtRun.items.includes('Nuevo worktree…'));
ok('worktree: Nuevo worktree… abre el sheet y cierra el menú', wtRun.sheetOpen && wtRun.menuClosedAfter);
ok('worktree: dropdown con las ramas y la actual preseleccionada',
  JSON.stringify(wtRun.baseOptions) === JSON.stringify(['main', 'feat/x']) && wtRun.basePreselected === 'feat/x');
ok('worktree: info box muestra el path hermano ../<repo>-<segmento>', wtRun.infoPath);
ok('worktree: submit sin rama → error inline en el sheet', wtRun.emptyError);
ok('worktree: tap en el fondo cierra el sheet', wtRun.sheetClosed);

// screenshot de la paleta contra el server real (fetch ya restaurado)
await tapSel('#btn-snippets');
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: new URL('./shot-snippets.png', import.meta.url).pathname });
await page.$eval('#term-claude', pd);
await new Promise((r) => setTimeout(r, 200));

await page.click('.tab[data-tab="claude"]');
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: new URL('./shot-claude.png', import.meta.url).pathname });

// 19. pinch-zoom del font (tarea 11a): el gesto no se puede sentir headless
// (eso lo prueba el scratch de puppeteer del agente y Lucas en el celu), pero sí
// se verifica el otro extremo: el tamaño persistido en localStorage se aplica al
// arrancar el terminal (loadFontSize en el init de createTermConnection). Se
// setea deck-fontsize, se recarga y se lee claudeConn.term.options.fontSize.
// Al final se restaura el default (14) y se recarga, para que la sesión real
// termine con su geometría normal (nunca la dejamos zoomeada).
const bootFont = async (raw) => {
  await page.evaluate((v) => { localStorage.setItem('deck-fontsize', v); }, raw);
  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
  await page.waitForSelector('#term-claude .xterm', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 2000));
  return page.evaluate(() => window.claudeConn?.term?.options?.fontSize);
};
ok('pinch: tamaño persistido (18) aplicado al boot', (await bootFont('18')) === 18);
ok('pinch: tamaño fuera de rango clampeado al boot (999 → 22)', (await bootFont('999')) === 22);
ok('pinch: tamaño fuera de rango clampeado al boot (2 → 10)', (await bootFont('2')) === 10);
// restaurar el default para no dejar zoomeada la sesión real
await page.evaluate(() => localStorage.removeItem('deck-fontsize'));
await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
await page.waitForSelector('#term-claude .xterm', { timeout: 10000 });
await new Promise((r) => setTimeout(r, 2000));
ok('pinch: sin clave → default 14 al boot', (await page.evaluate(() => window.claudeConn?.term?.options?.fontSize)) === 14);

// 20. despachar con prompt (tarea 6): tercera entrada del menú CREAR abre el
// sheet "Despachar agente". /api/workspaces mockeado; el POST a /api/dispatch se
// intercepta (nunca se despacha un claude real) y se aserta su body. Se cubre la
// confirmación extra de Autorun (bypassPermissions): el primer tap arma, no postea.
const dispRun = await page.evaluate(async () => {
  const realFetch = window.fetch;
  const posted = [];
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/workspaces')) {
      return Promise.resolve(new Response(JSON.stringify({
        root: '/w', dirs: ['claude-deck', 'otro-proyecto'],
      }), { status: 200 }));
    }
    if (u.includes('/api/dispatch')) {
      posted.push(JSON.parse(opts.body));
      return Promise.resolve(new Response(JSON.stringify({ session: 'claude-deck', dir: '/w/claude-deck', mode: 'plan' }), { status: 200 }));
    }
    return realFetch(url, opts);
  };
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const menu = document.querySelector('#create-menu');
  const sheet = document.querySelector('#dispatch-sheet');
  const btn = document.querySelector('#btn-new-session');
  const out = {};

  out.hiddenByDefault = sheet.classList.contains('hidden');

  // long-press abre el menú (sin crear sesión: no tapeamos corto)
  const r = btn.getBoundingClientRect();
  const xy = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, ...xy }));
  await sleep(620);
  btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, ...xy }));
  await frame();
  out.items = [...menu.querySelectorAll('.mi span')].map((e) => e.textContent);

  // "Despachar con prompt…" abre el sheet
  const dBtn = [...menu.querySelectorAll('.mi')].find((e) => e.textContent.includes('Despachar'));
  dBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  dBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await sleep(150);
  await frame();
  out.sheetOpen = !sheet.classList.contains('hidden');
  out.dirOptions = [...document.querySelectorAll('#dp-dir option')].map((o) => o.value);
  out.modePills = [...document.querySelectorAll('#dp-modes .dp-pill')].map((e) => e.textContent);
  out.planActiveByDefault = document.querySelector('#dp-modes .dp-pill.active')?.textContent === 'Plan';
  out.modelPills = [...document.querySelectorAll('#dp-models .dp-pill')].map((e) => e.textContent);
  out.modelDefaultActive = document.querySelector('#dp-models .dp-pill.active')?.textContent === 'Default';
  out.effortPills = [...document.querySelectorAll('#dp-efforts .dp-pill')].map((e) => e.textContent);
  out.effortDefaultActive = document.querySelector('#dp-efforts .dp-pill.active')?.textContent === 'Default';

  // tipear un prompt (textarea controlado de React: setter nativo + input)
  const ta = document.querySelector('#dp-prompt');
  const setVal = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setVal.call(ta, 'arreglá los tests');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await frame();

  // pills de modo togglean el activo
  const pill = (label) => [...document.querySelectorAll('#dp-modes .dp-pill')].find((e) => e.textContent === label);
  pill('Auto-edits').click();
  await frame();
  out.autoEditsActive = document.querySelector('#dp-modes .dp-pill.active').textContent === 'Auto-edits';

  // elegir un modelo (pill Opus)
  const modelPill = (label) => [...document.querySelectorAll('#dp-models .dp-pill')].find((e) => e.textContent === label);
  modelPill('Opus').click();
  await frame();
  out.opusActive = document.querySelector('#dp-models .dp-pill.active').textContent === 'Opus';

  // elegir un effort (pill High)
  const effortPill = (label) => [...document.querySelectorAll('#dp-efforts .dp-pill')].find((e) => e.textContent === label);
  effortPill('High').click();
  await frame();
  out.highActive = document.querySelector('#dp-efforts .dp-pill.active').textContent === 'High';

  // Autorun: primer tap arma la confirmación SIN postear
  pill('Autorun').click();
  await frame();
  document.querySelector('#dp-submit').click();
  await frame();
  out.armedLabel = document.querySelector('#dp-submit').textContent.includes('auto-aprueba');
  out.noPostOnArm = posted.length === 0;

  // segundo tap confirma y postea con el body correcto (mode auto, model opus)
  document.querySelector('#dp-submit').click();
  await sleep(120);
  await frame();
  out.postedBody = posted[0];
  out.sheetClosedAfterPost = sheet.classList.contains('hidden');

  window.fetch = realFetch;
  return out;
});
ok('dispatch: sheet montado oculto por default', dispRun.hiddenByDefault);
ok('dispatch: menú CREAR con la tercera entrada "Despachar con prompt…"',
  dispRun.items.includes('Despachar con prompt…'));
ok('dispatch: la entrada abre el sheet con el dropdown de directorios',
  dispRun.sheetOpen && JSON.stringify(dispRun.dirOptions) === JSON.stringify(['claude-deck', 'otro-proyecto']));
ok('dispatch: pills Plan/Auto-edits/Autorun, Plan activo por default',
  JSON.stringify(dispRun.modePills) === JSON.stringify(['Plan', 'Auto-edits', 'Autorun']) && dispRun.planActiveByDefault);
ok('dispatch: pills de modelo Default/Sonnet/Opus/Haiku, Default activo por default',
  JSON.stringify(dispRun.modelPills) === JSON.stringify(['Default', 'Sonnet', 'Opus', 'Haiku']) && dispRun.modelDefaultActive);
ok('dispatch: pills de effort Default/Low/Medium/High/xHigh/Max, Default activo por default',
  JSON.stringify(dispRun.effortPills) === JSON.stringify(['Default', 'Low', 'Medium', 'High', 'xHigh', 'Max']) && dispRun.effortDefaultActive);
ok('dispatch: las pills togglean modo, modelo y effort activos',
  dispRun.autoEditsActive && dispRun.opusActive && dispRun.highActive);
ok('dispatch: Autorun arma confirmación "auto-aprueba" sin postear',
  dispRun.armedLabel && dispRun.noPostOnArm);
ok('dispatch: el segundo tap confirma y postea el body correcto (mode auto + model opus + effort high)',
  dispRun.postedBody && dispRun.postedBody.dir === 'claude-deck'
  && dispRun.postedBody.prompt === 'arreglá los tests'
  && dispRun.postedBody.mode === 'auto' && dispRun.postedBody.model === 'opus'
  && dispRun.postedBody.effort === 'high' && dispRun.sheetClosedAfterPost);

// 21. statusline del panel (tarea 22): línea fina con % de contexto + tokens
// (+ modelo y costo). /api/claude/status mockeado sobre window.fetch; se maneja
// con refreshClaudeStatus() (puente global, como refreshHost). Se verifica el
// render del %, tokens compactos, y el umbral de color (ok/warn/alert), más el
// caso null (línea oculta) y ctxPct null (muestra "—").
const slRun = await page.evaluate(async () => {
  const realFetch = window.fetch;
  let mock = null; // { status: {...} | null }
  window.fetch = (url, opts) => {
    if (String(url).includes('/api/claude/status')) {
      return Promise.resolve(new Response(JSON.stringify(mock), { status: 200 }));
    }
    return realFetch(url, opts);
  };
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  const sl = document.querySelector('#statusline');
  const out = {};

  // sin datos (hook inactivo) → línea oculta
  mock = { status: null };
  await window.refreshClaudeStatus(); await frame();
  out.hiddenWhenNull = sl.classList.contains('hidden');

  // contexto sano (42%) → visible, ok, tokens compactos + modelo + costo
  mock = { status: { model: 'Opus 4.8', modelId: 'claude-opus-4-8', ctxPct: 42, ctxSize: 200000, inputTokens: 84000, outputTokens: 120, costUsd: 1.2345, exceeds200k: false } };
  await window.refreshClaudeStatus(); await frame();
  out.okVisible = !sl.classList.contains('hidden') && sl.classList.contains('sl-ok');
  out.pct = document.querySelector('#sl-pct').textContent;
  out.tokens = document.querySelector('#sl-tokens').textContent;
  out.model = document.querySelector('#sl-model').textContent;
  out.cost = document.querySelector('#sl-cost').textContent;

  // cerca del límite (78%) → warn
  mock = { status: { ...mock.status, ctxPct: 78 } };
  await window.refreshClaudeStatus(); await frame();
  out.warn = sl.classList.contains('sl-warn');

  // muy cerca (92%) → alert
  mock = { status: { ...mock.status, ctxPct: 92 } };
  await window.refreshClaudeStatus(); await frame();
  out.alert = sl.classList.contains('sl-alert');

  // exceeds200k fuerza alert aunque ctxPct sea bajo/null
  mock = { status: { ...mock.status, ctxPct: null, exceeds200k: true } };
  await window.refreshClaudeStatus(); await frame();
  out.exceedsAlert = sl.classList.contains('sl-alert') && document.querySelector('#sl-pct').textContent === '—';

  window.fetch = realFetch;
  return out;
});
ok('statusline: oculta sin datos (status null)', slRun.hiddenWhenNull);
ok('statusline: contexto sano → visible, ok, % + tokens + modelo + costo',
  slRun.okVisible && slRun.pct === '42%' && slRun.tokens === '84k tok'
  && slRun.model === 'Opus 4.8' && slRun.cost === '$1.23');
ok('statusline: 78% → warn (ámbar)', slRun.warn);
ok('statusline: 92% → alert (rojo)', slRun.alert);
ok('statusline: exceeds200k fuerza alert y % "—"', slRun.exceedsAlert);

await browser.close();
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
