import { create } from 'zustand'
import { api } from './lib/api'
import { SESSION_NAME_RE } from './lib/keys'

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

// Formas que se completan en fases posteriores (sesiones: Fase 2, host: Fase 4,
// snippets: Fase 3). Se dejan tipadas laxo por ahora.
export type Session = { name: string; state?: string; [k: string]: unknown }
export type HostStatus = Record<string, unknown>

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
  hostStatus: HostStatus | null
  hostBannerDismissed: boolean
  snippets: string[] | null
  snippetsEditing: boolean

  // --- UI / overlays ---
  authError: boolean
  connected: boolean
  composerOpen: boolean
  scrollbackOpen: boolean
  hostSheetOpen: boolean
  switchMenu: SwitchMenuKind

  // --- acciones ---
  setActiveTab: (tab: Tab) => void
  setAuthError: (v: boolean) => void
  setSession: (name: string, persist?: boolean) => void
  refreshGit: () => Promise<void>
}

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
  hostStatus: null,
  hostBannerDismissed: false,
  snippets: null,
  snippetsEditing: false,

  authError: false,
  connected: false,
  composerOpen: false,
  scrollbackOpen: false,
  hostSheetOpen: false,
  switchMenu: null,

  setActiveTab: (tab) => {
    set({ activeTab: tab })
    // fit al volver a claude va en rAF (el DOM tiene que estar pintado antes de
    // medir); el terminal se cablea en Fase 2 vía window.claudeConn.
    if (tab === 'claude') requestAnimationFrame(() => window.claudeConn?.fit())
  },

  setAuthError: (v) => set({ authError: v }),

  setSession: (name, persist = true) => {
    set({ session: name })
    if (persist) persistActiveSession(name)
  },

  // app.js:1651-1672 (solo la parte que la Fase 1 necesita: el badge). El header
  // de rama y la lista de archivos los pinta ChangesView en la Fase 5.
  refreshGit: async () => {
    if (get().inDiff) return // no pisar la vista de diff
    try {
      const q = sessionQuery(get().session)
      let res = await api(`/api/git/summary${q ? `?${q}` : ''}`)
      if (!res.ok) res = await api('/api/git/summary') // fallback: sesión sin repo aún
      if (!res.ok) throw new Error('git summary failed')
      set({ git: (await res.json()) as GitSummary })
    } catch (e) {
      if (String((e as Error).message) !== '401') set({ git: null })
    }
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
