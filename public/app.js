/* claude-deck — frontend vanilla */
'use strict';

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------
const state = {
  defaultSession: 'deck',
  session: null,        // sesión tmux seleccionada (pestaña Claude + Cambios)
  activeTab: 'claude',
  inDiff: false,
};

const $ = (sel) => document.querySelector(sel);

const XTERM_THEME = {
  background: '#0b0d10',
  foreground: '#c8ccd4',
  cursor: '#e8b04b',
  cursorAccent: '#0b0d10',
  selectionBackground: '#2a3242',
  black: '#1c2026', brightBlack: '#555c66',
  red: '#d47766', brightRed: '#e49186',
  green: '#8a9e6b', brightGreen: '#a5b98a',
  yellow: '#e8b04b', brightYellow: '#f0c47a',
  blue: '#7a9ec2', brightBlue: '#9ab8d8',
  magenta: '#b294bb', brightMagenta: '#c8aed0',
  cyan: '#7db8b0', brightCyan: '#9ed0c9',
  white: '#c8ccd4', brightWhite: '#e8eaee',
};

// ---------------------------------------------------------------------------
// Terminal + WebSocket con reconexión (backoff)
// ---------------------------------------------------------------------------
function createTermConnection(containerId, connId, target, getSession) {
  const term = new Terminal({
    fontSize: 14,
    fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
    theme: XTERM_THEME,
    cursorBlink: true,
    scrollback: 3000,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById(containerId));

  if (target === 'claude') {
    // shift+enter desde teclado físico (BT): xterm lo mandaría como \r (submit).
    // Traducirlo al newline suave de Claude Code (ESC+CR, ver KEYS.nl).
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.key === 'Enter' && ev.shiftKey) {
        if (ev.type === 'keydown' && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'in', d: '\x1b\r' }));
        }
        return false;
      }
      return true;
    });
  }

  let ws = null;
  let gen = 0;          // generación de conexión: invalida handlers de sockets viejos
  let retries = 0;
  let retryTimer = null;
  let wantedSession = getSession();
  let lastCols = 0;
  let lastRows = 0;

  const connEl = document.getElementById(connId);
  const setConn = (on) => connEl.classList.toggle('on', on);

  function sendResize(force) {
    // solo si cambió: cada resize hace que tmux redibuje todo (flickering)
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!force && term.cols === lastCols && term.rows === lastRows) return;
    lastCols = term.cols;
    lastRows = term.rows;
    ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
  }

  function doFit(force) {
    try {
      fit.fit();
      sendResize(force === true);
    } catch (_) { /* contenedor oculto */ }
  }

  function connect() {
    clearTimeout(retryTimer);
    retryTimer = null;
    const myGen = ++gen;
    if (ws) {
      // nunca dos attaches vivos por terminal: duplican el output (texto
      // "doblado") y pelean el tamaño del pane (flickering)
      const old = ws;
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch (_) {}
    }
    wantedSession = getSession();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/term?target=${target}&session=${encodeURIComponent(wantedSession)}`;
    const sock = new WebSocket(url);
    ws = sock;

    sock.onopen = () => {
      if (myGen !== gen) return;
      retries = 0;
      setConn(true);
      lastCols = 0;
      lastRows = 0;
      requestAnimationFrame(() => doFit(true));
    };

    sock.onmessage = (ev) => {
      if (myGen !== gen) return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'out') {
        term.write(m.d);
      } else if (m.t === 'meta' && m.created && target === 'claude') showHint();
    };

    sock.onclose = () => {
      if (myGen !== gen) return;
      setConn(false);
      const delay = Math.min(1000 * 2 ** retries, 15000);
      retries++;
      retryTimer = setTimeout(connect, delay);
    };
    sock.onerror = () => { try { sock.close(); } catch (_) {} };
  }

  term.onData((d) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d }));
  });

  connect();

  return {
    term,
    fit: doFit,
    sendKeys(d) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d }));
    },
    reconnect() {
      // cortar el attach actual y conectar a la sesión seleccionada
      term.reset();
      retries = 0;
      connect();
    },
    resume() {
      // al volver del background: si el WS murió, reconectar ya (sin backoff)
      if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        retries = 0;
        connect();
      }
    },
    currentSession: () => wantedSession,
  };
}

// ---------------------------------------------------------------------------
// Scroll táctil → eventos de rueda (SGR) hacia tmux
// tmux corre con `mouse on` (lo setea el server al crear/attachear), así que
// el terminal exterior siempre está en modo mouse-report: estas secuencias
// nunca llegan como texto al shell. Rueda arriba = tmux entra en copy-mode y
// muestra el historial (el scrollback de xterm está vacío bajo tmux).
function wireTouchScroll(containerId, getConn) {
  const container = document.getElementById(containerId);
  let lastY = null;
  let acc = 0;

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      lastY = e.touches[0].clientY;
      acc = 0;
    } else {
      lastY = null;
    }
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    const conn = getConn();
    if (lastY === null || !conn || e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    acc += t.clientY - lastY;
    lastY = t.clientY;

    const rect = container.getBoundingClientRect();
    const rows = conn.term.rows || 24;
    const cols = conn.term.cols || 80;
    const rowH = rect.height / rows;
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const col = clamp(Math.ceil((t.clientX - rect.left) / (rect.width / cols)), 1, cols);
    const row = clamp(Math.ceil((t.clientY - rect.top) / rowH), 1, rows);

    while (Math.abs(acc) >= rowH) {
      const up = acc > 0; // dedo hacia abajo = ver historial (rueda arriba)
      conn.sendKeys(`\x1b[<${up ? 64 : 65};${col};${row}M`);
      acc += up ? -rowH : rowH;
    }
  }, { passive: false });

  container.addEventListener('touchend', () => { lastY = null; });
  container.addEventListener('touchcancel', () => { lastY = null; });
}

let claudeConn = null;
let shellConn = null;

// ---------------------------------------------------------------------------
// Hint de sesión nueva
// ---------------------------------------------------------------------------
let hintTimer = null;
function showHint() {
  const el = $('#hint-claude');
  el.classList.remove('hidden');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(hideHint, 15000);
  requestAnimationFrame(() => claudeConn && claudeConn.fit());
}
function hideHint() {
  $('#hint-claude').classList.add('hidden');
  requestAnimationFrame(() => claudeConn && claudeConn.fit());
}

// ---------------------------------------------------------------------------
// Barra de teclas rápidas
// ---------------------------------------------------------------------------
const KEYS = {
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  tab: '\t',
  ctrlc: '\x03',
  enter: '\r',
  slash: '/',
  // salto de línea SIN enviar el prompt: Claude Code trata ESC+CR (alt+enter)
  // como newline suave — verificado contra claude real dentro de tmux
  nl: '\x1b\r',
};

function wireQuickKeys() {
  document.querySelectorAll('.quickkeys').forEach((bar) => {
    const which = bar.dataset.term;
    bar.querySelectorAll('button[data-k]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault(); // no robar el foco (que no se cierre el teclado)
        const conn = which === 'shell' ? shellConn : claudeConn;
        if (conn) conn.sendKeys(KEYS[btn.dataset.k]);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Switchers de modo (shift+tab) y modelo/esfuerzo (/model, /effort)
// Modo: cada tap manda UN shift+tab, igual que en la terminal. La pill tiene
// label fijo ("Mode switcher"): la app no puede leer el estado real de Claude
// desde el pty, así que no intenta adivinarlo — el usuario ve el modo actual
// en el propio terminal.
// ---------------------------------------------------------------------------
const MODELS = [
  { id: 'fable', label: 'Fable 5' },
  { id: 'opus', label: 'Opus 4.8' },
  { id: 'sonnet', label: 'Sonnet 5' },
  { id: 'haiku', label: 'Haiku 4.5' },
];
const EFFORTS = [
  { id: 'low', label: 'Bajo' },
  { id: 'medium', label: 'Medio' },
  { id: 'high', label: 'Alto' },
  { id: 'max', label: 'Máx' },
];

function loadSwitch() {
  try {
    return JSON.parse(localStorage.getItem(`deck-switch:${state.session}`)) || {};
  } catch (_) { return {}; }
}
function saveSwitch(sw) {
  try { localStorage.setItem(`deck-switch:${state.session}`, JSON.stringify(sw)); } catch (_) {}
}

function renderSwitchPills() {
  const sw = loadSwitch();
  const model = MODELS.find((m) => m.id === sw.model);
  $('#model-label').textContent = model ? model.label : (sw.model || 'Modelo');
  const effort = EFFORTS.find((e) => e.id === sw.effort);
  $('#effort-label').textContent = effort ? effort.label : '';
}

function cycleMode() {
  closeSwitchMenu();
  if (!claudeConn) return;
  claudeConn.sendKeys('\x1b[Z');
}

// manda un slash command al prompt de Claude; el Enter va aparte con una
// pausa corta para que el autocomplete de "/" no se coma el submit
function sendSlashCommand(cmd) {
  if (!claudeConn) return;
  claudeConn.sendKeys(cmd);
  setTimeout(() => claudeConn && claudeConn.sendKeys('\r'), 150);
}

function closeSwitchMenu() {
  $('#switch-menu').classList.add('hidden');
}

function menuItem(label, selected, onPick) {
  const btn = document.createElement('button');
  btn.className = 'mi' + (selected ? ' sel' : '');
  const span = document.createElement('span');
  span.textContent = label;
  btn.appendChild(span);
  if (selected) {
    const check = document.createElement('span');
    check.className = 'mi-check';
    check.textContent = '✓';
    btn.appendChild(check);
  }
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // no cerrar el teclado virtual
    onPick();
  });
  return btn;
}

function menuHeader(text) {
  const h = document.createElement('div');
  h.className = 'mh';
  h.textContent = text;
  return h;
}

function openModelMenu() {
  const menu = $('#switch-menu');
  if (!menu.classList.contains('hidden')) {
    closeSwitchMenu();
    return;
  }
  menu.innerHTML = '';
  const sw = loadSwitch();

  menu.appendChild(menuHeader('Modelo'));
  for (const m of MODELS) {
    menu.appendChild(menuItem(m.label, m.id === sw.model, () => {
      sendSlashCommand(`/model ${m.id}`);
      sw.model = m.id;
      saveSwitch(sw);
      renderSwitchPills();
      closeSwitchMenu();
    }));
  }
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'mdiv' }));
  menu.appendChild(menuHeader('Esfuerzo'));
  const row = document.createElement('div');
  row.className = 'mi-efforts';
  for (const e of EFFORTS) {
    const btn = document.createElement('button');
    btn.className = e.id === sw.effort ? 'sel' : '';
    btn.textContent = e.label;
    btn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      sendSlashCommand(`/effort ${e.id}`);
      sw.effort = e.id;
      saveSwitch(sw);
      renderSwitchPills();
      closeSwitchMenu();
    });
    row.appendChild(btn);
  }
  menu.appendChild(row);

  menu.classList.remove('hidden');
}

function wireSwitchers() {
  $('#btn-mode').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    cycleMode();
  });
  $('#btn-model').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    openModelMenu();
  });
  // tap afuera cierra el menú
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#switch-menu, #btn-mode, #btn-model')) closeSwitchMenu();
  });
  renderSwitchPills();
}

// ---------------------------------------------------------------------------
// Imágenes → Claude: se re-encodea a PNG en un canvas (los HEIC del iPhone no
// los entiende el server) y se sube; el server la pone en el clipboard de la
// Mac y manda Ctrl+V a la sesión (Claude Code la toma como [Image #N]).
// ---------------------------------------------------------------------------
const IMG_MAX_SIDE = 1600; // más resolución no aporta para visión y pesa

async function normalizeImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, IMG_MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (blob) return { blob, width: canvas.width, height: canvas.height };
  } catch (_) { /* formato no decodificable acá: que lo valide el server */ }
  return { blob: file, width: 0, height: 0 };
}

// --- chip de preview arriba de la fila de controles ---
let chipUrl = null;
let chipTimer = null;

function showImgChip(blob, title, meta) {
  clearTimeout(chipTimer);
  if (chipUrl) URL.revokeObjectURL(chipUrl);
  chipUrl = URL.createObjectURL(blob);
  $('#img-chip-thumb').src = chipUrl;
  $('#img-chip-title').textContent = title;
  $('#img-chip-meta').textContent = meta;
  $('#img-chip').classList.remove('hidden');
  requestAnimationFrame(() => claudeConn && claudeConn.fit());
}

function setImgChipMeta(meta) {
  $('#img-chip-meta').textContent = meta;
}

function hideImgChip() {
  clearTimeout(chipTimer);
  pendingImg = null;
  $('#img-chip').classList.add('hidden');
  $('#img-chip').classList.remove('pending');
  if (chipUrl) { URL.revokeObjectURL(chipUrl); chipUrl = null; }
  requestAnimationFrame(() => claudeConn && claudeConn.fit());
}

// Dos pasos: primero se muestra el preview en el chip y recién al tocarlo se
// sube — así el usuario confirma que la imagen es la correcta antes de que
// llegue al prompt. El ✕ descarta sin enviar.
let pendingImg = null; // { blob, dims } esperando confirmación de envío
let sendingImage = false;

async function attachImage(file, title) {
  if (!file || sendingImage) return;
  const { blob, width, height } = await normalizeImage(file);
  const dims = width ? `${width} × ${height} · PNG` : (file.type || 'imagen');
  pendingImg = { blob, dims };
  showImgChip(blob, title, dims);
  $('#img-chip').classList.add('pending');
}

async function sendPendingImage() {
  if (!pendingImg || sendingImage) return;
  sendingImage = true;
  const { blob, dims } = pendingImg;
  const chip = $('#img-chip');
  chip.classList.remove('pending');
  setImgChipMeta(`${dims} · enviando…`);
  try {
    const res = await api(`/api/paste-image?session=${encodeURIComponent(state.session)}`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: blob,
    });
    if (res.ok) {
      pendingImg = null;
      setImgChipMeta(`${dims} · enviada — mirá el prompt`);
      chipTimer = setTimeout(hideImgChip, 8000);
    } else {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch (_) {}
      setImgChipMeta(`${dims} · error: ${msg}`);
      chip.classList.add('pending'); // otro tap reintenta
    }
  } catch (e) {
    if (String(e.message) !== '401') {
      setImgChipMeta('error de red (¿server caído?)');
      chip.classList.add('pending');
    }
  } finally {
    sendingImage = false;
  }
}

// Clipboard API asíncrona: requiere HTTPS (tailscale ✓) y un tap real del
// usuario; iOS muestra el globito de permiso "Pegar" la primera vez.
async function pasteFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    alert('Este navegador no permite leer el portapapeles');
    return;
  }
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch (_) {
    return; // permiso denegado o portapapeles vacío: no molestar con alerts
  }
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) {
      attachImage(await item.getType(type), 'Imagen del portapapeles');
      return;
    }
  }
  alert('No hay ninguna imagen en el portapapeles');
}

function wireImagePaste() {
  const input = $('#img-input');
  $('#btn-img').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) attachImage(input.files[0], 'Imagen adjunta');
    input.value = ''; // permitir re-elegir el mismo archivo
  });
  $('#btn-paste').addEventListener('click', pasteFromClipboard);
  $('#img-chip').addEventListener('click', sendPendingImage);
  $('#img-chip-close').addEventListener('click', (e) => {
    e.stopPropagation(); // que el ✕ no cuente como tap de "enviar"
    hideImgChip();
  });
  // pegar con Cmd/Ctrl+V (teclado físico o desktop) con la pestaña Claude activa
  document.addEventListener('paste', (e) => {
    if (state.activeTab !== 'claude') return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const img = [...items].find((i) => i.type.startsWith('image/'));
    if (img) {
      e.preventDefault();
      attachImage(img.getAsFile(), 'Imagen del portapapeles');
    }
  });
}

// ---------------------------------------------------------------------------
// Fetch con manejo de 401
// ---------------------------------------------------------------------------
async function api(path, opts) {
  const res = await fetch(path, { cache: 'no-store', ...opts });
  if (res.status === 401) {
    showAuthError();
    throw new Error('401');
  }
  return res;
}

function showAuthError() {
  if ($('#auth-error')) return;
  const el = document.createElement('div');
  el.id = 'auth-error';
  el.innerHTML = 'Sesión no autorizada.<br>Abrí la app con <code>/?token=&lt;AUTH_TOKEN&gt;</code>';
  document.body.appendChild(el);
}

// ---------------------------------------------------------------------------
// Chips de sesiones tmux
// ---------------------------------------------------------------------------
let chipsKey = ''; // evita reconstruir el DOM (y parpadear) si nada cambió

async function refreshSessions() {
  let sessions = [];
  try {
    sessions = await (await api('/api/tmux/sessions')).json();
  } catch (_) { return; }

  const names = sessions.map((s) => s.name);
  if (!names.includes(state.session)) names.push(state.session);
  names.sort();

  const key = names.join('|') + '@' + state.session;
  if (key === chipsKey) return;
  chipsKey = key;

  const box = $('#session-chips');
  box.innerHTML = '';
  for (const name of names) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (name === state.session ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = name;
    chip.appendChild(label);
    if (name === state.session) {
      const x = document.createElement('span');
      x.className = 'chip-x';
      x.textContent = '✕';
      x.title = 'Matar sesión';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        killSession(name);
      });
      chip.appendChild(x);
    }
    chip.addEventListener('click', () => selectSession(name));
    box.appendChild(chip);
  }
}

function selectSession(name) {
  if (name === state.session) return;
  state.session = name;
  hideHint();
  closeSwitchMenu();
  renderSwitchPills(); // el estado de modo/modelo es por sesión
  claudeConn.reconnect();
  refreshSessions();
  refreshGit(); // la pestaña Cambios sigue a la sesión seleccionada
}

async function killSession(name) {
  if (!window.confirm(`¿Matar la sesión "${name}"? Se cierra lo que esté corriendo adentro.`)) return;
  try {
    await api(`/api/tmux/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
  } catch (_) { return; }

  if (state.session === name) {
    // caer a otra sesión viva; si no queda ninguna, la default (se recrea vacía)
    let names = [];
    try {
      names = (await (await api('/api/tmux/sessions')).json()).map((s) => s.name);
    } catch (_) {}
    state.session = names.includes(state.defaultSession)
      ? state.defaultSession
      : (names[0] || state.defaultSession);
    hideHint();
    claudeConn.reconnect();
    refreshGit();
  }
  refreshSessions();
}

