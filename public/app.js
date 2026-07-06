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

// la sesión activa se persiste para sobrevivir al reload: sin esto init()
// vuelve siempre a la default, y como el server recrea la default si no
// existe (attach-or-create), renombrarla y recargar spawneaba un "deck"
// vacío fantasma
const ACTIVE_SESSION_KEY = 'deck-active-session';
function persistActiveSession() {
  try { localStorage.setItem(ACTIVE_SESSION_KEY, state.session); } catch (_) {}
}

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

  function sendVis() {
    // presencia (tarea 3): el server suprime pushes de notify.sh mientras
    // alguna PWA esté visible en primer plano. Se manda al conectar, en cada
    // visibilitychange y re-afirmado en el poll de 8 s (TTL server: 25 s).
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: 'vis', visible: document.visibilityState === 'visible' }));
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
      sendVis();
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
    sendVis,
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
  markSnippetsBtn();
  hideSnipTip(); // que el tooltip no sobreviva a la paleta
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
  markSnippetsBtn(); // pisó el contenido de la paleta: apagar el ☰
}

function wireSwitchers() {
  onTap($('#btn-mode'), () => cycleMode());
  onTap($('#btn-model'), () => openModelMenu());
  // tap afuera cierra el menú
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#switch-menu, #btn-mode, #btn-model, #btn-attach, #btn-snippets')) closeSwitchMenu();
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
  markSnippetsBtn(); // pisó el contenido de la paleta: apagar el ☰
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
// Composer de prompts (tarea 7): sheet a media pantalla con <textarea> nativo
// — autocorrección, dictado del teclado iOS y cursor libre gratis. Enviar =
// pasteTextToPrompt + \r diferido (mismo patrón que sendSlashCommand). El
// borrador se guarda por sesión en localStorage (`draft:<sesión>`) y sobrevive
// a que iOS mate la pestaña; Cancelar cierra pero LO CONSERVA.
// ---------------------------------------------------------------------------
const DRAFT_DEBOUNCE_MS = 500;
let composerSession = null; // sesión para la que se abrió (dueña del borrador)
let draftTimer = null;

const draftKey = (name) => `draft:${name}`;

function composerIsOpen() {
  return !$('#composer').classList.contains('hidden');
}

// guarda (o borra, si quedó vacío) el borrador de composerSession
function saveDraftNow() {
  clearTimeout(draftTimer);
  draftTimer = null;
  if (composerSession === null) return;
  const text = $('#composer-text').value;
  try {
    if (text) localStorage.setItem(draftKey(composerSession), text);
    else localStorage.removeItem(draftKey(composerSession));
  } catch (_) {}
  $('#composer-saved').classList.toggle('hidden', !text);
}

function scheduleDraftSave() {
  $('#composer-saved').classList.add('hidden'); // hay cambios sin guardar
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, DRAFT_DEBOUNCE_MS);
}

function openComposer() {
  if (composerIsOpen()) { closeComposer(); return; } // el ✎ togglea
  closeSwitchMenu();
  composerSession = state.session;
  $('#composer-session').textContent = composerSession;
  const ta = $('#composer-text');
  let draft = '';
  try { draft = localStorage.getItem(draftKey(composerSession)) || ''; } catch (_) {}
  ta.value = draft;
  $('#composer-saved').classList.toggle('hidden', !draft);
  $('#composer').classList.remove('hidden');
  document.body.classList.add('composer-open');
  // focus sincrónico dentro del gesto: iOS no abre el teclado desde un timer.
  // El fit va en rAF (el sheet le comió filas a la terminal); si el teclado
  // aparece, updateViewportGeometry re-fittea de nuevo con el alto final.
  ta.focus();
  requestAnimationFrame(() => claudeConn && claudeConn.fit());
}

function closeComposer() {
  if (!composerIsOpen()) return;
  saveDraftNow(); // Cancelar conserva el borrador; tras enviar guarda vacío → borra la key
  hideComposerSnips();
  composerSession = null;
  $('#composer-text').blur(); // sin esto el teclado iOS queda abierto sobre la terminal
  $('#composer').classList.add('hidden');
  document.body.classList.remove('composer-open');
  requestAnimationFrame(() => claudeConn && claudeConn.fit());
}

