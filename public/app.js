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
  expectCreate: null,   // nombre que ESTE cliente pidió crear (botón +): exime al guard anti-resurrección
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
function createTermConnection(containerId, connId, getSession) {
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

  let ws = null;
  let gen = 0;          // generación de conexión: invalida handlers de sockets viejos
  let retries = 0;
  let retryTimer = null;
  let refreshTimer = null; // watchdog del refresh post-resume (detecta WS zombie)
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
    clearTimeout(refreshTimer);
    refreshTimer = null;
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
    // create=1 solo cuando ESTE cliente pidió crear (botón +); la default la
    // permite el server. Un retry/resume nunca crea: si la sesión murió en
    // otro lado, el server contesta meta gone y caemos a una viva.
    const create = wantedSession === state.expectCreate ? '&create=1' : '';
    const url = `${proto}://${location.host}/ws/term?session=${encodeURIComponent(wantedSession)}${create}`;
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
        // llegó output: el socket está vivo, cancelar el watchdog de resume()
        if (refreshTimer) {
          clearTimeout(refreshTimer);
          refreshTimer = null;
        }
        term.write(m.d);
      } else if (m.t === 'meta') {
        if (m.gone) {
          // la sesión ya no existe (matada en otro tab/dispositivo, o reboot
          // de la Mac): no insistir con retries — caer a una sesión viva
          fallbackToLiveSession();
        } else if (m.created && m.session !== state.defaultSession && m.session !== state.expectCreate) {
          // Este cliente no pidió crear nada: la sesión fue matada en otro
          // tab/dispositivo y este reconnect la acaba de resucitar (attach-or-
          // create). Sin este guard, "borrar" una sesión la respawnea al toque
          // mientras haya otro cliente mirándola. Matarla de vuelta y caer a
          // una viva; la default queda exenta (recrearla siempre es deseado).
          api(`/api/tmux/sessions/${encodeURIComponent(m.session)}`, { method: 'DELETE' }).catch(() => {});
          fallbackToLiveSession();
        } else {
          state.expectCreate = null;
          if (m.created) showHint();
        }
      }
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
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return; // CONNECTING: dejarlo terminar
      // El socket dice OPEN pero después de un freeze de iOS puede ser un
      // zombie, o el buffer de xterm puede haber quedado corrupto (tarea 11:
      // texto doblado/mezclado que solo se arreglaba abriendo el teclado,
      // porque el cambio de viewport forzaba un resize → repaint de tmux).
      // Pedir un repaint completo siempre; si no llega NINGÚN output en 2 s,
      // el socket estaba muerto → reconectar.
      doFit(true);
      try {
        ws.send(JSON.stringify({ t: 'refresh' }));
      } catch (_) {
        retries = 0;
        connect();
        return;
      }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        console.warn('[deck] sin output tras refresh post-resume: WS zombie, reconectando');
        retries = 0;
        connect();
      }, 2000);
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
  slash: '/',
  // salto de línea SIN enviar el prompt: Claude Code trata ESC+CR (alt+enter)
  // como newline suave — verificado contra claude real dentro de tmux
  nl: '\x1b\r',
};

// Tap con tolerancia al scroll: preventDefault en pointerdown mantiene el foco
// (no se cierra el teclado virtual), pero la acción recién dispara en pointerup
// y solo si el dedo no se movió — apoyar el pulgar en un botón para scrollear
// la fila ya no lo dispara (antes: disparo inmediato en pointerdown).
const TAP_SLOP = 12; // px de movimiento tolerado para seguir contando como tap
function onTap(el, fn) {
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    start = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  el.addEventListener('pointerup', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    start = null;
    if (moved <= TAP_SLOP) fn(e);
  });
  el.addEventListener('pointercancel', () => { start = null; }); // el scroll se quedó con el gesto
}

