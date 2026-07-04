// Prueba E2E del WS de claude-deck
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const TOKEN = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .match(/AUTH_TOKEN=(.+)/)[1].trim();
const PORT = process.env.DECK_PORT || '7433';
const BASE = `ws://127.0.0.1:${PORT}/ws/term`;
const HTTP = `http://127.0.0.1:${PORT}`;
const results = [];
const ok = (name, cond) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}`);

function connect(query, withAuth = true) {
  return new WebSocket(`${BASE}?${query}`, withAuth ? { headers: { 'x-deck-token': TOKEN } } : {});
}

function session(ws, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let meta = null;
    let out = '';
    const timer = setTimeout(() => resolve({ meta, out, ws }), timeoutMs);
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === 'meta') meta = m;
      if (m.t === 'out') out += m.d;
    });
    ws.on('error', () => { clearTimeout(timer); resolve({ meta, out, ws, error: true }); });
    ws.on('close', () => {});
    ws.once('open', () => {
      ws.send(JSON.stringify({ t: 'resize', cols: 100, rows: 30 }));
    });
  });
}

// 1. Sin auth → rechazado
await new Promise((resolve) => {
  const ws = connect('target=claude', false);
  ws.on('error', (e) => { ok('WS sin token rechazado (401)', String(e).includes('401')); resolve(); });
  ws.on('open', () => { ok('WS sin token rechazado (401)', false); ws.close(); resolve(); });
});

// 2. target=claude crea la sesión "deck" y fluye output
const c1 = connect('target=claude');
const r1 = await session(c1);
ok('meta created=true en primera conexión', r1.meta?.created === true && r1.meta?.session === 'deck');
c1.send(JSON.stringify({ t: 'in', d: 'echo hola-deck\r' }));
await new Promise((r) => setTimeout(r, 1200));
let buf1 = '';
c1.on('message', () => {});
// leer lo acumulado via un segundo listener no sirve; capturamos con pane
const pane = execFileSync('tmux', ['capture-pane', '-p', '-t', 'deck']).toString();
ok('input llega a la sesión tmux (echo visible en pane)', pane.includes('hola-deck'));

// 3. cerrar WS NO mata la sesión tmux
c1.close();
await new Promise((r) => setTimeout(r, 500));
let alive = true;
try { execFileSync('tmux', ['has-session', '-t', '=deck']); } catch { alive = false; }
ok('cerrar el WS no mata la sesión tmux', alive);

// 4. re-conectar: attach a la MISMA sesión (created=false, scrollback visible)
const c2 = connect('target=claude');
const r2 = await session(c2);
ok('reconexión attach a la misma sesión (created=false)', r2.meta?.created === false);
ok('la sesión conserva el contenido anterior', r2.out.includes('hola-deck'));

// 5. multi-sesión: session=deck-2 (create=1: sin él, un attach a una sesión
// inexistente ya no la crea — ver 5c)
const c3 = connect('target=claude&session=deck-2&create=1');
const r3 = await session(c3);
ok('sesión deck-2 creada vía ?session=&create=1', r3.meta?.created === true && r3.meta?.session === 'deck-2');

// 5b. {t:'refresh'} fuerza un repaint completo de tmux (fix tarea 11: el
// frontend lo manda al volver de background; un pane idle no emite nada,
// así que el 'out' que llega solo puede ser el redraw del refresh-client)
const gotRepaint = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 3000);
  c3.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'out') { clearTimeout(timer); resolve(true); }
  });
  c3.send(JSON.stringify({ t: 'refresh' }));
});
ok('refresh → tmux repinta (llega out en pane idle)', gotRepaint);

// 5c. attach sin create=1 a una sesión inexistente NO la crea (guard
// anti-resurrección: el retry de un cliente desactualizado no debe revivir
// una sesión recién matada) — el server contesta meta gone y cierra
const cg = connect('target=claude&session=deck-nope');
const rg = await session(cg);
ok('attach sin create a sesión inexistente → meta gone', rg.meta?.gone === true);
const afterGone = await (await fetch(`${HTTP}/api/tmux/sessions`, { headers: { 'x-deck-token': TOKEN } })).json();
ok('la sesión inexistente NO fue creada', !afterGone.some((s) => s.name === 'deck-nope'));

// 6. sesión inválida rechazada
await new Promise((resolve) => {
  const bad = connect('target=claude&session=..%2Fmal');
  bad.on('close', (code) => { ok('nombre de sesión inválido → close 1008', code === 1008); resolve(); });
  bad.on('error', () => { ok('nombre de sesión inválido → close 1008', false); resolve(); });
});

// 8. /api/tmux/sessions: lista deck y deck-2, excluye *-shell (legacy)
const res = await fetch(`${HTTP}/api/tmux/sessions`, { headers: { 'x-deck-token': TOKEN } });
const sessions = await res.json();
const names = sessions.map((s) => s.name);
ok('sessions lista deck y deck-2', names.includes('deck') && names.includes('deck-2'));
ok('sessions excluye *-shell', !names.some((n) => n.endsWith('-shell')));
ok('sessions trae dir del pane', sessions.every((s) => s.dir.startsWith('/')));

// 9. git endpoints con ?session=deck-2 (resuelve el dir del pane)
const sum = await fetch(`${HTTP}/api/git/summary?session=deck-2`, { headers: { 'x-deck-token': TOKEN } });
const sumJson = await sum.json();
ok('git summary con ?session=deck-2', sum.status === 200 && typeof sumJson.branch === 'string');

// 9b. POST /api/git/stage: stagear/desstagear un archivo temporal del repo de deck-2
// (las sesiones nacen con -c DEFAULT_DIR, así que el dir del pane es el toplevel del repo)
const stageDir = sessions.find((s) => s.name === 'deck-2')?.dir;
const tmpRel = `.tmp-ws-test-stage-${Date.now()}.txt`;
fs.writeFileSync(`${stageDir}/${tmpRel}`, 'stage-test\n');
const postStage = (path, action) => fetch(`${HTTP}/api/git/stage?session=deck-2`, {
  method: 'POST',
  headers: { 'x-deck-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ path, action }),
});
try {
  const st1 = await postStage(tmpRel, 'stage');
  let sumSt = await (await fetch(`${HTTP}/api/git/summary?session=deck-2`, { headers: { 'x-deck-token': TOKEN } })).json();
  let entry = sumSt.files.find((f) => f.path === tmpRel);
  ok('stage → el archivo queda staged', st1.status === 200 && entry?.staged === true);

  const st2 = await postStage(tmpRel, 'unstage');
  sumSt = await (await fetch(`${HTTP}/api/git/summary?session=deck-2`, { headers: { 'x-deck-token': TOKEN } })).json();
  entry = sumSt.files.find((f) => f.path === tmpRel);
  ok('unstage → vuelve a untracked', st2.status === 200 && entry?.staged === false && entry?.untracked === true);

  const stBad = await postStage('../fuera-del-repo', 'stage');
  ok('stage path fuera del repo → 400', stBad.status === 400);
  const stBadAction = await postStage(tmpRel, 'commit');
  ok('stage action inválida → 400', stBadAction.status === 400);
} finally {
  // nunca dejar el archivo temporal ni su entrada en el index del repo real
  try { execFileSync('git', ['-C', stageDir, 'restore', '--staged', '--', tmpRel], { stdio: 'ignore' }); } catch {}
  fs.unlinkSync(`${stageDir}/${tmpRel}`);
}

// 9c. GET /api/fs/list y /api/fs/file: file browser read-only de la sesión
const fsRel = `.tmp-ws-test-fs-${Date.now()}`;
fs.mkdirSync(`${stageDir}/${fsRel}/sub`, { recursive: true });
fs.writeFileSync(`${stageDir}/${fsRel}/sub/hola.txt`, 'contenido-fs-test\n');
const getJson = async (url) => {
  const res = await fetch(url, { headers: { 'x-deck-token': TOKEN } });
  return { status: res.status, json: await res.json().catch(() => null) };
};
try {
  const root = await getJson(`${HTTP}/api/fs/list?session=deck-2`);
  ok('fs/list raíz → 200 con entries', root.status === 200 && Array.isArray(root.json?.entries)
    && root.json.entries.some((e) => e.name === fsRel && e.type === 'dir'));
  ok('fs/list excluye .git y ordena carpetas primero',
    !root.json.entries.some((e) => e.name === '.git')
    && root.json.entries.every((e, i, a) => i === 0 || !(a[i - 1].type === 'file' && e.type === 'dir')));
  const sub = await getJson(`${HTTP}/api/fs/list?session=deck-2&path=${encodeURIComponent(`${fsRel}/sub`)}`);
  ok('fs/list de subcarpeta lista sus archivos', sub.status === 200
    && sub.json?.entries.some((e) => e.name === 'hola.txt' && e.type === 'file'));
  const rf = await getJson(`${HTTP}/api/fs/file?session=deck-2&path=${encodeURIComponent(`${fsRel}/sub/hola.txt`)}`);
  ok('fs/file devuelve el contenido', rf.status === 200
    && rf.json?.content === 'contenido-fs-test\n' && rf.json?.binary === false);
  const trav = await getJson(`${HTTP}/api/fs/list?session=deck-2&path=..`);
  ok('fs/list path traversal → 400', trav.status === 400);
  const nf404 = await getJson(`${HTTP}/api/fs/file?session=deck-2&path=no-existe-x.txt`);
  ok('fs/file inexistente → 404', nf404.status === 404);
} finally {
  fs.rmSync(`${stageDir}/${fsRel}`, { recursive: true, force: true });
}

// 10. sesión inexistente → 404
const nf = await fetch(`${HTTP}/api/git/summary?session=no-existe`, { headers: { 'x-deck-token': TOKEN } });
ok('?session= inexistente → 404', nf.status === 404);

// 11. las sesiones se crean con mouse on (requisito del scroll táctil)
// ojo: show-options en tmux 3.7b no acepta el prefijo de match exacto `=`
const mouseOpt = execFileSync('tmux', ['show-options', '-t', 'deck', 'mouse']).toString();
ok('sesión creada con mouse on', mouseOpt.includes('mouse on'));

// 12. POST /api/paste-image (ojo: el caso feliz PISA el clipboard de la Mac)
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const up = await fetch(`${HTTP}/api/paste-image?session=deck`, {
  method: 'POST', headers: { 'x-deck-token': TOKEN }, body: PNG_1x1,
});
const upJson = await up.json();
ok('paste-image PNG → 200 modo clipboard', up.status === 200 && upJson.mode === 'clipboard');
const up415 = await fetch(`${HTTP}/api/paste-image?session=deck`, {
  method: 'POST', headers: { 'x-deck-token': TOKEN }, body: 'esto no es una imagen',
});
ok('paste-image no-imagen → 415', up415.status === 415);
const up404 = await fetch(`${HTTP}/api/paste-image?session=no-existe`, {
  method: 'POST', headers: { 'x-deck-token': TOKEN }, body: PNG_1x1,
});
ok('paste-image sesión inexistente → 404', up404.status === 404);

// 12b. PATCH /api/tmux/sessions/:name renombra la sesión y su -shell
// (par propio deck-rn/deck-rn-shell para no tocar deck ni deck-2)
execFileSync('tmux', ['new-session', '-d', '-s', 'deck-rn', '-c', '/tmp']);
execFileSync('tmux', ['new-session', '-d', '-s', 'deck-rn-shell', '-c', '/tmp']);
const patchName = (name, body) => fetch(`${HTTP}/api/tmux/sessions/${name}`, {
  method: 'PATCH',
  headers: { 'x-deck-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
try {
  const rn = await patchName('deck-rn', { newName: 'deck-rn2' });
  const rnJson = await rn.json();
  let oldGone = false;
  try { execFileSync('tmux', ['has-session', '-t', '=deck-rn'], { stdio: 'ignore' }); } catch { oldGone = true; }
  let bothRenamed = true;
  try {
    execFileSync('tmux', ['has-session', '-t', '=deck-rn2'], { stdio: 'ignore' });
    execFileSync('tmux', ['has-session', '-t', '=deck-rn2-shell'], { stdio: 'ignore' });
  } catch { bothRenamed = false; }
  ok('rename → 200 y renombra sesión + shell', rn.status === 200
    && rnJson.renamed?.length === 2 && oldGone && bothRenamed);

  const rnDup = await patchName('deck-rn2', { newName: 'deck' });
  ok('rename a nombre existente → 409', rnDup.status === 409);
  const rnBad = await patchName('deck-rn2', { newName: 'mal nombre' });
  ok('rename a nombre inválido → 400', rnBad.status === 400);
  const rnShell = await patchName('deck-rn2', { newName: 'algo-shell' });
  ok("rename a *-shell → 400 (sufijo reservado)", rnShell.status === 400);
  const rn404 = await patchName('no-existe-x', { newName: 'da-igual' });
  ok('rename sesión inexistente → 404', rn404.status === 404);
} finally {
  for (const s of ['deck-rn', 'deck-rn-shell', 'deck-rn2', 'deck-rn2-shell']) {
    try { execFileSync('tmux', ['kill-session', '-t', `=${s}`], { stdio: 'ignore' }); } catch {}
  }
}

// 13. DELETE /api/tmux/sessions/:name mata la sesión
const del = await fetch(`${HTTP}/api/tmux/sessions/deck-2`, { method: 'DELETE', headers: { 'x-deck-token': TOKEN } });
ok('DELETE sesión existente → 200', del.status === 200);
await new Promise((r) => setTimeout(r, 300));
let dead = false;
try { execFileSync('tmux', ['has-session', '-t', '=deck-2'], { stdio: 'ignore' }); } catch { dead = true; }
ok('la sesión tmux deck-2 quedó muerta', dead);

// 14. DELETE inexistente → 404, nombre inválido → 400
const del404 = await fetch(`${HTTP}/api/tmux/sessions/no-existe-x`, { method: 'DELETE', headers: { 'x-deck-token': TOKEN } });
ok('DELETE sesión inexistente → 404', del404.status === 404);
const del400 = await fetch(`${HTTP}/api/tmux/sessions/mal%21nombre`, { method: 'DELETE', headers: { 'x-deck-token': TOKEN } });
ok('DELETE nombre inválido → 400', del400.status === 400);

c2.close();
await new Promise((r) => setTimeout(r, 300));
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