function sendComposer() {
  const ta = $('#composer-text');
  const text = ta.value;
  if (!text.trim() || !claudeConn) return;
  pasteTextToPrompt(text); // bracketed paste: el multilínea entra sin submitear
  // Enter diferido, mismo patrón que sendSlashCommand: en el mismo tick el
  // prompt se come el \r
  setTimeout(() => claudeConn && claudeConn.sendKeys('\r'), 150);
  ta.value = ''; // enviado: closeComposer guarda vacío → limpia el borrador
  closeComposer();
}

// inserta un \n literal en el cursor del textarea — NO KEYS.nl: \x1b\r es un
// concepto de terminal, acá es un textarea nativo
function composerNewline() {
  const ta = $('#composer-text');
  ta.setRangeText('\n', ta.selectionStart, ta.selectionEnd, 'end');
  scheduleDraftSave(); // setRangeText no dispara 'input'
}

function wireComposer() {
  onTap($('#btn-composer'), () => openComposer());
  onTap($('#composer-cancel'), () => closeComposer());
  onTap($('#composer-send'), () => sendComposer());
  onTap($('#composer-nl'), () => composerNewline());
  $('#composer-text').addEventListener('input', scheduleDraftSave);
}

// ---------------------------------------------------------------------------
// Paleta de snippets (tarea 10): frases de uso constante a un tap. La lista es
// GLOBAL y vive en el server (~/.claude-deck/snippets.json, GET/PUT
// /api/snippets) para que sincronice celu ↔ desktop — decisión de Lucas.
// Tocar un chip ESCRIBE el texto en el prompt y NUNCA envía: bracketed paste
// sin el \r diferido de sendSlashCommand, hasta /compact entra como texto
// tipeado. Con el composer abierto inserta en el textarea en el cursor.
// Edición low-fi con prompt(), el patrón establecido (renameSession).
// ---------------------------------------------------------------------------
let snippets = null;         // cache local; null = todavía no se pudo cargar
let snippetsEditing = false; // modo edición (renombrar / borrar / mover)

async function loadSnippets(force) {
  if (snippets && !force) return;
  try {
    const res = await api('/api/snippets');
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.snippets)) snippets = data.snippets;
  } catch (_) { /* server caído: la paleta muestra el error */ }
}

async function saveSnippets() {
  try {
    const res = await api('/api/snippets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snippets }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch (_) {}
      alert(`No se pudieron guardar los snippets: ${msg}`);
    }
  } catch (e) {
    if (String(e.message) !== '401') alert('No se pudieron guardar los snippets (error de red)');
  }
}

// la lista es compartida entre dispositivos: refrescar en cada apertura y
// re-pintar solo si cambió (la primera pintura sale del cache al toque)
function refreshSnippetsInBackground() {
  const before = JSON.stringify(snippets);
  loadSnippets(true).then(() => {
    if (snippetsEditing) return; // no pisar una edición en curso
    if (JSON.stringify(snippets) !== before) rerenderSnippets();
  });
}

// insertar SIN enviar: ese es el contrato de toda la paleta (caption del mockup)
function insertSnippet(text) {
  if (composerIsOpen()) {
    const ta = $('#composer-text');
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    scheduleDraftSave(); // setRangeText no dispara 'input' (como composerNewline)
    hideComposerSnips();
    ta.focus();
  } else {
    pasteTextToPrompt(text);
    closeSwitchMenu();
  }
}

function snippetAdd() {
  const input = window.prompt('Texto del nuevo snippet:');
  if (input === null) return;
  const text = input.trim();
  if (!text) return;
  snippets.push(text);
  saveSnippets();
  rerenderSnippets();
}

function snippetRename(i) {
  const input = window.prompt('Editar snippet:', snippets[i]);
  if (input === null) return;
  const text = input.trim();
  if (!text || text === snippets[i]) return;
  snippets[i] = text;
  saveSnippets();
  rerenderSnippets();
}

function snippetDelete(i) {
  if (!window.confirm(`¿Borrar el snippet "${snippets[i]}"?`)) return;
  snippets.splice(i, 1);
  saveSnippets();
  rerenderSnippets();
}

// mover un lugar hacia atrás alcanza para cualquier reordenamiento (grilla 2
// col: "antes" = izquierda o fila anterior)
function snippetMove(i) {
  if (i <= 0) return;
  [snippets[i - 1], snippets[i]] = [snippets[i], snippets[i - 1]];
  saveSnippets();
  rerenderSnippets();
}

