import { create } from 'zustand'
import { api } from './lib/api'
import { SESSION_NAME_RE } from './lib/keys'
import { closeSwitchMenu, loadSwitch } from './lib/switch'
import { closeComposer } from './lib/composer'
import { invalidateTree, refreshTree } from './lib/files'

// Estado global (zustand). El módulo de terminal/WS (Fase 2) lo lee fuera de
// React con useDeckStore.getState() y dispara updates sin prop-drilling — ver
// docs/REACT-PORT.md §1. La forma inicial sale de app.js:7-13 + §3.

export type Tab = 'claude' | 'changes' | 'files'
export type SwitchMenuKind = 'model' | 'attach' | 'snippets' | null

export interface GitFile {
  staged: boolean
  status: string
  path: string
}
export interface GitSummary {
  branch?: string
  ahead?: number
  behind?: number
  upstream?: string
  files: GitFile[]
}

// Chip de CI/PR (tarea 15): forma normalizada de `gh pr view`. null → sin PR /
// sin gh / sin remote (el chip no aparece). Se piggybackea en refreshGit.
export interface PrChecks {
  number: number
  title: string
  state: string
  checks: { total: number; passed: number; failed: number; pending: number }
  mergeable: string
}

// Formas que se completan en fases posteriores (sesiones: Fase 2,
// snippets: Fase 3). Se dejan tipadas laxo por ahora.
export type Session = { name: string; state?: string; [k: string]: unknown }

// Estado del host (GET /api/host/status, server/index.ts:989-995). El chip y el
// banner de batería solo existen si `battery` no es null (Mac de escritorio o
// pmset ilegible → null).
export interface HostBattery {
  pct: number
  state: string
}
export interface HostAlert {
  enabled: boolean
  threshold: number
}
export interface HostStatus {
  name: string | null
  battery: HostBattery | null
  ac: boolean | null
  sleepDisabled: boolean | null
  uptime: number
  alert: HostAlert
}

// Scrollback legible (app.js:1088-1231): parte reactiva del overlay. El modo
// 'turns' pinta los turnos del transcript (asistente como markdown sanitizado),
// 'text' el capture-pane crudo. El resto del estado del fetch (bytes/líneas
// pedidas, techo) es module-level en lib/scrollback.ts.
export interface SbTurn {
  role: 'user' | 'tool' | 'assistant'
  html: string | null // markdown sanitizado del asistente; null → usar text plano
  text: string
}
export interface ScrollbackState {
  session: string | null
  mode: 'turns' | 'text'
  srcLabel: string // '· transcript' | '· pane' | ''
  turns: SbTurn[]
  text: string
  moreVisible: boolean
  font: number // px, persistido en deck-sb-font (10-20)
  renderNonce: number // bump por pintada → dispara el restore del ancla de lectura
}

// Chip de preview de imagen (app.js:498-524): la parte reactiva (thumb/título/
// meta/pending) vive acá; el blob pendiente y los timers son module-level en
// lib/image.ts. La `url` es un objectURL que ese módulo revoca al reemplazar/cerrar.
export interface ImgChip {
  url: string
  title: string
  meta: string
  pending: boolean
}

// Tooltip de texto completo de un snippet (app.js:891-903): lo pinta <SnipTip/>
// leyendo esta forma; la lib/sniptip lo setea con el rect del chip para posicionar.
export interface SnipTipState {
  text: string
  rect: DOMRect
}

// Modelo/esfuerzo elegidos, por sesión (deck-switch:<sesión>, app.js:361-376).
// Se recarga en cada cambio de sesión para que las pills muestren lo correcto.
export interface SwitchState {
  model?: string
  effort?: string
}

const ACTIVE_SESSION_KEY = 'deck-active-session'

interface DeckStore {
  // --- núcleo (app.js:7-13) ---
  defaultSession: string
  session: string | null
  expectCreate: string | null
  activeTab: Tab
  inDiff: boolean

  // --- datos del server ---
  sessions: Session[]
  git: GitSummary | null
  gitNoRepo: boolean // el dir de la sesión existe pero no es repo git (distinto de "sin datos")
  gitChecks: PrChecks | null // chip de CI/PR (tarea 15); null → sin chip
  hostStatus: HostStatus | null
  hostBannerDismissed: boolean
  snippets: string[] | null
  snippetsEditing: boolean

