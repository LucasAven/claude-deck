import { useDeckStore } from '../store'
import { deck, errText } from './api'

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
  return deck.get<ProjSession[]>('/api/tmux/sessions')
}

interface WorkspacesResp {
  roots?: { root: string; dirs: string[] }[]
}

// Raices del perimetro (WORKSPACES_ROOTS): las usamos para etiquetar cada
// proyecto con la raiz que lo contiene (desambigua homonimos en raices
// distintas). Degradacion silenciosa: sin raices, ProjectsView cae al dirname.
export async function fetchWorkspaceRoots(): Promise<string[]> {
  try {
    const data = await deck.get<WorkspacesResp>('/api/workspaces')
    return (data.roots || []).map((r) => r.root)
  } catch {
    return []
  }
}

export type CdResult = { ok: true } | { ok: false; error: string }

// "cd acá" (tarea 40) desde la tab Proyectos: manda cd al pane de una sesion en
// shell pelado. El gate visual ([cd] deshabilitado con candado cuando hay claude
// corriendo) evita el 409, pero igual manejamos el error del server.
export async function sessionCd(session: string, path: string): Promise<CdResult> {
  try {
    await deck.post('/api/session/cd', { body: { session, path } })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errText(e) }
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
    const data = await deck.post<{ session: string; dir: string }>('/api/session/new', {
      body: { path, hideStatus: useDeckStore.getState().hideTmuxStatus },
    })
    return { ok: true, session: data.session, dir: data.dir }
  } catch (e) {
    return { ok: false, error: errText(e) }
  }
}

// Pins + recientes (tarea 42) + default (tarea 43), fuente de las secciones
// PINNEADOS/RECIENTES. El server ya filtra rutas que dejaron de existir o de
// estar dentro de la unión (dirStillValid en GET /api/dirs). `defaultDir` viene
// EFECTIVO (nunca vacío): el elegido desde acá o el fallback del .env.
export interface DirsResp {
  pins: string[]
  recent: string[]
  defaultDir: string
}

export async function fetchDirs(): Promise<DirsResp> {
  return deck.get<DirsResp>('/api/dirs')
}

export type PinResult = { ok: true } | { ok: false; error: string }

// Reemplaza la lista completa de pins (PUT /api/dirs, todo o nada: el server
// valida cada ruta y devuelve 400 si alguna no cierra).
export async function setPins(pins: string[]): Promise<PinResult> {
  try {
    await deck.put('/api/dirs', { body: { pins } })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errText(e) }
  }
}

// pin/unpin (estrella de una carpeta, tarea 42): GET la lista actual, agrega o
// saca el dir, PUT la lista entera. No hay endpoint incremental: el server solo
// expone el reemplazo completo (mismo patrón que snippets).
export async function pin(dir: string): Promise<PinResult> {
  try {
    const current = await fetchDirs()
    if (current.pins.includes(dir)) return { ok: true }
    return await setPins([...current.pins, dir])
  } catch (e) {
    return { ok: false, error: errText(e) }
  }
}

export async function unpin(dir: string): Promise<PinResult> {
  try {
    const current = await fetchDirs()
    return await setPins(current.pins.filter((p) => p !== dir))
  } catch (e) {
    return { ok: false, error: errText(e) }
  }
}

// "Hacer default" (tarea 43): el dir donde el "+" de la fila de chips pare las
// sesiones nuevas. PUT por clave presente: mandar solo `defaultDir` NO pisa los
// pins (ni al revés), así que no hace falta el read-modify-write de pin/unpin.
// Devuelve el default efectivo ya resuelto por el server, que el caller espeja
// en el store para que el "+" lo use sin re-fetchear.
export async function setDefaultDir(dir: string): Promise<{ ok: true; defaultDir: string } | { ok: false; error: string }> {
  try {
    const data = await deck.put<{ defaultDir: string }>('/api/dirs', { body: { defaultDir: dir } })
    return { ok: true, defaultDir: data.defaultDir }
  } catch (e) {
    return { ok: false, error: errText(e) }
  }
}

interface BrowseResp {
  path: string
  dirs: string[]
}

// Subdirectorios inmediatos de un path absoluto dentro de la unión (tarea 42,
// árbol shallow lazy de EXPLORAR): solo nombres, el caller arma el join.
export async function browseDir(path: string): Promise<string[]> {
  const data = await deck.get<BrowseResp>('/api/dirs/browse', { params: { path } })
  return data.dirs
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