// --- tooltip de texto completo: los chips truncan con ellipsis y un snippet
// largo se vuelve ilegible. Desktop: hover con el mouse. Touch (sin hover):
// mantener apretado ~medio segundo lo muestra mientras el dedo siga apoyado,
// y ese release NO inserta (es un peek, no una acción — snipTipSuppressTap).
// Solo aparece si el texto realmente no entra en el chip. ---
const SNIP_TIP_HOLD_MS = 450;
let snipTipHoldTimer = null;
let snipTipSuppressTap = false; // true = el pointerup en curso fue un peek

function showSnipTip(chip, text) {
  const tip = $('#snip-tip');
  tip.textContent = text;
  tip.classList.remove('hidden');
  // medir visible con su max-width y recién después posicionar: centrado
  // sobre el chip, clampeado al viewport (fixed = mismas coordenadas que
  // getBoundingClientRect, no importa dónde esté el contenedor)
  const r = chip.getBoundingClientRect();
  const x = Math.max(8, Math.min(r.left + r.width / 2 - tip.offsetWidth / 2,
    window.innerWidth - tip.offsetWidth - 8));
  tip.style.left = `${x}px`;
  tip.style.bottom = `${window.innerHeight - r.top + 8}px`; // arriba del chip
}

function hideSnipTip() {
  clearTimeout(snipTipHoldTimer);
  snipTipHoldTimer = null;
  $('#snip-tip').classList.add('hidden');
}

function wireSnipTip(chip, textSpan, text) {
  const truncated = () => textSpan.scrollWidth > textSpan.clientWidth + 1;
  chip.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'mouse' && truncated()) showSnipTip(chip, text);
  });
  chip.addEventListener('pointerleave', hideSnipTip);
  chip.addEventListener('pointerdown', () => {
    snipTipSuppressTap = false; // gesto nuevo; el flag NO se consume en los taps
    clearTimeout(snipTipHoldTimer);
    snipTipHoldTimer = setTimeout(() => {
      snipTipHoldTimer = null;
      if (truncated()) {
        snipTipSuppressTap = true;
        showSnipTip(chip, text);
      }
    }, SNIP_TIP_HOLD_MS);
  });
  chip.addEventListener('pointerup', hideSnipTip);
  chip.addEventListener('pointercancel', hideSnipTip);
}