  // --- UI / overlays ---
  authError: boolean
  connected: boolean
  hintOpen: boolean
  composerOpen: boolean
  composerSession: string | null
  composerSnipsOpen: boolean
  draftSaved: boolean
  scrollbackOpen: boolean
  scrollback: ScrollbackState
  hostSheetOpen: boolean
  createMenuOpen: boolean
  worktreeSheetOpen: boolean
  dispatchSheetOpen: boolean
  switchMenu: SwitchMenuKind
  switchState: SwitchState
  imgChip: ImgChip | null
  snipTip: SnipTipState | null
  // Web Push (tarea 23): estado del opt-in de notificaciones nativas de la PWA.
  // 'unsupported' → el browser no tiene SW/PushManager (oculta el botón);
  // 'off' → soportado, no suscripto; 'on' → suscripto; 'denied' → permiso
  // rechazado por el usuario (no se puede re-pedir sin ir a ajustes).
  pushState: 'unsupported' | 'off' | 'on' | 'denied'

  // --- acciones ---
  setActiveTab: (tab: Tab) => void
  setPushState: (v: 'unsupported' | 'off' | 'on' | 'denied') => void
  setAuthError: (v: boolean) => void
  setSession: (name: string, persist?: boolean) => void
  setSwitchState: (sw: SwitchState) => void
  refreshGit: () => Promise<void>

  // --- terminal + sesiones (Fase 2) ---
  setConnected: (on: boolean) => void
  showHint: () => void
  hideHint: () => void
  refreshSessions: () => Promise<void>
  selectSession: (name: string) => void
  killSession: (name: string) => Promise<void>
  renameSession: (name: string) => Promise<void>
  createSession: () => Promise<void>
  fallbackToLiveSession: () => Promise<void>
}

// Caer a otra sesión viva: la default si existe (se recrea vacía si no queda
// ninguna), si no la primera de la lista. app.js:1612-1617.
function nextSessionName(existing: string[], base: string): string {
  let n = 2
  while (existing.includes(`${base}-${n}`)) n++
  return `${base}-${n}`
}

// timer del hint de sesión nueva: module-level como el hintTimer de app.js:285.
let hintTimer: ReturnType<typeof setTimeout> | null = null

// query de sesión para los endpoints con repo (app.js:1635-1637)
export function sessionQuery(session: string | null): string {
  return session ? `session=${encodeURIComponent(session)}` : ''
}

// la sesión activa se persiste para sobrevivir al reload (app.js:17-24): sin
// esto init() vuelve siempre a la default, y como el server la recrea si no
// existe, renombrarla y recargar spawneaba un "deck" vacío fantasma.
function persistActiveSession(name: string | null) {
  try {
    if (name) localStorage.setItem(ACTIVE_SESSION_KEY, name)
  } catch {
    /* localStorage puede fallar (modo privado) — no es crítico */
  }
}