function wireQuickKeys() {
  document.querySelectorAll('.quickkeys button[data-k]').forEach((btn) => {
    onTap(btn, () => {
      if (claudeConn) claudeConn.sendKeys(KEYS[btn.dataset.k]);
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
  onTap(btn, () => onPick());
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
  // si ya está abierto CON este contenido, el tap lo cierra (toggle); si
  // muestra otro menú (adjuntar), se re-renderiza con este
  if (!menu.classList.contains('hidden') && menu.dataset.kind === 'model') {
    closeSwitchMenu();
    return;
  }
  menu.innerHTML = '';
  menu.dataset.kind = 'model';
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
    onTap(btn, () => {
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
  onTap($('#btn-mode'), () => cycleMode());
  onTap($('#btn-model'), () => openModelMenu());
  // tap afuera cierra el menú
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#switch-menu, #btn-mode, #btn-model, #btn-attach')) closeSwitchMenu();
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

// Texto del portapapeles → prompt de Claude. term.paste() normaliza los \n a
// \r y respeta el bracketed paste que Claude Code activa (y tmux propaga), así
// un texto multilínea entra como pegado y NO submitea el prompt.
function pasteTextToPrompt(text) {
  if (!claudeConn) return;
  claudeConn.term.paste(text);
}

// Clipboard API asíncrona: requiere HTTPS (tailscale ✓) y un tap real del
// usuario; iOS muestra el globito de permiso "Pegar" la primera vez.
// Prioridad imagen > texto (una captura copiada puede traer ambos types).
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
  for (const item of items) {
    if (item.types.includes('text/plain')) {
      const text = await (await item.getType('text/plain')).text();
      if (text) {
        pasteTextToPrompt(text);
        return;
      }
    }
  }
  alert('No hay imagen ni texto en el portapapeles');
}

// --- botón único + : chooser cámara / pegar (popover, mismo patrón que el
// menú de modelo — un modal taparía la terminal para elegir entre 2 opciones) ---
const ATTACH_OPTS = [
  {
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8.5 7l1.6-2.4h3.8L15.5 7"/><circle cx="12" cy="13.2" r="3.4"/></svg>',
    label: 'Cámara o galería',
    pick: () => $('#img-input').click(),
  },
  {
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4.5" width="14" height="17" rx="2.5"/><path d="M9 4.5a3 3 0 0 1 6 0"/><path d="M9.3 13.5l2 2 3.4-3.8"/></svg>',
    label: 'Pegar del portapapeles',
    pick: () => pasteFromClipboard(),
  },
];

function openAttachMenu() {
  const menu = $('#switch-menu');
  if (!menu.classList.contains('hidden') && menu.dataset.kind === 'attach') {
    closeSwitchMenu();
    return;
  }
  menu.innerHTML = '';
  menu.dataset.kind = 'attach';
  menu.appendChild(menuHeader('Adjuntar'));
  for (const opt of ATTACH_OPTS) {
    const btn = document.createElement('button');
    btn.className = 'mi';
    btn.innerHTML = opt.icon; // SVG estático de ATTACH_OPTS, no hay input del usuario
    const span = document.createElement('span');
    span.textContent = opt.label;
    btn.appendChild(span);
    onTap(btn, () => {
      closeSwitchMenu();
      opt.pick(); // corre dentro del pointerup: sigue habiendo user activation
    });
    menu.appendChild(btn);
  }
  menu.classList.remove('hidden');
}

function wireImagePaste() {
  const input = $('#img-input');
  onTap($('#btn-attach'), () => openAttachMenu());
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) attachImage(input.files[0], 'Imagen adjunta');
    input.value = ''; // permitir re-elegir el mismo archivo
  });
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
      return;
    }
    // texto: solo si el foco NO está en la terminal — ahí xterm ya pega solo
    // (interceptarlo duplicaría el pegado)
    if (e.target.closest && e.target.closest('.term-wrap')) return;
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (text) {
      e.preventDefault();
      pasteTextToPrompt(text);
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
      // tap en el nombre del chip activo → renombrar (el chip entero ya no
      // hace nada al estar activo: selectSession retorna temprano)
      label.className = 'chip-name';
      label.title = 'Renombrar sesión';
      label.addEventListener('click', (e) => {
        e.stopPropagation();
        renameSession(name);
      });
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
  if (state.activeTab === 'files') refreshTree(false); // idem Archivos (si no está activa, refetchea al entrar)
}

async function killSession(name) {
  if (!window.confirm(`¿Matar la sesión "${name}"? Se cierra lo que esté corriendo adentro.`)) return;
  try {
    await api(`/api/tmux/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
  } catch (_) { return; }

  // el estado de switchers es por sesión: muere con ella
  try { localStorage.removeItem(`deck-switch:${name}`); } catch (_) {}

  if (state.session === name) {
    await fallbackToLiveSession();
  } else {
    refreshSessions();
  }
}

// Caer a otra sesión viva (la default si existe; se recrea vacía si no queda
// ninguna). Usado al matar la sesión activa y por el guard anti-resurrección.
async function fallbackToLiveSession() {
  let names = [];
  try {
    names = (await (await api('/api/tmux/sessions')).json()).map((s) => s.name);
  } catch (_) {}
  state.session = names.includes(state.defaultSession)
    ? state.defaultSession
    : (names[0] || state.defaultSession);
  hideHint();
  closeSwitchMenu();
  renderSwitchPills(); // sin esto la pill queda con el modelo de la sesión muerta
  claudeConn.reconnect();
  refreshGit();
  treeSession = null; // el fallback puede reusar el nombre muerto: refetch siempre
  if (state.activeTab === 'files') refreshTree(false);
  refreshSessions();
}

const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/; // igual que SESSION_RE del server

async function renameSession(name) {
  const input = window.prompt('Nuevo nombre para la sesión:', name);
  if (input === null) return;
  const newName = input.trim();
  if (!newName || newName === name) return;
  if (!SESSION_NAME_RE.test(newName) || newName.endsWith('-shell')) {
    alert('Nombre inválido: letras, números, "-" y "_" (máx 32), sin terminar en -shell');
    return;
  }
  try {
    const res = await api(`/api/tmux/sessions/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newName }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch (_) {}
      alert(`No se pudo renombrar: ${msg}`);
      return;
    }
  } catch (_) { return; }

  // el attach tmux sobrevive al rename (tmux no desconecta clientes): no hace
  // falta reconectar el WS, solo actualizar el nombre con el que habla la API
  if (state.session === name) {
    state.session = newName;
    if (treeSession === name) treeSession = newName; // mismo árbol, solo cambió el nombre
    try {
      // el estado de switchers se guarda por sesión: migrarlo al nuevo nombre
      const sw = localStorage.getItem(`deck-switch:${name}`);
      if (sw !== null) {
        localStorage.setItem(`deck-switch:${newName}`, sw);
        localStorage.removeItem(`deck-switch:${name}`);
      }
    } catch (_) {}
  }
  refreshSessions();
  refreshGit();
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
  const name = nextSessionName(existing);
  state.expectCreate = name; // creación pedida por el usuario: el guard no debe revertirla
  selectSession(name);
}

// ---------------------------------------------------------------------------
// Pestaña Cambios
// ---------------------------------------------------------------------------
const BADGES = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', T: 'T', '??': '??' };

function sessionQuery() {
  return state.session ? `session=${encodeURIComponent(state.session)}` : '';
}

// badge sobre la tab Cambios: cantidad de archivos con cambios (0 u error → oculto)
function setChangesBadge(count) {
  const b = $('#tab-changes-badge');
  if (!count) {
    b.classList.add('hidden');
    b.textContent = '';
    return;
  }
  b.textContent = count > 99 ? '99+' : String(count);
  b.classList.remove('hidden');
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
    setChangesBadge(0);
    return;
  }

  setChangesBadge(data.files.length);

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
// Pestaña Archivos: árbol del directorio de la sesión (solo lectura).
// Carga lazy por nivel (/api/fs/list); tap en un archivo abre /api/fs/file.
// ---------------------------------------------------------------------------
let treeSession = null; // sesión cuyo árbol está renderizado (null = refetch)
let treeRoot = null; // raíz absoluta renderizada: si el cwd del pane resuelve a otra, re-render
let treeRootName = 'Archivos'; // basename de la raíz, para el título del header

function extClass(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return 'ft-js';
  if (['ts', 'tsx'].includes(ext)) return 'ft-ts';
  if (ext === 'json') return 'ft-json';
  if (['md', 'txt'].includes(ext)) return 'ft-md';
  if (['css', 'scss', 'less'].includes(ext)) return 'ft-css';
  if (['html', 'htm', 'svg', 'xml'].includes(ext)) return 'ft-html';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'heic'].includes(ext)) return 'ft-img';
  if (['sh', 'bash', 'zsh', 'env'].includes(ext)) return 'ft-sh';
  return 'ft-plain';
}