// pinta la paleta en un contenedor: header (SNIPPETS · Editar) + grilla 2 col
// con "+ Nuevo" al final; compartida por el popover y el panel del composer
function renderSnippetsInto(box) {
  hideSnipTip(); // un re-render reemplaza los chips: el pointerleave nunca llegaría
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'snip-head';
  const title = document.createElement('span');
  title.className = 'snip-title';
  title.textContent = 'Snippets';
  head.appendChild(title);
  if (snippets) {
    const edit = document.createElement('button');
    edit.className = 'snip-edit';
    edit.textContent = snippetsEditing ? 'Listo' : 'Editar';
    onTap(edit, () => {
      snippetsEditing = !snippetsEditing;
      rerenderSnippets();
    });
    head.appendChild(edit);
  }
  box.appendChild(head);
  if (!snippets) {
    const err = document.createElement('div');
    err.className = 'empty-state';
    err.textContent = 'No se pudieron cargar los snippets';
    box.appendChild(err);
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'mi-snippets';
  snippets.forEach((text, i) => {
    const chip = document.createElement('button');
    chip.className = 'snip';
    const span = document.createElement('span');
    span.className = 'snip-text';
    span.textContent = text;
    chip.appendChild(span);
    if (snippetsEditing) {
      if (i > 0) {
        const mv = document.createElement('span');
        mv.className = 'snip-move';
        mv.textContent = '◀';
        mv.title = 'Mover antes';
        onTap(mv, () => {
          if (snipTipSuppressTap) return; // release de un peek, no un tap
          snippetMove(i);
        });
        chip.appendChild(mv);
      }
      const x = document.createElement('span');
      x.className = 'snip-x';
      x.textContent = '✕';
      x.title = 'Borrar';
      onTap(x, () => {
        if (snipTipSuppressTap) return; // release de un peek, no un tap
        snippetDelete(i);
      });
      chip.appendChild(x);
    }
    // el pointerup de los controles burbujea hasta el chip: ignorarlo acá
    // (el onTap del control ya disparó su acción)
    onTap(chip, (e) => {
      if (snipTipSuppressTap) return; // release de un peek (long-press), no un tap
      if (e.target.closest('.snip-move, .snip-x')) return;
      if (snippetsEditing) snippetRename(i);
      else insertSnippet(text);
    });
    wireSnipTip(chip, span, text); // title nativo no: en el celu no existe y en desktop duplicaría
    grid.appendChild(chip);
  });
  const add = document.createElement('button');
  add.className = 'snip snip-new';
  add.textContent = '+ Nuevo';
  onTap(add, () => snippetAdd());
  grid.appendChild(add);
  box.appendChild(grid);
}

// re-pinta la superficie abierta (popover o panel del composer) tras una edición
function rerenderSnippets() {
  const menu = $('#switch-menu');
  if (!menu.classList.contains('hidden') && menu.dataset.kind === 'snippets') renderSnippetsInto(menu);
  const panel = $('#composer-snips');
  if (!panel.classList.contains('hidden')) renderSnippetsInto(panel);
}

// ☰ ámbar mientras la paleta esté abierta (como el mockup); centralizado acá
// porque el popover se cierra/pisa desde varios lados
function markSnippetsBtn() {
  const menu = $('#switch-menu');
  const open = !menu.classList.contains('hidden') && menu.dataset.kind === 'snippets';
  $('#btn-snippets').classList.toggle('active', open);
}

async function openSnippetsMenu() {
  const menu = $('#switch-menu');
  // mismo patrón toggle/re-render que openModelMenu / openAttachMenu
  if (!menu.classList.contains('hidden') && menu.dataset.kind === 'snippets') {
    closeSwitchMenu();
    return;
  }
  snippetsEditing = false;
  menu.innerHTML = '';
  menu.dataset.kind = 'snippets';
  await loadSnippets();
  if (menu.dataset.kind !== 'snippets') return; // otro menú ganó durante el await
  renderSnippetsInto(menu);
  menu.classList.remove('hidden');
  markSnippetsBtn();
  refreshSnippetsInBackground();
}

async function toggleComposerSnips() {
  const panel = $('#composer-snips');
  if (!panel.classList.contains('hidden')) {
    hideComposerSnips();
    return;
  }
  snippetsEditing = false;
  await loadSnippets();
  if (!composerIsOpen()) return; // se cerró el composer durante el await
  renderSnippetsInto(panel);
  panel.classList.remove('hidden');
  $('#composer-snippets').classList.add('active');
  refreshSnippetsInBackground();
}

function hideComposerSnips() {
  const panel = $('#composer-snips');
  if (panel.classList.contains('hidden')) return;
  panel.classList.add('hidden');
  panel.innerHTML = '';
  $('#composer-snippets').classList.remove('active');
  hideSnipTip(); // que el tooltip no sobreviva al panel
}

function wireSnippets() {
  onTap($('#btn-snippets'), () => openSnippetsMenu());
  onTap($('#composer-snippets'), () => toggleComposerSnips());
  // tap afuera cierra el panel del composer (el popover ya lo cubre wireSwitchers)
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#composer-snips, #composer-snippets')) hideComposerSnips();
  });
}

// ---------------------------------------------------------------------------
// Scrollback legible (tarea 9): overlay fullscreen de solo lectura. Fuente
// primaria: el transcript .jsonl de la sesión como turnos (Claude Code 2.x
// corre en alternate screen y repinta en el lugar — tmux nunca acumula su
// transcript, probado contra claude real); fallback para shells: capture-pane
// como texto plano. HTML plano a propósito: scroll nativo (sin wireTouchScroll
// ni copy-mode), selección/copy y find-in-page del browser gratis — también
// es la vía para copiar un error/path/hash. Abre al fondo (lo más reciente);
// "Cargar más" pide historia hacia atrás sin perder la posición de lectura.
// ---------------------------------------------------------------------------
const SB_STEP = 500;                    // modo pane: líneas por fetch
const SB_MAX = 5000;                    // modo pane: techo (= el del server)
const SB_BYTES_STEP = 2 * 1024 * 1024;  // modo transcript: cola inicial
const SB_BYTES_MAX = 32 * 1024 * 1024;  // modo transcript: techo (= el del server)
const SB_FONT_KEY = 'deck-sb-font';
const SB_FONT_DEFAULT = 13;
let sbMode = 'text';   // 'turns' (transcript) | 'text' (capture-pane)
let sbLines = 0;       // modo pane: líneas pedidas en el fetch vigente
let sbBytes = 0;       // modo transcript: bytes pedidos en el fetch vigente
let sbTurnCount = 0;   // modo transcript: para detectar re-fetch sin crecimiento

