import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useDeckStore } from '../store'
import { api } from './api'

// Terminal + WebSocket con reconexión (backoff). Port LITERAL de
// createTermConnection + wireTouchScroll (public/app.js:45-278). TypeScript
// plano, sin React: la conexión es un singleton de módulo (nunca por render,
// §5.1). Único cambio de fondo vs. vanilla: los efectos DOM (setConn, showHint,
// guard anti-resurrección, fallback) se hacen contra el store en vez de tocar
// el DOM a mano; el resto — gen guard, backoff, resize solo-si-cambió, watchdog
// de resume, meta gone, anti-resurrección — se preserva byte a byte.

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
}

function createTermConnection(container: HTMLElement): ClaudeConn {
  const term = new Terminal({
    fontSize: 14,
    fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
    theme: XTERM_THEME,
    cursorBlink: true,
    scrollback: 3000,
    allowProposedApi: true,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(container)

  // shift+enter desde teclado físico (BT): xterm lo mandaría como \r (submit).
  // Traducirlo al newline suave de Claude Code (ESC+CR, ver KEYS.nl).
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.key === 'Enter' && ev.shiftKey) {
      if (ev.type === 'keydown' && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'in', d: '\x1b\r' }))
      }
      return false
    }
    return true
  })

  let ws: WebSocket | null = null
  let gen = 0 // generación de conexión: invalida handlers de sockets viejos
  let retries = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null // watchdog del refresh post-resume (detecta WS zombie)
  let wantedSession = getSession()
  let lastCols = 0
  let lastRows = 0

  const setConn = (on: boolean) => useDeckStore.getState().setConnected(on)

  function sendResize(force: boolean) {
    // solo si cambió: cada resize hace que tmux redibuje todo (flickering)
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!force && term.cols === lastCols && term.rows === lastRows) return
    lastCols = term.cols
    lastRows = term.rows
    ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
  }

  function doFit(force?: boolean) {
    try {
      fit.fit()
      sendResize(force === true)
    } catch { /* contenedor oculto */ }
  }

  function sendVis() {
    // presencia (tarea 3): el server suprime pushes de notify.sh mientras
    // alguna PWA esté visible en primer plano. Se manda al conectar, en cada
    // visibilitychange y re-afirmado en el poll de 8 s (TTL server: 25 s).
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ t: 'vis', visible: document.visibilityState === 'visible' }))
  }

  function connect() {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = null
    const myGen = ++gen
    if (ws) {
      // nunca dos attaches vivos por terminal: duplican el output (texto
      // "doblado") y pelean el tamaño del pane (flickering)
      const old = ws
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      try { old.close() } catch { /* ya cerrado */ }
    }
    wantedSession = getSession()
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    // create=1 solo cuando ESTE cliente pidió crear (botón +); la default la
    // permite el server. Un retry/resume nunca crea: si la sesión murió en
    // otro lado, el server contesta meta gone y caemos a una viva.
    const create = wantedSession === useDeckStore.getState().expectCreate ? '&create=1' : ''
    const url = `${proto}://${location.host}/ws/term?session=${encodeURIComponent(wantedSession ?? '')}${create}`
    const sock = new WebSocket(url)
    ws = sock

    sock.onopen = () => {
      if (myGen !== gen) return
      retries = 0
      setConn(true)
      sendVis()
      lastCols = 0
      lastRows = 0
      requestAnimationFrame(() => doFit(true))
    }

    sock.onmessage = (ev) => {
      if (myGen !== gen) return
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.t === 'out') {
        // llegó output: el socket está vivo, cancelar el watchdog de resume()
        if (refreshTimer) {
          clearTimeout(refreshTimer)
          refreshTimer = null
        }
        term.write(m.d)
      } else if (m.t === 'meta') {
        const store = useDeckStore.getState()
        if (m.gone) {
          // la sesión ya no existe (matada en otro tab/dispositivo, o reboot
          // de la Mac): no insistir con retries — caer a una sesión viva
          store.fallbackToLiveSession()
        } else if (m.created && m.session !== store.defaultSession && m.session !== store.expectCreate) {
          // Este cliente no pidió crear nada: la sesión fue matada en otro
          // tab/dispositivo y este reconnect la acaba de resucitar (attach-or-
          // create). Sin este guard, "borrar" una sesión la respawnea al toque
          // mientras haya otro cliente mirándola. Matarla de vuelta y caer a
          // una viva; la default queda exenta (recrearla siempre es deseado).
          api(`/api/tmux/sessions/${encodeURIComponent(m.session)}`, { method: 'DELETE' }).catch(() => {})
          store.fallbackToLiveSession()
        } else {
          useDeckStore.setState({ expectCreate: null })
          if (m.created) store.showHint()
        }
      }
    }

    sock.onclose = () => {
      if (myGen !== gen) return
      setConn(false)
      const delay = Math.min(1000 * 2 ** retries, 15000)
      retries++
      retryTimer = setTimeout(connect, delay)
    }
    sock.onerror = () => { try { sock.close() } catch { /* ya cerrado */ } }
  }

  term.onData((d) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d }))
  })

  connect()

  return {
    term,
    fit: doFit,
    sendKeys(d: string) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d }))
    },
    reconnect() {
      // cortar el attach actual y conectar a la sesión seleccionada
      term.reset()
      retries = 0
      connect()
    },
    sendVis,
    resume() {
      // al volver del background: si el WS murió, reconectar ya (sin backoff)
      if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        retries = 0
        connect()
        return
      }
      if (ws.readyState !== WebSocket.OPEN) return // CONNECTING: dejarlo terminar
      // El socket dice OPEN pero después de un freeze de iOS puede ser un
      // zombie, o el buffer de xterm puede haber quedado corrupto (tarea 11:
      // texto doblado/mezclado que solo se arreglaba abriendo el teclado,
      // porque el cambio de viewport forzaba un resize → repaint de tmux).
      // Pedir un repaint completo siempre; si no llega NINGÚN output en 2 s,
      // el socket estaba muerto → reconectar.
      doFit(true)
      try {
        ws.send(JSON.stringify({ t: 'refresh' }))
      } catch {
        retries = 0
        connect()
        return
      }
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        console.warn('[deck] sin output tras refresh post-resume: WS zombie, reconectando')
        retries = 0
        connect()
      }, 2000)
    },
    currentSession: () => wantedSession,
  }
}

