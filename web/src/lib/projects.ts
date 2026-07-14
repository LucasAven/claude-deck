import { useDeckStore } from '../store'
import { api } from './api'

// Tab Proyectos (tarea 41). La lista de sesiones que consume ProjectsView es mas
// rica que la del store (que ProjectRow de chips normaliza a {name, state}): acá
// necesitamos el dir del pane y el flag claudeRunning que agrega
// tmuxListSessions. Por eso ProjectsView fetchea su propia copia cruda de
// /api/tmux/sessions en vez de leer store.sessions.

export interface ProjSession {
  name: string
  dir: string
  attached: boolean
  claudeRunning: boolean
  state?: string | null
}

export async function fetchProjectSessions(): Promise<ProjSession[]> {
  const res = await api('/api/tmux/sessions')
  if (!res.ok) throw new Error(`sessions ${res.status}`)
  return (await res.json()) as ProjSession[]
}

interface WorkspacesResp {
  roots?: { root: string; dirs: string[] }[]
}

// Raices del perimetro (WORKSPACES_ROOTS): las usamos para etiquetar cada
// proyecto con la raiz que lo contiene (desambigua homonimos en raices
// distintas). Degradacion silenciosa: sin raices, ProjectsView cae al dirname.
export async function fetchWorkspaceRoots(): Promise<string[]> {
  try {
    const res = await api('/api/workspaces')
    if (!res.ok) return []
    const data = (await res.json()) as WorkspacesResp
    return (data.roots || []).map((r) => r.root)
  } catch {
    return []
  }
}

async function errMsg(res: Response): Promise<string> {
  let msg = `HTTP ${res.status}`
  try {
    msg = (await res.json()).error || msg
  } catch {
    /* sin body json */
  }
  return msg
}

export type CdResult = { ok: true } | { ok: false; error: string }

// "cd acá" (tarea 40) desde la tab Proyectos: manda cd al pane de una sesion en
// shell pelado. El gate visual ([cd] deshabilitado con candado cuando hay claude
// corriendo) evita el 409, pero igual manejamos el error del server.
export async function sessionCd(session: string, path: string): Promise<CdResult> {
  try {
    const res = await api('/api/session/cd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, path }),
    })
    if (!res.ok) return { ok: false, error: await errMsg(res) }
    return { ok: true }
  } catch (e) {
    if (String((e as Error).message) === '401') return { ok: false, error: 'sesión expirada' }
    return { ok: false, error: 'error de red' }
  }
}

export type NewSessionResult = { ok: true; session: string; dir: string } | { ok: false; error: string }

// "[+ nueva sesion aca]" (tarea 41): crea una sesion PELADA (shell, NO lanza
// claude) enraizada en el dir del proyecto. Honra la pref hideStatus igual que
// dispatchAgent. La sesion existe server-side al volver (new-session -d
// awaiteado), asi que el caller hace selectSession pelado: el guard
// anti-resurreccion ve created=false (la sesion no fue matada y resucitada).
export async function newSession(path: string): Promise<NewSessionResult> {
  try {
    const res = await api('/api/session/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, hideStatus: useDeckStore.getState().hideTmuxStatus }),
    })
    if (!res.ok) return { ok: false, error: await errMsg(res) }
    const data = (await res.json()) as { session: string; dir: string }
    return { ok: true, session: data.session, dir: data.dir }
  } catch (e) {
    if (String((e as Error).message) === '401') return { ok: false, error: 'sesión expirada' }
    return { ok: false, error: 'error de red' }
  }
}

// name del proyecto = basename del dir del pane.
export function projName(dir: string): string {
  if (!dir) return '(sin directorio)'
  const parts = dir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || dir
}

// Colapsa el home a ~ (cosmetico, como el mockup): las rutas del perimetro son
// absolutas (/Users/<user>/... o /home/<user>/...). No hace falta conocer el
// home real: la etiqueta es solo para leer de un vistazo donde vive el proyecto.
function collapseHome(p: string): string {
  return p.replace(/^\/(Users|home)\/[^/]+/, '~')
}

// Etiqueta de raiz junto al nombre (mockup "claude-deck  ~/Desktop/projects"):
// la raiz del perimetro que contiene el dir, mas el subcamino relativo del PADRE
// (para un dir que no es hijo directo de la raiz). Fuera de la union (una sesion
// que hizo cd afuera) cae a la ruta absoluta colapsada del padre.
export function projRootLabel(dir: string, roots: string[]): string {
  if (!dir) return ''
  const root = roots.find((r) => dir === r || dir.startsWith(r + '/'))
  if (!root) {
    // fuera de la union: mostrar el padre absoluto colapsado
    const parent = dir.slice(0, dir.lastIndexOf('/')) || '/'
    return collapseHome(parent)
  }
  const rel = dir === root ? '' : dir.slice(root.length + 1)
  const relParent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  return collapseHome(root) + (relParent ? '/' + relParent : '')
}

// Puente para ui-test.mjs: el test mockea fetch y llama este refresher global
// para repintar la lista agrupada, igual que refreshSessions/refreshHost. Lo
// registra ProjectsView al montar (el componente vive siempre montado).
let projectsRefresher: (() => Promise<void>) | null = null
export function registerProjectsRefresh(fn: () => Promise<void>): () => void {
  projectsRefresher = fn
  return () => {
    if (projectsRefresher === fn) projectsRefresher = null
  }
}
if (typeof window !== 'undefined') {
  window.refreshProjects = () => projectsRefresher?.() ?? Promise.resolve()
}