// aplica el tamaño persistido (+delta opcional, clampeado) vía --sb-font
function sbApplyFont(delta) {
  let px = SB_FONT_DEFAULT;
  try { px = parseInt(localStorage.getItem(SB_FONT_KEY), 10) || SB_FONT_DEFAULT; } catch (_) {}
  px = Math.min(Math.max(px + (delta || 0), 10), 20);
  try { localStorage.setItem(SB_FONT_KEY, String(px)); } catch (_) {}
  $('#scrollback').style.setProperty('--sb-font', `${px}px`);
}

// ancla de lectura compartida: al fondo en la carga inicial, compensada
// cuando "cargar más" mete contenido arriba
function sbAnchor(body, prevH, prevTop, keepAnchor) {
  body.scrollTop = keepAnchor ? body.scrollHeight - prevH + prevTop : body.scrollHeight;
}

function sbShowSource(mode) {
  sbMode = mode;
  $('#scrollback-src').textContent = mode === 'turns' ? '· transcript' : '· pane';
  $('#scrollback-turns').classList.toggle('hidden', mode !== 'turns');
  $('#scrollback-text').classList.toggle('hidden', mode !== 'text');
}

// modo transcript: turnos legibles del jsonl (404 → el caller cae a sbFetch)
async function sbFetchTranscript(bytes, keepAnchor) {
  let data;
  try {
    const res = await api(`/api/claude/transcript?${sessionQuery()}&bytes=${bytes}`);
    if (!res.ok) return false;
    data = await res.json();
  } catch (_) {
    return false;
  }
  if (!Array.isArray(data.turns) || !data.turns.length) return false; // recién nacida: mejor el pane
  const body = $('#scrollback-body');
  const prevH = body.scrollHeight;
  const prevTop = body.scrollTop;
  const box = $('#scrollback-turns');
  box.textContent = '';
  for (const t of data.turns) {
    const div = document.createElement('div');
    const role = t.role === 'user' || t.role === 'tool' ? t.role : 'assistant';
    div.className = `sb-turn sb-${role}`;
    div.textContent = t.text; // textContent siempre: el transcript es input no confiable
    box.appendChild(div);
  }
  // ocultar "cargar más" al llegar al techo o si un re-fetch no creció (techo
  // de turnos del server: más bytes ya no agregan nada visible)
  const grew = data.turns.length > sbTurnCount;
  $('#scrollback-more').classList.toggle('hidden',
    !data.more || bytes >= SB_BYTES_MAX || (keepAnchor && !grew));
  sbTurnCount = data.turns.length;
  sbBytes = bytes;
  sbShowSource('turns');
  $('#scrollback-text').textContent = '';
  sbAnchor(body, prevH, prevTop, keepAnchor);
  return true;
}

// modo pane (fallback shells): capture-pane como texto plano
async function sbFetch(lines, keepAnchor) {
  const body = $('#scrollback-body');
  const pre = $('#scrollback-text');
  let text;
  try {
    const res = await api(`/api/tmux/scrollback?${sessionQuery()}&lines=${lines}`);
    if (!res.ok) throw new Error(String(res.status));
    text = await res.text();
  } catch (_) {
    pre.textContent = 'No se pudo leer el scrollback de la sesión.';
    $('#scrollback-more').classList.add('hidden');
    sbShowSource('text');
    return;
  }
  const prevH = body.scrollHeight;
  const prevTop = body.scrollTop;
  pre.textContent = text;
  sbLines = lines;
  // "Cargar más" solo si tmux devolvió al menos lo pedido: si vino menos, la
  // historia se acabó (heurística: la captura incluye el viewport además de
  // las -S líneas, así que puede sobrar un tap no-op — aceptable)
  const got = text.split('\n').length;
  $('#scrollback-more').classList.toggle('hidden', got < lines || lines >= SB_MAX);
  sbShowSource('text');
  sbAnchor(body, prevH, prevTop, keepAnchor);
}

async function sbLoadMore() {
  if (sbMode === 'turns') await sbFetchTranscript(Math.min(sbBytes * 2, SB_BYTES_MAX), true);
  else await sbFetch(Math.min(sbLines + SB_STEP, SB_MAX), true);
}

