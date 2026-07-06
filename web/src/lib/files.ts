import { useDeckStore, sessionQuery } from '../store'
import { api } from './api'

// Pestaña Archivos: árbol del directorio de la sesión, solo lectura, carga lazy
// por nivel (app.js:1787-2081). Este módulo tiene los fetch (/api/fs/list,
// /api/fs/file) y el registro del "refresher" del árbol: FilesView (siempre
// montado) registra su implementación real y el resto del código (poll, botón de
// refresh, fallback de sesión) la invoca sin acoplar — es el equivalente de
// window.claudeConn para el terminal.

export interface FsEntry {
  name: string
  type: 'dir' | 'file'
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
  const q = relPath ? `path=${encodeURIComponent(relPath)}&` : ''
  const res = await api(`/api/fs/list?${q}${sessionQuery(useDeckStore.getState().session)}`)
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error((err && err.error) || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function fetchFile(rel: string): Promise<FsFile> {
  const res = await api(`/api/fs/file?path=${encodeURIComponent(rel)}&${sessionQuery(useDeckStore.getState().session)}`)
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error((err && err.error) || `HTTP ${res.status}`)
  }
  return res.json()
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