// Iconos SVG del árbol (estilo explorador de VS Code, mismo trazo que los
// botones de cámara/pegar). Markup 100% constante de la app: acá nunca se
// interpola contenido ni nombres de archivos (sin riesgo de inyección).
const ftSvg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const FT_ICONS = {
  folder: ftSvg('<path d="M3 18.5V7a2 2 0 0 1 2-2h4.2l2 2.5H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  folderOpen: ftSvg('<path d="M3 18.5V7a2 2 0 0 1 2-2h4.2l2 2.5H19"/><path d="M3 18.5l2.6-7h15.4l-2.5 7z"/>'),
  js: ftSvg('<rect x="3" y="3" width="18" height="18" rx="3.5"/><text x="12" y="16.2" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="9.5" font-weight="700" fill="currentColor" stroke="none">JS</text>'),
  ts: ftSvg('<rect x="3" y="3" width="18" height="18" rx="3.5"/><text x="12" y="16.2" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="9.5" font-weight="700" fill="currentColor" stroke="none">TS</text>'),
  json: ftSvg('<path d="M9.5 4.5c-2 0-3 1-3 2.8v2c0 1.4-.9 2.2-2.5 2.7 1.6.5 2.5 1.3 2.5 2.7v2c0 1.8 1 2.8 3 2.8"/><path d="M14.5 4.5c2 0 3 1 3 2.8v2c0 1.4.9 2.2 2.5 2.7-1.6.5-2.5 1.3-2.5 2.7v2c0 1.8-1 2.8-3 2.8"/>'),
  md: ftSvg('<path d="M3.5 16.5v-9l3.75 4.5L11 7.5v9"/><path d="M17 7.5v9"/><path d="M14 13.5l3 3 3-3"/>'),
  css: ftSvg('<path d="M9.5 4l-2 16M16.5 4l-2 16M4.5 9.3h16M3.5 14.7h16"/>'),
  html: ftSvg('<path d="M8.5 7l-5 5 5 5M15.5 7l5 5-5 5"/>'),
  img: ftSvg('<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.8" cy="9.8" r="1.7"/><path d="M4.5 17.5l5-5 3 3 3.5-3.5 3.5 3.5"/>'),
  sh: ftSvg('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M6.8 9.3l3.2 2.7-3.2 2.7M12.5 15h4.5"/>'),
  pkg: ftSvg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  git: ftSvg('<path d="M6.5 3.5v11"/><circle cx="17.5" cy="6.5" r="2.8"/><circle cx="6.5" cy="17.5" r="2.8"/><path d="M17.5 9.3a8.7 8.7 0 0 1-8.2 8.2"/>'),
  env: ftSvg('<circle cx="7.8" cy="16.2" r="4.3"/><path d="M10.8 13.2l9.7-9.7M15.6 8.4l2.9 2.9"/>'),
  file: ftSvg('<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5v5h5"/>'),
};

// icono según la clase de tinte de extClass (lo que no matchea → página genérica)
const FT_ICON_BY_CLASS = {
  'ft-js': 'js', 'ft-ts': 'ts', 'ft-json': 'json', 'ft-md': 'md',
  'ft-css': 'css', 'ft-html': 'html', 'ft-img': 'img', 'ft-sh': 'sh',
};

// tinte + icono de un archivo; nombres especiales primero, después la extensión
function fileIcon(name) {
  const lower = name.toLowerCase();
  if (lower === 'package.json' || lower === 'package-lock.json') return { cls: 'ft-json', svg: FT_ICONS.pkg };
  if (lower.startsWith('.git')) return { cls: 'ft-html', svg: FT_ICONS.git };
  if (lower.startsWith('.env')) return { cls: 'ft-sh', svg: FT_ICONS.env };
  const cls = extClass(name);
  return { cls, svg: FT_ICONS[FT_ICON_BY_CLASS[cls]] || FT_ICONS.file };
}

// ext → lenguaje del bundle "common" de highlight.js (los que no están acá se
// muestran en texto plano). Archivos grandes tampoco se resaltan: hljs es O(n)
// pero con constantes feas — 200 KB ya se siente en el celular.
const HLJS_LANGS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  sh: 'bash', bash: 'bash', zsh: 'bash', env: 'bash',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', swift: 'swift', kt: 'kotlin', lua: 'lua', pl: 'perl',
  sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', diff: 'diff',
};
const HL_SIZE_LIMIT = 200 * 1024;