async function openScrollback() {
  $('#scrollback-session').textContent = state.session;
  $('#scrollback-src').textContent = '';
  $('#scrollback-turns').textContent = '';
  $('#scrollback-text').textContent = 'Cargando…';
  sbTurnCount = 0;
  $('#scrollback-more').classList.add('hidden');
  sbShowSource('text');
  sbApplyFont(0);
  $('#scrollback').classList.remove('hidden');
  if (!(await sbFetchTranscript(SB_BYTES_STEP, false))) await sbFetch(SB_STEP, false);
}

function closeScrollback() {
  $('#scrollback').classList.add('hidden');
  $('#scrollback-text').textContent = ''; // soltar el contenido grande del DOM
  $('#scrollback-turns').textContent = '';
  sbLines = 0;
  sbBytes = 0;
  sbTurnCount = 0;
}

function wireScrollback() {
  onTap($('#btn-scrollback'), openScrollback);
  onTap($('#scrollback-close'), closeScrollback);
  onTap($('#scrollback-smaller'), () => sbApplyFont(-1));
  onTap($('#scrollback-bigger'), () => sbApplyFont(1));
  onTap($('#scrollback-more'), sbLoadMore);
}

// ---------------------------------------------------------------------------
// Panel de host + alerta de batería (tarea 17): la Mac que sirve el deck es
// el único camino al tailnet — si `deck away` la deja despierta a batería y
// se agota, quedás afuera. Chip "🔋 N%" pineado en la fila de sesiones (solo
// si el host reporta batería), banner ámbar sobre la terminal cuando descarga
// bajo el umbral, y bottom sheet con el detalle + toggle de la alerta push
// (server-side: el watcher corre sin ningún cliente — POST /api/host/alert).
// ---------------------------------------------------------------------------
const BATT_STATES = {
  discharging: 'descargando',
  charging: 'cargando',
  charged: 'cargada',
  'finishing charge': 'terminando carga',
  'AC attached': 'en corriente',
};

// iconos de las filas del sheet (markup 100% estático, como FT_ICONS)
const hostSvg = (body) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const HOST_ICONS = {
  batt: hostSvg('<rect x="2" y="7.5" width="17" height="9" rx="2.5"/><path d="M22 10.5v3"/><path d="M6 10.5v3M9.5 10.5v3"/>'),
  power: hostSvg('<path d="M13 2.5L4.5 13.5h6l-1.5 8L17.5 10h-6z"/>'),
  sleep: hostSvg('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>'),
  uptime: hostSvg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
};

let hostStatus = null;          // último /api/host/status (null = sin datos aún)
let hostBannerDismissed = false; // ✕ del banner: vale por episodio de descarga

async function refreshHost() {
  try {
    const res = await api('/api/host/status');
    if (!res.ok) return; // error transitorio: conservar el último estado
    hostStatus = await res.json();
  } catch (_) { return; }
  renderHost();
}

// condición del banner y del chip en alerta: descargando bajo el umbral
function battLow() {
  const b = hostStatus && hostStatus.battery;
  return !!(b && b.state === 'discharging' && b.pct < hostStatus.alert.threshold);
}

function setHostBanner(show, pct) {
  const el = $('#host-banner');
  if (show) $('#host-banner-pct').textContent = String(pct);
  if (el.classList.contains('hidden') !== show) return; // sin cambio: no re-fittear
  el.classList.toggle('hidden', !show);
  requestAnimationFrame(() => claudeConn && claudeConn.fit()); // roba/devuelve filas
}

function renderHost() {
  const chip = $('#host-chip');
  const b = hostStatus && hostStatus.battery;
  if (!b) {
    // Mac de escritorio (o pmset ilegible): sin chip ni banner
    chip.classList.add('hidden');
    setHostBanner(false);
  } else {
    chip.classList.remove('hidden');
    $('#host-chip-pct').textContent = `${b.pct}%`;
    // la barrita interna del ícono refleja el nivel (ancho útil: 13.2px)
    $('#host-batt-fill').setAttribute('width', String(Math.max(0.8, 13.2 * b.pct / 100).toFixed(1)));
    chip.classList.toggle('warn', battLow());
    if (battLow()) {
      if (!hostBannerDismissed) setHostBanner(true, b.pct);
    } else {
      hostBannerDismissed = false; // terminó el episodio: re-armar el banner
      setHostBanner(false);
    }
  }
  if (!$('#host-sheet').classList.contains('hidden')) renderHostSheet();
}

