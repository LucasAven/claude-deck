import { useDeckStore } from '../store'

// Cliente del panel: el único seam entre la PWA y el server. Antes era api(), un
// wrapper shallow de fetch que solo manejaba el 401 y tiraba `new Error('401')`;
// cada caller re-armaba querystring + sesión, extraía el error del body a su
// manera (3 dialectos) y comparaba el string mágico '401'. Ahora deck.get/post/…
// concentra todo eso: adjunta la sesión activa (opt-in), serializa el body,
// extrae el mensaje del body en un solo lugar y tira errores TIPADOS.

// 401: la sesión (cookie httpOnly / token del proxy dev) caducó. deck prende el
// flag authError del store (que pinta <AuthError/> = #auth-error) y tira. Los
// callers cortan con `e instanceof AuthError` en vez del viejo `msg === '401'`.
// message queda en '401' como red de seguridad para cualquier check no migrado.
export class AuthError extends Error {
  constructor() {
    super('401')
    this.name = 'AuthError'
  }
}

// Cualquier respuesta no-ok que no sea 401. message = error del body (json
// `.error`, o texto crudo, o `HTTP <status>`); status queda expuesto para los
// pocos callers que ramifican por código (refreshGit: 404 → repo default, 400 →
// dir sin git).
export class DeckError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'DeckError'
    this.status = status
  }
}

export interface DeckOpts {
  method?: string
  // objeto → JSON.stringify + content-type json; string/Blob/ArrayBuffer → tal
  // cual (ej: paste-image manda el PNG con su propio content-type)
  body?: unknown
  headers?: Record<string, string>
  // valores → querystring (encodeURIComponent). null/undefined se omiten.
  params?: Record<string, string | number | boolean | null | undefined>
  // true → adjunta la sesión activa del store; string → esa sesión. Opt-in: no
  // todos los endpoints llevan sesión (tmux/sessions, dirs, host/*, snippets…).
  session?: boolean | string
}

// Núcleo: arma url + init, hace fetch, maneja SOLO el 401. Devuelve la Response
// cruda; los helpers de abajo chequean res.ok y parsean. Público para el puñado
// de callers que necesitan inspeccionar la Response sin tirar (status, fire-and-
// forget); esos usan deck.raw().
async function request(path: string, opts: DeckOpts = {}): Promise<Response> {
  const qs = new URLSearchParams()
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) if (v != null) qs.set(k, String(v))
  }
  if (opts.session) {
    const name = opts.session === true ? useDeckStore.getState().session : opts.session
    if (name) qs.set('session', name)
  }
  const q = qs.toString()
  const url = q ? `${path}${path.includes('?') ? '&' : '?'}${q}` : path

  const init: RequestInit = { cache: 'no-store' }
  if (opts.method) init.method = opts.method
  if (opts.headers) init.headers = opts.headers
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string' || opts.body instanceof Blob || opts.body instanceof ArrayBuffer) {
      init.body = opts.body as BodyInit
    } else {
      init.body = JSON.stringify(opts.body)
      init.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
    }
  }

  const res = await fetch(url, init)
  if (res.status === 401) {
    useDeckStore.getState().setAuthError(true)
    throw new AuthError()
  }
  return res
}

// Extrae el mensaje de una Response no-ok, unificando los 3 dialectos viejos:
// json `.error` (git/stage, fs/list, host…), texto crudo (git/diff, git/show), o
// el fallback `HTTP <status>` (endpoints que devuelven body vacío).
async function deckError(res: Response): Promise<DeckError> {
  let msg = `HTTP ${res.status}`
  try {
    const txt = await res.text()
    if (txt) {
      try {
        msg = JSON.parse(txt).error || txt
      } catch {
        msg = txt // no era json: el texto crudo es el mensaje
      }
    }
  } catch {
    /* body ilegible: queda el HTTP <status> */
  }
  return new DeckError(msg, res.status)
}

// Mapea un error de deck al string de un Result { ok:false, error } de la PWA,
// reproduciendo el trío viejo: 401 → 'sesión expirada', respuesta con body →
// mensaje del server, fallo de red → 'error de red'.
export function errText(e: unknown): string {
  if (e instanceof AuthError) return 'sesión expirada'
  if (e instanceof DeckError) return e.message
  return 'error de red'
}

export const deck = {
  async get<T = unknown>(path: string, opts: DeckOpts = {}): Promise<T> {
    const res = await request(path, { ...opts, method: 'GET' })
    if (!res.ok) throw await deckError(res)
    return res.json() as Promise<T>
  },

  // respuestas de texto plano (diffs, capture-pane): sin parseo json
  async getText(path: string, opts: DeckOpts = {}): Promise<string> {
    const res = await request(path, { ...opts, method: 'GET' })
    if (!res.ok) throw await deckError(res)
    return res.text()
  },

  async post<T = unknown>(path: string, opts: DeckOpts = {}): Promise<T> {
    const res = await request(path, { ...opts, method: 'POST' })
    if (!res.ok) throw await deckError(res)
    return res.json().catch(() => undefined) as Promise<T> // algunos POST no devuelven body
  },

  async put<T = unknown>(path: string, opts: DeckOpts = {}): Promise<T> {
    const res = await request(path, { ...opts, method: 'PUT' })
    if (!res.ok) throw await deckError(res)
    return res.json().catch(() => undefined) as Promise<T>
  },

  async patch<T = unknown>(path: string, opts: DeckOpts = {}): Promise<T> {
    const res = await request(path, { ...opts, method: 'PATCH' })
    if (!res.ok) throw await deckError(res)
    return res.json().catch(() => undefined) as Promise<T>
  },

  async del(path: string, opts: DeckOpts = {}): Promise<void> {
    const res = await request(path, { ...opts, method: 'DELETE' })
    if (!res.ok) throw await deckError(res)
  },

  // escape hatch: Response cruda (sigue tirando AuthError en 401). Para los
  // callers que ramifican por status sin querer el throw de deckError.
  raw: request,
}