function highlightInto(codeEl, name, content) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const lang = HLJS_LANGS[ext];
  if (lang && window.hljs && content.length <= HL_SIZE_LIMIT) {
    try {
      codeEl.className = 'hljs';
      codeEl.innerHTML = hljs.highlight(content, { language: lang }).value;
      return;
    } catch (_) { /* lenguaje no cargado en el bundle: caer a texto plano */ }
  }
  codeEl.textContent = content;
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function emptyNote(text) {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.textContent = text;
  return el;
}

async function fetchList(relPath) {
  const q = relPath ? `path=${encodeURIComponent(relPath)}&` : '';
  const res = await api(`/api/fs/list?${q}${sessionQuery()}`);
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error((err && err.error) || `HTTP ${res.status}`);
  }
  return res.json();
}

function renderEntries(entries, container, base, depth) {
  for (const ent of entries) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const row = document.createElement('div');
    row.className = `ft-row ${ent.type}`;
    row.style.paddingLeft = `${12 + depth * 16}px`;
    const name = document.createElement('span');
    name.className = 'ft-name';
    name.textContent = ent.name;

    if (ent.type === 'dir') {
      const caret = document.createElement('span');
      caret.className = 'ft-caret';
      caret.textContent = '▸';
      const ico = document.createElement('span');
      ico.className = 'ft-ico ft-dir';
      ico.innerHTML = FT_ICONS.folder; // cerrada; se intercambia al expandir
      row.append(caret, ico, name);
      // los hijos van en un contenedor propio: colapsar = ocultarlo (se
      // conserva lo ya cargado), expandir la primera vez = fetch lazy
      const kids = document.createElement('div');
      kids.className = 'ft-kids hidden';
      let loaded = false;
      row.addEventListener('click', async () => {
        if (!loaded) {
          loaded = true;
          try {
            const data = await fetchList(rel);
            renderEntries(data.entries, kids, rel, depth + 1);
            if (data.truncated) kids.appendChild(emptyNote(`… lista truncada a ${data.entries.length} entradas`));
            if (!data.entries.length) kids.appendChild(emptyNote('(vacío)'));
          } catch (e) {
            loaded = false;
            if (String(e.message) === '401') return;
          }
        }
        const nowHidden = kids.classList.toggle('hidden');
        caret.textContent = nowHidden ? '▸' : '▾';
        ico.innerHTML = nowHidden ? FT_ICONS.folder : FT_ICONS.folderOpen;
      });
      container.append(row, kids);
    } else {
      const fi = fileIcon(ent.name);
      const ico = document.createElement('span');
      ico.className = `ft-ico ${fi.cls}`;
      ico.innerHTML = fi.svg;
      row.append(ico, name);
      row.addEventListener('click', () => openFile(rel));
      container.append(row);
    }
  }
}