function fmtUptime(s) {
  if (!Number.isFinite(s) || s < 0) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function hostRow(icon, label, value, valueCls) {
  const row = document.createElement('div');
  row.className = 'host-row';
  const ico = document.createElement('span');
  ico.className = 'host-ico';
  ico.innerHTML = HOST_ICONS[icon]; // SVG estático de HOST_ICONS, sin input del usuario
  const lab = document.createElement('span');
  lab.className = 'host-label';
  lab.textContent = label;
  const val = document.createElement('span');
  val.className = 'host-val' + (valueCls ? ` ${valueCls}` : '');
  val.textContent = value;
  row.append(ico, lab, val);
  return row;
}

function renderHostSheet() {
  const h = hostStatus;
  if (!h) return;
  $('#host-name').textContent = h.name || 'Mac';
  const rows = $('#host-rows');
  rows.innerHTML = '';
  const b = h.battery;
  rows.appendChild(hostRow('batt', 'Batería',
    b ? `${b.pct}% · ${BATT_STATES[b.state] || b.state}` : 'sin batería',
    b && b.state === 'discharging' ? 'warn' : ''));
  rows.appendChild(hostRow('power', 'Energía',
    h.ac === null ? '—' : h.ac ? 'Corriente' : 'En batería'));
  rows.appendChild(hostRow('sleep', 'Reposo (pmset)',
    h.sleepDisabled === null ? '—' : h.sleepDisabled ? 'Activo · no dormirá' : 'Normal · puede dormir',
    h.sleepDisabled ? 'good' : ''));
  rows.appendChild(hostRow('uptime', 'Uptime', fmtUptime(h.uptime)));
  $('#host-threshold').textContent = `${h.alert.threshold}%`;
  $('#host-alert-toggle').classList.toggle('on', h.alert.enabled);
}

function openHostSheet() {
  if (!hostStatus) return;
  renderHostSheet();
  $('#host-sheet').classList.remove('hidden');
  refreshHost(); // datos frescos al abrir (el poll es de 8 s)
}

function closeHostSheet() {
  $('#host-sheet').classList.add('hidden');
}

// el toggle y el umbral gobiernan el watcher DEL SERVER (no un estado local)
async function postHostAlert(patch) {
  try {
    const res = await api('/api/host/alert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch (_) {}
      alert(`No se pudo guardar la alerta: ${msg}`);
      return;
    }
    const data = await res.json();
    if (hostStatus) {
      hostStatus.alert = data.alert;
      renderHost(); // el umbral también mueve el banner/chip en alerta
    }
  } catch (e) {
    if (String(e.message) !== '401') alert('No se pudo guardar la alerta (error de red)');
  }
}

// umbral configurable con el prompt() low-fi de siempre (renameSession, snippets)
function editHostThreshold() {
  if (!hostStatus) return;
  const input = window.prompt('Avisar cuando la batería baje de (%):', String(hostStatus.alert.threshold));
  if (input === null) return;
  const n = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(n) || n < 5 || n > 95) {
    alert('Umbral inválido: un entero entre 5 y 95');
    return;
  }
  postHostAlert({ threshold: n });
}

