import { useDeckStore, sessionQuery } from '../store'
import { deck } from './api'

// Pestaña Archivos: árbol del directorio de la sesión, solo lectura, carga lazy
// por nivel (app.js:1787-2081). Este módulo tiene los fetch (/api/fs/list,
// /api/fs/file) y el registro del "refresher" del árbol: FilesView (siempre
// montado) registra su implementación real y el resto del código (poll, botón de
// refresh, fallback de sesión) la invoca sin acoplar — es el equivalente de
// window.claudeConn para el terminal.

export interface FsEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
}
export interface FsList {
  root: string
  entries: FsEntry[]
  truncated?: boolean
}
export interface FsFile {
  binary?: boolean
  content: string
  truncated?: boolean
  size: number
}

export async function fetchList(relPath: string): Promise<FsList> {
  return deck.get<FsList>('/api/fs/list', { session: true, params: relPath ? { path: relPath } : {} })
}

export async function fetchFile(rel: string): Promise<FsFile> {
  return deck.get<FsFile>('/api/fs/file', { session: true, params: { path: rel } })
}

// URL del byte crudo de una imagen del repo, para <img src> (tarea 16). La auth
// viaja en la cookie httpOnly existente — no hay que meter token en la query.
export function rawImageUrl(rel: string): string {
  return `/api/fs/raw?path=${encodeURIComponent(rel)}&${sessionQuery(useDeckStore.getState().session)}`
}

let treeRefresh: ((force: boolean) => Promise<void>) | null = null
let treeInvalidate: (() => void) | null = null

export function registerTree(refresh: (force: boolean) => Promise<void>, invalidate: () => void) {
  treeRefresh = refresh
  treeInvalidate = invalidate
}

// re-lista la raíz; el propio refresh decide no tocar el DOM si la raíz no cambió
export function refreshTree(force: boolean): Promise<void> {
  return treeRefresh ? treeRefresh(force) : Promise.resolve()
}

// marca el árbol como stale sin refetch: el fallback puede reusar el nombre de
// una sesión muerta, así que "la sesión no cambió" no alcanza para conservar el
// árbol — la próxima entrada a Archivos re-lista (app.js:1550).
export function invalidateTree() {
  treeInvalidate?.()
}

// puente para ui-test.mjs: espía el árbol con `await refreshTree(false)` (global)
if (typeof window !== 'undefined') window.refreshTree = refreshTree
