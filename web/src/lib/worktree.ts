import { useDeckStore, sessionQuery } from '../store'
import { api } from './api'

// Worktree en un tap (tarea 5): long-press en el + abre el menú CREAR;
// "Nuevo worktree…" abre un bottom sheet que pega a POST /api/worktree — el
// server hace git worktree add + rama + sesión tmux, y acá solo queda
// selectSession(la sesión ya existe: sin create=1, el guard anti-resurrección
// ve created=false). El estado open vive en el store (componentes siempre
// montados, toggle hidden); el estado del formulario es local del sheet.

export function openCreateMenu() {
  useDeckStore.setState({ createMenuOpen: true })
}

export function closeCreateMenu() {
  if (useDeckStore.getState().createMenuOpen) useDeckStore.setState({ createMenuOpen: false })
}

export function openWorktreeSheet() {
  closeCreateMenu()
  useDeckStore.setState({ worktreeSheetOpen: true })
}

export function closeWorktreeSheet() {
  useDeckStore.setState({ worktreeSheetOpen: false })
}

// Despachar con prompt… (tarea 6): tercera entrada del menú CREAR. Mismo patrón
// que el worktree sheet — estado open en el store, formulario local del sheet.
export function openDispatchSheet() {
  closeCreateMenu()
  useDeckStore.setState({ dispatchSheetOpen: true })
}

export function closeDispatchSheet() {
  useDeckStore.setState({ dispatchSheetOpen: false })
}

// subdirectorios de primer nivel de WORKSPACES_ROOT (endpoint propio; /api/fs/list
// no sirve — sin session cae a DEFAULT_DIR y mezcla archivos)
export async function fetchWorkspaces(): Promise<string[] | null> {
  try {
    const res = await api('/api/workspaces')
    if (!res.ok) return null
    return ((await res.json()) as { dirs: string[] }).dirs
  } catch {
    return null
  }
}

// modo del agente → valor de --permission-mode. Autorun = 'auto' (elección de
// Lucas: más seguro que bypassPermissions).
export type DispatchMode = 'plan' | 'acceptEdits' | 'auto'
// modelo → alias de --model; '' = default del CLI (no se pasa la flag)
export type DispatchModel = '' | 'sonnet' | 'opus' | 'haiku'
// effort → nivel de --effort; '' = default del CLI (no se pasa la flag)
export type DispatchEffort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type DispatchResult = { ok: true; session: string } | { ok: false; error: string }

export async function dispatchAgent(
  dir: string,
  prompt: string,
  mode: DispatchMode,
  model: DispatchModel,
  effort: DispatchEffort,
): Promise<DispatchResult> {
  try {
    const res = await api('/api/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, prompt, mode, model, effort }),
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        msg = (await res.json()).error || msg
      } catch {
        /* sin body json */
      }
      return { ok: false, error: msg }
    }
    const data = (await res.json()) as { session: string }
    return { ok: true, session: data.session }
  } catch (e) {
    if (String((e as Error).message) === '401') return { ok: false, error: 'sesión expirada' }
    return { ok: false, error: 'error de red' }
  }
}

export interface BranchInfo {
  repo: string
  branches: string[]
  current: string
}

// ramas del repo de la sesión ACTIVA, para el dropdown "Basado en" (se fetchea
// al abrir el sheet, no en el poll: elección de Lucas — endpoint propio)
export async function fetchBranches(): Promise<BranchInfo | null> {
  try {
    const q = sessionQuery(useDeckStore.getState().session)
    const res = await api(`/api/git/branches${q ? `?${q}` : ''}`)
    if (!res.ok) return null
    return (await res.json()) as BranchInfo
  } catch {
    return null
  }
}

export type WorktreeResult = { ok: true; session: string } | { ok: false; error: string }

export async function createWorktree(branch: string, base: string): Promise<WorktreeResult> {
  try {
    const q = sessionQuery(useDeckStore.getState().session)
    const res = await api(`/api/worktree${q ? `?${q}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch, base }),
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        msg = (await res.json()).error || msg
      } catch {
        /* sin body json */
      }
      return { ok: false, error: msg }
    }
    const data = (await res.json()) as { session: string }
    return { ok: true, session: data.session }
  } catch (e) {
    if (String((e as Error).message) === '401') return { ok: false, error: 'sesión expirada' }
    return { ok: false, error: 'error de red' }
  }
}