function wireHost() {
  // el chip está pineado fuera de la tira scrolleable: click directo alcanza
  $('#host-chip').addEventListener('click', openHostSheet);
  // tap en el fondo oscurecido (no en el panel) cierra el sheet
  $('#host-sheet').addEventListener('click', (e) => {
    if (e.target === $('#host-sheet')) closeHostSheet();
  });
  onTap($('#host-alert-toggle'), () => {
    if (hostStatus) postHostAlert({ enabled: !hostStatus.alert.enabled });
  });
  onTap($('#host-threshold'), editHostThreshold);
  $('#host-banner-close').addEventListener('click', () => {
    hostBannerDismissed = true; // por aparición: se re-arma al salir del episodio
    setHostBanner(false);
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

  // semáforo (tarea 4): estado por sesión escrito por los hooks (working /
  // waiting / idle; null = sin registro → sin punto). Va DENTRO de la key:
  // si no, un cambio de estado sin cambio de sesiones no repintaría nunca.
  const stateByName = {};
  for (const s of sessions) stateByName[s.name] = s.state || null;

  const key = names.map((n) => n + ':' + (stateByName[n] || '')).join('|') + '@' + state.session;
  if (key === chipsKey) return;
  chipsKey = key;

  const box = $('#session-chips');
  box.innerHTML = '';
  for (const name of names) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (name === state.session ? ' active' : '');
    if (stateByName[name]) {
      const dot = document.createElement('span');
      dot.className = 'chip-dot chip-dot-' + stateByName[name];
      chip.appendChild(dot);
    }
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
  persistActiveSession();
  hideHint();
  closeSwitchMenu();
  closeComposer(); // guarda el borrador de la sesión anterior (composerSession)
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

  // el estado de switchers y el borrador del composer son por sesión: mueren con ella
  try {
    localStorage.removeItem(`deck-switch:${name}`);
    localStorage.removeItem(draftKey(name));
  } catch (_) {}

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
  persistActiveSession();
  hideHint();
  closeSwitchMenu();
  closeComposer();
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
    persistActiveSession(); // sin esto un reload vuelve al nombre viejo (y recrea la default vacía)
    if (treeSession === name) treeSession = newName; // mismo árbol, solo cambió el nombre
    try {
      // el estado de switchers y el borrador del composer se guardan por
      // sesión: migrarlos al nuevo nombre
      const moves = [
        [`deck-switch:${name}`, `deck-switch:${newName}`],
        [draftKey(name), draftKey(newName)],
      ];
      for (const [oldKey, newKey] of moves) {
        const val = localStorage.getItem(oldKey);
        if (val !== null) {
          localStorage.setItem(newKey, val);
          localStorage.removeItem(oldKey);
        }
      }
    } catch (_) {}
    if (composerSession === name) {
      // composer abierto para la sesión renombrada: seguirla (el borrador
      // en curso debe guardarse bajo el nombre nuevo)
      composerSession = newName;
      $('#composer-session').textContent = newName;
    }
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

  // restaurar la última sesión activa: si la guardada ya no existe, el attach
  // sin create=1 contesta meta gone y fallbackToLiveSession() cae a una viva
  // (nunca resucita nada; la default sigue exenta como siempre)
  try {
    const saved = localStorage.getItem(ACTIVE_SESSION_KEY);
    if (saved && SESSION_NAME_RE.test(saved) && !saved.endsWith('-shell')) {
      state.session = saved;
    }
  } catch (_) {}

  // Deep-link del push (tarea 1): ?session=<name> selecciona esa sesión antes
  // del primer attach. Sin create=1 (expectCreate queda null): si la sesión
  // murió, el server contesta meta gone y caemos a una viva — nunca resucita.
  // El param se saca de la URL para que un reload manual no pinee una vieja.
  try {
    const qs = new URLSearchParams(location.search);
    const wanted = qs.get('session');
    if (wanted !== null) {
      if (SESSION_NAME_RE.test(wanted) && !wanted.endsWith('-shell')) {
        state.session = wanted;
      }
      qs.delete('session');
      const rest = qs.toString();
      history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
    }
  } catch (_) {}
  persistActiveSession(); // la elección inicial (restaurada o deep-link) queda como punto de partida del próximo reload

  claudeConn = createTermConnection('term-claude', 'conn-claude', () => state.session);

  wireQuickKeys();
  wireSwitchers();
  wireTouchScroll('term-claude', () => claudeConn);
  wireImagePaste();
  wireComposer();
  wireSnippets();
  wireScrollback();
  wireHost();
  refreshSessions();
  refreshGit(); // primer fetch del badge de Cambios sin esperar el intervalo
  refreshHost(); // chip de batería + banner (tarea 17) sin esperar el intervalo

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
    claudeConn.sendVis(); // re-afirmar presencia (tarea 3): el server la expira a los 25 s
    refreshGit();
    refreshHost(); // el banner de batería tiene que aparecer sin interacción
    if (state.activeTab === 'claude') refreshSessions();
    if (state.activeTab === 'files') refreshTree(false); // sigue el cwd del pane: re-render solo si cambió la raíz
  }, 8000);

  document.addEventListener('visibilitychange', () => {
    // presencia (tarea 3): avisar también el pasaje a hidden — iOS congela la
    // página después de este evento, es la última chance de decir "no miro más"
    claudeConn.sendVis();
    if (document.visibilityState === 'visible') {
      refreshGit();
      refreshSessions();
      refreshHost();
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