export const useDeckStore = create<DeckStore>((set, get) => ({
  defaultSession: 'deck',
  session: null,
  expectCreate: null,
  activeTab: 'claude',
  inDiff: false,

  sessions: [],
  git: null,
  gitNoRepo: false,
  gitChecks: null,
  hostStatus: null,
  hostBannerDismissed: false,
  snippets: null,
  snippetsEditing: false,

  authError: false,
  connected: false,
  hintOpen: false,
  composerOpen: false,
  composerSession: null,
  composerSnipsOpen: false,
  draftSaved: false,
  scrollbackOpen: false,
  scrollback: {
    session: null,
    mode: 'text',
    srcLabel: '',
    turns: [],
    text: '',
    moreVisible: false,
    font: 13,
    renderNonce: 0,
  },
  hostSheetOpen: false,
  createMenuOpen: false,
  worktreeSheetOpen: false,
  dispatchSheetOpen: false,
  switchMenu: null,
  switchState: {},
  imgChip: null,
  snipTip: null,
  pushState: 'unsupported',

  setPushState: (v) => set({ pushState: v }),

  setActiveTab: (tab) => {
    set({ activeTab: tab })
    // fit al volver a claude va en rAF (el DOM tiene que estar pintado antes de
    // medir); el terminal se cablea en Fase 2 vía window.claudeConn.
    if (tab === 'claude') requestAnimationFrame(() => window.claudeConn?.fit())
  },

  setAuthError: (v) => set({ authError: v }),

  setSession: (name, persist = true) => {
    // switchState sale de deck-switch:<sesión>: las pills tienen que mostrar el
    // modelo/esfuerzo de ESTA sesión ya en el arranque (app.js:473 renderSwitchPills).
    set({ session: name, switchState: loadSwitch(name) })
    if (persist) persistActiveSession(name)
  },

  setSwitchState: (sw) => set({ switchState: sw }),

  // app.js:1651-1672. El header de rama y la lista de archivos los pinta
  // ChangesView; el badge sale de git.files.length.
  refreshGit: async () => {
    if (get().inDiff) return // no pisar la vista de diff
    try {
      const q = sessionQuery(get().session)
      let res = await api(`/api/git/summary${q ? `?${q}` : ''}`)
      // Caer al repo default SOLO si la sesión no existe todavía (404: recién
      // creada / aún sin dir). Si el dir existe pero NO es repo git (400), NO
      // caer: mostraría los cambios de OTRO repo (el default) cuando la sesión
      // está parada en un directorio sin git — se avisa con gitNoRepo.
      if (!res.ok && res.status === 404 && q) res = await api('/api/git/summary')
      if (res.ok) {
        set({ git: (await res.json()) as GitSummary, gitNoRepo: false })
        // Chip de CI/PR (tarea 15): piggyback tras un summary OK. Degradación
        // silenciosa — cualquier error deja gitChecks en null (sin chip).
        api(`/api/git/checks${q ? `?${q}` : ''}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => set({ gitChecks: (j?.pr as PrChecks) ?? null }))
          .catch(() => set({ gitChecks: null }))
        return
      }
      if (res.status === 400) {
        set({ git: null, gitNoRepo: true, gitChecks: null }) // dir sin git → mensaje propio en ChangesView
        return
      }
      throw new Error(`git summary ${res.status}`)
    } catch (e) {
      if (String((e as Error).message) !== '401') set({ git: null, gitNoRepo: false })
    }
  },

  // -------------------------------------------------------------------------
  // Terminal + sesiones (Fase 2). El indicador #conn-claude sale de este flag;
  // la conexión (lib/term.ts) lo setea vía callback (app.js:80).
  setConnected: (on) => set({ connected: on }),

  // Hint de sesión nueva (app.js:285-296): timer de 15 s + fit en rAF (le come
  // filas a la terminal, hay que re-medir cuando aparece/desaparece — §5.5).
  showHint: () => {
    set({ hintOpen: true })
    if (hintTimer) clearTimeout(hintTimer)
    hintTimer = setTimeout(() => get().hideHint(), 15000)
    requestAnimationFrame(() => window.claudeConn?.fit())
  },
  hideHint: () => {
    if (hintTimer) clearTimeout(hintTimer)
    hintTimer = null
    set({ hintOpen: false })
    requestAnimationFrame(() => window.claudeConn?.fit())
  },

  // Chips de sesiones (app.js:1443-1498). React reconcilia el DOM, así que el
  // chipsKey anti-parpadeo ya no hace falta; guardamos la lista normalizada
  // {name, state} (ordenada, con la sesión activa siempre presente) y la pinta
  // SessionRow. El .state es el semáforo escrito por los hooks (null → sin punto).
  refreshSessions: async () => {
    let sessions: Session[] = []
    try {
      sessions = (await (await api('/api/tmux/sessions')).json()) as Session[]
    } catch {
      return
    }
    const names = sessions.map((s) => s.name)
    const cur = get().session
    if (cur && !names.includes(cur)) names.push(cur)
    names.sort()
    const stateByName: Record<string, string | undefined> = {}
    for (const s of sessions) stateByName[s.name] = (s.state as string) || undefined
    set({ sessions: names.map((n) => ({ name: n, state: stateByName[n] })) })
  },

  // app.js:1500-1512. Persistir, cerrar hint/menú/composer (guardando el
  // borrador de la sesión saliente), reconectar el WS a la nueva sesión y
  // refrescar git/sessions. (Fase 5: refreshTree si tab=files.)
  selectSession: (name) => {
    if (name === get().session) return
    closeComposer() // guarda el borrador de la sesión actual antes de cambiarla
    closeSwitchMenu()
    set({ session: name, switchState: loadSwitch(name) })
    persistActiveSession(name)
    get().hideHint()
    window.claudeConn?.reconnect()
    get().refreshSessions()
    get().refreshGit()
  },

  // app.js:1514-1531. El estado de switchers y el borrador del composer son por
  // sesión: mueren con ella. Si mataron la activa, caer a una viva.
  killSession: async (name) => {
    if (!window.confirm(`¿Matar la sesión "${name}"? Se cierra lo que esté corriendo adentro.`)) return
    try {
      await api(`/api/tmux/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' })
    } catch {
      return
    }
    try {
      localStorage.removeItem(`deck-switch:${name}`)
      localStorage.removeItem(`draft:${name}`)
    } catch {
      /* ignore */
    }
    if (get().session === name) await get().fallbackToLiveSession()
    else get().refreshSessions()
  },

  // app.js:1557-1610. El attach tmux sobrevive al rename (tmux no desconecta
  // clientes): NO se reconecta el WS, solo se actualiza el nombre con el que
  // habla la API y se migran las keys por-sesión de localStorage.
  renameSession: async (name) => {
    const input = window.prompt('Nuevo nombre para la sesión:', name)
    if (input === null) return
    const newName = input.trim()
    if (!newName || newName === name) return
    if (!SESSION_NAME_RE.test(newName) || newName.endsWith('-shell')) {
      alert('Nombre inválido: letras, números, "-" y "_" (máx 32), sin terminar en -shell')
      return
    }
    try {
      const res = await api(`/api/tmux/sessions/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newName }),
      })
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          msg = (await res.json()).error || msg
        } catch {
          /* sin body json */
        }
        alert(`No se pudo renombrar: ${msg}`)
        return
      }
    } catch {
      return
    }

    if (get().session === name) {
      set({ session: newName })
      persistActiveSession(newName) // sin esto un reload vuelve al nombre viejo (y recrea la default vacía)
      try {
        // el estado de switchers y el borrador del composer se guardan por
        // sesión: migrarlos al nuevo nombre
        const moves: [string, string][] = [
          [`deck-switch:${name}`, `deck-switch:${newName}`],
          [`draft:${name}`, `draft:${newName}`],
        ]
        for (const [oldKey, newKey] of moves) {
          const val = localStorage.getItem(oldKey)
          if (val !== null) {
            localStorage.setItem(newKey, val)
            localStorage.removeItem(oldKey)
          }
        }
      } catch {
        /* ignore */
      }
      // recargar las pills desde la key ya migrada
      set({ switchState: loadSwitch(newName) })
      // si el composer está abierto para esta sesión, que siga al nombre nuevo
      // (el WS no se reconecta: el attach tmux sobrevive al rename)
      if (get().composerSession === name) set({ composerSession: newName })
    }
    get().refreshSessions()
    get().refreshGit()
  },

  // app.js:1619-1628. Creación pedida por el usuario (botón +): expectCreate
  // exime al guard anti-resurrección, así el attach con create=1 la levanta.
  createSession: async () => {
    let existing: string[] = []
    try {
      existing = ((await (await api('/api/tmux/sessions')).json()) as Session[]).map((s) => s.name)
    } catch {
      /* sin lista: nextSessionName arranca en base-2 igual */
    }
    const cur = get().session
    if (cur && !existing.includes(cur)) existing.push(cur)
    const name = nextSessionName(existing, get().defaultSession)
    set({ expectCreate: name })
    get().selectSession(name)
  },

  // app.js:1535-1553. La default si existe (se recrea vacía si no queda
  // ninguna); si no, la primera viva. Usado al matar la activa y por el guard
  // anti-resurrección.
  fallbackToLiveSession: async () => {
    let names: string[] = []
    try {
      names = ((await (await api('/api/tmux/sessions')).json()) as Session[]).map((s) => s.name)
    } catch {
      /* sin lista: cae a la default */
    }
    const def = get().defaultSession
    const next = names.includes(def) ? def : names[0] || def
    closeComposer()
    closeSwitchMenu()
    set({ session: next, switchState: loadSwitch(next) })
    persistActiveSession(next)
    get().hideHint()
    window.claudeConn?.reconnect()
    get().refreshGit()
    // el fallback puede reusar el nombre de una sesión muerta: marcar el árbol
    // stale para que se re-liste aunque la sesión "no cambió" (app.js:1550)
    invalidateTree()
    if (get().activeTab === 'files') refreshTree(false)
    get().refreshSessions()
  },
}))

// Restaura la sesión inicial (app.js:2122-2156): config del server, luego la
// guardada en localStorage, luego el deep-link ?session= (que se saca de la URL).
// Se llama una vez al arranque desde App.
export async function restoreInitialSession() {
  const { setSession } = useDeckStore.getState()

  let def = 'deck'
  try {
    const cfg = await (await api('/api/config')).json()
    def = cfg.session || 'deck'
  } catch {
    /* sin config: queda el default */
  }
  useDeckStore.setState({ defaultSession: def })
  let session = def

  // última sesión activa: si la guardada ya no existe, el attach sin create=1
  // contesta meta gone y el fallback cae a una viva (Fase 2) — nunca resucita.
  try {
    const saved = localStorage.getItem(ACTIVE_SESSION_KEY)
    if (saved && SESSION_NAME_RE.test(saved) && !saved.endsWith('-shell')) {
      session = saved
    }
  } catch {
    /* ignore */
  }

  // deep-link del push: ?session=<name> antes del primer attach; el param se
  // saca de la URL para que un reload manual no pinee una sesión vieja.
  try {
    const qs = new URLSearchParams(location.search)
    const wanted = qs.get('session')
    if (wanted !== null) {
      if (SESSION_NAME_RE.test(wanted) && !wanted.endsWith('-shell')) {
        session = wanted
      }
      qs.delete('session')
      const rest = qs.toString()
      history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''))
    }
  } catch {
    /* ignore */
  }

  setSession(session) // la elección inicial queda como punto de partida del próximo reload
}

// puente para ui-test.mjs: el test mockea fetch y llama refreshSessions()
// (global) para probar el semáforo de chips, igual que en el vanilla
if (typeof window !== 'undefined') {
  window.refreshSessions = () => useDeckStore.getState().refreshSessions()
}