function nextSessionName(existing) {
  const base = state.defaultSession;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

async function createSession() {
  let existing = [];
  try {
    existing = (await (await api('/api/tmux/sessions')).json()).map((s) => s.name);
  } catch (_) {}
  if (state.session && !existing.includes(state.session)) existing.push(state.session);
  selectSession(nextSessionName(existing));
}

// ---------------------------------------------------------------------------
// Pestaña Cambios
// ---------------------------------------------------------------------------
const BADGES = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', T: 'T', '??': '??' };

function sessionQuery() {
  return state.session ? `session=${encodeURIComponent(state.session)}` : '';
}

async function refreshGit() {
  if (state.inDiff) return; // no pisar la vista de diff
  let data;
  try {
    let res = await api(`/api/git/summary?${sessionQuery()}`);
    if (!res.ok) res = await api('/api/git/summary'); // fallback: sesión sin repo aún
    if (!res.ok) throw new Error('git summary failed');
    data = await res.json();
  } catch (e) {
    if (String(e.message) !== '401') $('#git-branch').textContent = '(sin datos git)';
    return;
  }

  $('#git-branch').textContent = `⎇ ${data.branch || '?'}`;
  const ab = [];
  if (data.ahead) ab.push(`↑${data.ahead}`);
  if (data.behind) ab.push(`↓${data.behind}`);
  if (data.upstream) ab.push(data.upstream);
  $('#git-ab').textContent = ab.join('  ');

  const list = $('#file-list');
  list.innerHTML = '';

  if (!data.files.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Árbol de trabajo limpio ✓';
    list.appendChild(empty);
    return;
  }

  const staged = data.files.filter((f) => f.staged);
  const unstaged = data.files.filter((f) => !f.staged);

  const renderGroup = (title, files) => {
    if (!files.length) return;
    const h = document.createElement('div');
    h.className = 'file-section';
    h.textContent = title;
    list.appendChild(h);
    for (const f of files) {
      // div y no button: adentro va el botón de stage/unstage (no se anidan buttons)
      const row = document.createElement('div');
      row.className = 'file-row';
      const badge = document.createElement('span');
      badge.className = 'badge' + (f.staged ? ' staged' : '');
      badge.textContent = BADGES[f.status] || f.status;
      const p = document.createElement('span');
      p.className = 'file-path';
      p.textContent = f.path;
      const act = document.createElement('button');
      act.className = 'file-act';
      act.textContent = f.staged ? '−' : '+';
      act.title = f.staged ? 'Sacar del stage' : 'Stagear';
      act.addEventListener('click', (e) => {
        e.stopPropagation();
        stageFile(f, act);
      });
      row.appendChild(badge);
      row.appendChild(p);
      row.appendChild(act);
      row.addEventListener('click', () => openDiff(f));
      list.appendChild(row);
    }
  };

  renderGroup('Staged', staged);
  renderGroup('Sin stagear', unstaged);
}

async function stageFile(f, btn) {
  btn.disabled = true;
  try {
    const res = await api(`/api/git/stage?${sessionQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: f.path, action: f.staged ? 'unstage' : 'stage' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
  } catch (e) {
    if (String(e.message) !== '401') window.alert(`No se pudo ${f.staged ? 'sacar del stage' : 'stagear'} ${f.path}: ${e.message}`);
  }
  refreshGit();
}

async function openDiff(file) {
  state.inDiff = true;
  $('#btn-diff-back').classList.remove('hidden');
  $('#file-list').classList.add('hidden');
  const view = $('#diff-view');
  view.classList.remove('hidden');
  view.innerHTML = '<div class="empty-state">Cargando diff…</div>';

  let text = '';
  try {
    const q = `path=${encodeURIComponent(file.path)}&staged=${file.staged ? 1 : 0}&${sessionQuery()}`;
    const res = await api(`/api/git/diff?${q}`);
    if (!res.ok) throw new Error(await res.text());
    text = await res.text();
  } catch (e) {
    view.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'empty-state';
    err.textContent = `No se pudo cargar el diff: ${e.message}`;
    view.appendChild(err);
    return;
  }

  if (!text.trim()) {
    view.innerHTML = '<div class="empty-state">Sin diferencias (¿archivo binario o vacío?)</div>';
    return;
  }

  view.innerHTML = Diff2Html.html(text, {
    drawFileList: false,
    matching: 'lines',
    outputFormat: 'line-by-line', // nunca side-by-side en móvil
  });
  view.scrollTop = 0;
}

function closeDiff() {
  state.inDiff = false;
  $('#btn-diff-back').classList.add('hidden');
  $('#diff-view').classList.add('hidden');
  $('#diff-view').innerHTML = '';
  $('#file-list').classList.remove('hidden');
  refreshGit();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function switchTab(name) {
  state.activeTab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'claude') requestAnimationFrame(() => claudeConn.fit());
  if (name === 'shell') requestAnimationFrame(() => shellConn.fit());
  if (name === 'changes') refreshGit();
}

// ---------------------------------------------------------------------------
// visualViewport: la app se "pega" al área visible (teclado / rotación)
// body queda fixed (la página nunca scrollea); #app se corre con --vvt para
// seguir el paneo del visual viewport cuando iOS muestra el teclado.
// ---------------------------------------------------------------------------
let fitTimer = null;
const KB_THRESHOLD = 100; // px: diferencia layout↔visual viewport que delata al teclado
function updateViewportGeometry() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  const top = vv ? vv.offsetTop : 0;
  document.documentElement.style.setProperty('--vvh', `${h}px`);
  document.documentElement.style.setProperty('--vvt', `${top}px`);
  // teclado abierto → ocultar la tabbar para darle esas filas a la terminal
  // (el fit con debounce de abajo corre después del toggle y toma el espacio)
  document.body.classList.toggle('kb-open', window.innerHeight - h > KB_THRESHOLD);
  // fit con debounce: el teclado dispara ráfagas de resize y cada re-fit
  // real provoca un redraw completo de tmux
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    if (state.activeTab === 'claude' && claudeConn) claudeConn.fit();
    if (state.activeTab === 'shell' && shellConn) shellConn.fit();
  }, 120);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  // config del server (nombre de sesión default)
  try {
    const cfg = await (await api('/api/config')).json();
    state.defaultSession = cfg.session || 'deck';
  } catch (_) {}
  state.session = state.defaultSession;

  claudeConn = createTermConnection('term-claude', 'conn-claude', 'claude', () => state.session);
  shellConn = createTermConnection('term-shell', 'conn-shell', 'shell', () => state.defaultSession);

  wireQuickKeys();
  wireSwitchers();
  wireTouchScroll('term-claude', () => claudeConn);
  wireTouchScroll('term-shell', () => shellConn);
  wireImagePaste();
  refreshSessions();

  // tabs
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  $('#btn-refresh').addEventListener('click', () => { state.inDiff ? null : refreshGit(); });
  $('#btn-diff-back').addEventListener('click', closeDiff);
  $('#btn-new-session').addEventListener('click', createSession);
  $('#hint-claude .hint-close').addEventListener('click', hideHint);

  // auto-refresh cada 8 s mientras la pestaña esté visible
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (state.activeTab === 'changes') refreshGit();
    if (state.activeTab === 'claude') refreshSessions();
  }, 8000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state.activeTab === 'changes') refreshGit();
      refreshSessions();
      // iOS suele matar los WS en background: reconectar sin esperar backoff
      claudeConn.resume();
      shellConn.resume();
    }
  });

  // viewport móvil (teclado / rotación)
  updateViewportGeometry();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateViewportGeometry);
    window.visualViewport.addEventListener('scroll', updateViewportGeometry);
  }
  window.addEventListener('resize', updateViewportGeometry);
  window.addEventListener('orientationchange', () => setTimeout(updateViewportGeometry, 300));

  // PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

init();