async function refreshTree(force) {
  // Con el árbol de esta sesión ya pintado, la llamada igual relistea la raíz
  // (el server resuelve el cwd del pane en cada request): si un cd movió la
  // sesión a OTRA raíz hay que re-renderizar, pero si sigue en la misma no se
  // toca el DOM — las carpetas expandidas y el archivo abierto sobreviven.
  const cached = treeSession === state.session && !force;
  const ses = state.session;
  const tree = $('#file-tree');
  if (!cached) {
    closeFileView();
    tree.innerHTML = '';
    tree.appendChild(emptyNote('Cargando…'));
  }
  let data;
  try {
    data = await fetchList('');
  } catch (e) {
    if (ses !== state.session) return; // cambió la sesión mientras cargaba
    treeSession = null;
    closeFileView();
    tree.innerHTML = '';
    if (String(e.message) !== '401') tree.appendChild(emptyNote(`No se pudo listar: ${e.message}`));
    return;
  }
  if (ses !== state.session) return; // idem: que una respuesta vieja no pise el árbol nuevo
  if (cached && data.root === treeRoot) return;
  closeFileView(); // raíz nueva: resetear archivo abierto y expansión
  treeSession = state.session;
  treeRoot = data.root;
  treeRootName = data.root.split('/').pop() || 'Archivos';
  $('#files-title').textContent = treeRootName;
  tree.innerHTML = '';
  if (!data.entries.length) {
    tree.appendChild(emptyNote('Directorio vacío'));
    return;
  }
  renderEntries(data.entries, tree, '', 0);
  if (data.truncated) tree.appendChild(emptyNote(`… lista truncada a ${data.entries.length} entradas`));
}

// archivo abierto en la vista (para el toggle fuente ↔ markdown sin refetch)
let openedFile = null; // { rel, content, truncated, size } | null

