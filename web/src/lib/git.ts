import { useDeckStore, type GitFile } from '../store'
import { deck, AuthError } from './api'

// Acciones de la pestaña Cambios (app.js:1724-1776). refreshGit (que pinta el
// header + la lista + el badge) vive en el store; acá van el stage/unstage y el
// fetch del diff, que el componente dispara. El diff se renderiza con diff2html
// en ChangesView (dangerouslySetInnerHTML: salida de git ya escapada, §5.7).
// La sesión activa la adjunta deck ({ session: true }); el error del body lo
// extrae deck y lo tira como DeckError.

export async function stageFile(f: GitFile): Promise<void> {
  try {
    await deck.post('/api/git/stage', {
      session: true,
      body: { path: f.path, action: f.staged ? 'unstage' : 'stage' },
    })
  } catch (e) {
    if (!(e instanceof AuthError)) {
      window.alert(`No se pudo ${f.staged ? 'sacar del stage' : 'stagear'} ${f.path}: ${(e as Error).message}`)
    }
  }
  useDeckStore.getState().refreshGit()
}

// Commit + push (tarea 12): endpoints reales de escritura sobre el repo. El
// mensaje lo tipea Lucas (la app es un caño tonto: no genera mensajes). Ambos
// tiran con el mensaje del server para que el caller reporte qué paso falló.
export async function commitChanges(message: string): Promise<string> {
  const data = await deck.post<{ hash: string }>('/api/git/commit', { session: true, body: { message } })
  return data.hash
}

export async function pushChanges(): Promise<void> {
  await deck.post('/api/git/push', { session: true })
}

export async function fetchDiff(file: GitFile): Promise<string> {
  return deck.getText('/api/git/diff', { session: true, params: { path: file.path, staged: file.staged ? 1 : 0 } })
}

// Historial de commits (tarea 14). El endpoint /api/git/log ya existía (hash +
// subject); ahora trae autor/epoch/stats, y este es su primer consumidor.
export interface Commit {
  hash: string
  subject: string
  author: string
  ts: number
  add: number
  del: number
}

export async function fetchLog(n = 30): Promise<Commit[]> {
  return deck.get<Commit[]>('/api/git/log', { session: true, params: { n } })
}

export async function fetchShow(hash: string): Promise<string> {
  return deck.getText('/api/git/show', { session: true, params: { hash } })
}
