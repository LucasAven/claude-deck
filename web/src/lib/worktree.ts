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
