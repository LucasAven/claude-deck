import { useDeckStore } from '../store'

// fetch con manejo de 401 (app.js:1421-1436). En vez del showAuthError()
// imperativo que inyectaba un <div> al body, prende el flag authError del store
// y <AuthError/> pinta el mismo markup (#auth-error). Sigue tirando para que los
// callers corten como antes.
export async function api(path: string, opts?: RequestInit): Promise<Response> {
  const res = await fetch(path, { cache: 'no-store', ...opts })
  if (res.status === 401) {
    useDeckStore.getState().setAuthError(true)
    throw new Error('401')
  }
  return res
}
