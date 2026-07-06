import { useDeckStore, sessionQuery, type GitFile } from '../store'
import { api } from './api'

// Acciones de la pestaña Cambios (app.js:1724-1776). refreshGit (que pinta el
// header + la lista + el badge) vive en el store; acá van el stage/unstage y el
// fetch del diff, que el componente dispara. El diff se renderiza con diff2html
// en ChangesView (dangerouslySetInnerHTML: salida de git ya escapada, §5.7).

export async function stageFile(f: GitFile): Promise<void> {
  const q = sessionQuery(useDeckStore.getState().session)
  try {
    const res = await api(`/api/git/stage?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: f.path, action: f.staged ? 'unstage' : 'stage' }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      throw new Error(err?.error || `HTTP ${res.status}`)
    }
  } catch (e) {
    if (String((e as Error).message) !== '401') {
      window.alert(`No se pudo ${f.staged ? 'sacar del stage' : 'stagear'} ${f.path}: ${(e as Error).message}`)
    }
  }
  useDeckStore.getState().refreshGit()
}

export async function fetchDiff(file: GitFile): Promise<string> {
  const q = `path=${encodeURIComponent(file.path)}&staged=${file.staged ? 1 : 0}&${sessionQuery(useDeckStore.getState().session)}`
  const res = await api(`/api/git/diff?${q}`)
  if (!res.ok) throw new Error(await res.text())
  return res.text()
}