// links del markdown renderizado en pestaña nueva: que un tap no navegue la PWA
if (typeof DOMPurify !== 'undefined') {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

function canRenderMd(rel) {
  return /\.md$/i.test(rel) && typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined';
}

// pinta el contenido ya cargado en #file-view: fuente resaltada o markdown
function renderOpenedFile(asMarkdown) {
  const view = $('#file-view');
  view.innerHTML = '';
  if (asMarkdown && canRenderMd(openedFile.rel)) {
    const body = document.createElement('div');
    body.className = 'md-body';
    // sanitizado obligatorio: acá se abren archivos arbitrarios del repo
    // (READMEs de node_modules incluidos) y el HTML corre en el origin de la app
    body.innerHTML = DOMPurify.sanitize(marked.parse(openedFile.content));
    view.appendChild(body);
  } else {
    const pre = document.createElement('pre');
    pre.className = 'file-pre';
    const code = document.createElement('code');
    highlightInto(code, openedFile.rel, openedFile.content);
    pre.appendChild(code);
    view.appendChild(pre);
  }
  if (openedFile.truncated) view.appendChild(emptyNote(`… truncado a 512 KB (el archivo pesa ${fmtSize(openedFile.size)})`));
  $('#btn-md-render').classList.toggle('active', asMarkdown);
  view.scrollTop = 0;
}

function toggleMdRender() {
  if (!openedFile || !canRenderMd(openedFile.rel)) return;
  renderOpenedFile(!$('#btn-md-render').classList.contains('active'));
}

async function openFile(rel) {
  $('#btn-file-back').classList.remove('hidden');
  $('#file-tree').classList.add('hidden');
  $('#files-title').textContent = rel;
  openedFile = null;
  $('#btn-md-render').classList.add('hidden');
  $('#btn-md-render').classList.remove('active');
  const view = $('#file-view');
  view.classList.remove('hidden');
  view.innerHTML = '';
  view.appendChild(emptyNote('Cargando…'));

  let data;
  try {
    const res = await api(`/api/fs/file?path=${encodeURIComponent(rel)}&${sessionQuery()}`);
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error((err && err.error) || `HTTP ${res.status}`);
    }
    data = await res.json();
  } catch (e) {
    view.innerHTML = '';
    if (String(e.message) !== '401') view.appendChild(emptyNote(`No se pudo leer el archivo: ${e.message}`));
    return;
  }

  view.innerHTML = '';
  if (data.binary) {
    view.appendChild(emptyNote(`Archivo binario · ${fmtSize(data.size)}`));
    return;
  }
  openedFile = { rel, content: data.content, truncated: data.truncated, size: data.size };
  if (canRenderMd(rel)) $('#btn-md-render').classList.remove('hidden');
  renderOpenedFile(false); // default: fuente
}

function closeFileView() {
  openedFile = null;
  $('#btn-md-render').classList.add('hidden');
  $('#btn-md-render').classList.remove('active');
  $('#btn-file-back').classList.add('hidden');
  $('#file-view').classList.add('hidden');
  $('#file-view').innerHTML = '';
  $('#file-tree').classList.remove('hidden');
  $('#files-title').textContent = treeRootName;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function switchTab(name) {
  state.activeTab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'claude') requestAnimationFrame(() => claudeConn.fit());
  if (name === 'files') refreshTree(false);
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

  claudeConn = createTermConnection('term-claude', 'conn-claude', () => state.session);

  wireQuickKeys();
  wireSwitchers();
  wireTouchScroll('term-claude', () => claudeConn);
  wireImagePaste();
  refreshSessions();
  refreshGit(); // primer fetch del badge de Cambios sin esperar el intervalo

  // tabs
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  $('#btn-refresh').addEventListener('click', () => { state.inDiff ? null : refreshGit(); });
  $('#btn-diff-back').addEventListener('click', closeDiff);
  $('#btn-files-refresh').addEventListener('click', () => refreshTree(true));
  $('#btn-file-back').addEventListener('click', closeFileView);
  $('#btn-md-render').addEventListener('click', toggleMdRender);
  $('#btn-new-session').addEventListener('click', createSession);
  $('#hint-claude .hint-close').addEventListener('click', hideHint);

  // auto-refresh cada 8 s mientras la pestaña esté visible; refreshGit corre
  // en cualquier tab para mantener al día el badge de Cambios
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    refreshGit();
    if (state.activeTab === 'claude') refreshSessions();
    if (state.activeTab === 'files') refreshTree(false); // sigue el cwd del pane: re-render solo si cambió la raíz
  }, 8000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshGit();
      refreshSessions();
      if (state.activeTab === 'files') refreshTree(false);
      // iOS suele matar los WS en background: reconectar sin esperar backoff
      claudeConn.resume();
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