// la sesión activa vive en el store; la conexión la lee fuera de React
function getSession(): string | null {
  return useDeckStore.getState().session
}

// ---------------------------------------------------------------------------
// Scroll táctil → eventos de rueda (SGR) hacia tmux
// tmux corre con `mouse on` (lo setea el server al crear/attachear), así que
// el terminal exterior siempre está en modo mouse-report: estas secuencias
// nunca llegan como texto al shell. Rueda arriba = tmux entra en copy-mode y
// muestra el historial (el scrollback de xterm está vacío bajo tmux).
export function wireTouchScroll(container: HTMLElement, getConn: () => ClaudeConn | undefined) {
  let lastY: number | null = null
  let acc = 0

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      lastY = e.touches[0].clientY
      acc = 0
    } else {
      lastY = null
    }
  }, { passive: true })

  container.addEventListener('touchmove', (e) => {
    const conn = getConn()
    if (lastY === null || !conn || e.touches.length !== 1) return
    e.preventDefault()
    const t = e.touches[0]
    acc += t.clientY - lastY
    lastY = t.clientY

    const rect = container.getBoundingClientRect()
    const rows = conn.term.rows || 24
    const cols = conn.term.cols || 80
    const rowH = rect.height / rows
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
    const col = clamp(Math.ceil((t.clientX - rect.left) / (rect.width / cols)), 1, cols)
    const row = clamp(Math.ceil((t.clientY - rect.top) / rowH), 1, rows)

    while (Math.abs(acc) >= rowH) {
      const up = acc > 0 // dedo hacia abajo = ver historial (rueda arriba)
      conn.sendKeys(`\x1b[<${up ? 64 : 65};${col};${row}M`)
      acc += up ? -rowH : rowH
    }
  }, { passive: false })

  container.addEventListener('touchend', () => { lastY = null })
  container.addEventListener('touchcancel', () => { lastY = null })
}

// Singleton de módulo: se crea una sola vez (lazy), nunca por render. Se expone
// como window.claudeConn — puente para ui-test.mjs, que espía claudeConn.sendKeys
// y claudeConn.term.paste (§5.9).
let singleton: ClaudeConn | null = null
export function getClaudeConn(container: HTMLElement): ClaudeConn {
  if (singleton) return singleton
  singleton = createTermConnection(container)
  window.claudeConn = singleton
  return singleton
}
