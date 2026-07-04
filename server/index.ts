// claude-deck — servidor HTTP + WS + ptys
// Bind SOLO a 127.0.0.1; se expone al tailnet con `tailscale serve`.

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { getCookie, setCookie } from 'hono/cookie'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import * as pty from 'node-pty'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import type http from 'node:http'
import { fileURLToPath } from 'node:url'

const execFileP = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const PUBLIC_DIR = path.join(ROOT, 'public')

// ---------------------------------------------------------------------------
// Configuración (.env)
// ---------------------------------------------------------------------------
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* sin .env: se usan las variables de entorno del proceso */
}

// Bajo launchd no hay locale en el entorno: tmux en locale C sanitiza output
// (tabs → "_", ver tmuxListSessions) y los shells de los ptys heredan un
// entorno sin UTF-8. Defaultear acá cubre al proceso y a todo lo que spawnea.
if (!process.env.LANG) process.env.LANG = 'en_US.UTF-8'

// WORKSPACES_ROOT es el perímetro de seguridad: el server no lee ni opera git
// fuera de esta ruta, sin importar a dónde haga cd una sesión tmux.
// DEFAULT_DIR es solo el "home" del panel: dónde nacen las sesiones tmux nuevas
// y sobre qué operan los endpoints sin ?session=. Debe caer dentro del perímetro.
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || ''
const DEFAULT_DIR = process.env.DEFAULT_DIR || WORKSPACES_ROOT
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''
const TMUX_SESSION = process.env.TMUX_SESSION || 'deck'
const PORT = Number(process.env.DECK_PORT || 7433)

function die(msg: string): never {
  console.error(`[claude-deck] ERROR: ${msg}`)
  process.exit(1)
}

if (!WORKSPACES_ROOT) die('falta la variable WORKSPACES_ROOT (raíz que contiene tus proyectos; el server no accede a nada fuera de ella)')
if (!fs.existsSync(WORKSPACES_ROOT) || !fs.statSync(WORKSPACES_ROOT).isDirectory()) die(`WORKSPACES_ROOT no existe o no es un directorio: ${WORKSPACES_ROOT}`)
if (!fs.existsSync(DEFAULT_DIR) || !fs.statSync(DEFAULT_DIR).isDirectory()) die(`DEFAULT_DIR no existe o no es un directorio: ${DEFAULT_DIR}`)
if (!insideDir(fs.realpathSync(DEFAULT_DIR), fs.realpathSync(WORKSPACES_ROOT)))
  die(`DEFAULT_DIR debe estar dentro de WORKSPACES_ROOT: ${DEFAULT_DIR} ⊄ ${WORKSPACES_ROOT}`)
if (!AUTH_TOKEN) die('falta AUTH_TOKEN — el servidor no arranca sin token (ver README, sección Seguridad)')
if (AUTH_TOKEN.length < 32) die('AUTH_TOKEN demasiado corto: debe tener al menos 32 caracteres (probá: openssl rand -hex 32)')

const SESSION_RE = /^[A-Za-z0-9_-]{1,32}$/

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class HttpError extends Error {
  status: number
  constructor(status: number, msg: string) {
    super(msg)
    this.status = status
  }
}

/** Comparación en tiempo constante (sin filtrar longitud). */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

function isTokenValid(token: string | undefined | null): boolean {
  return typeof token === 'string' && token.length > 0 && safeEqual(token, AUTH_TOKEN)
}

function insideDir(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep)
}

// ---------------------------------------------------------------------------
// tmux
// ---------------------------------------------------------------------------
async function tmuxHasSession(name: string): Promise<boolean> {
  try {
    await execFileP('tmux', ['has-session', '-t', `=${name}`])
    return true
  } catch {
    return false
  }
}

async function tmuxKillSession(name: string): Promise<boolean> {
  if (!(await tmuxHasSession(name))) return false
  try {
    await execFileP('tmux', ['kill-session', '-t', `=${name}`])
    return true
  } catch {
    return false
  }
}

async function tmuxRenameSession(oldName: string, newName: string): Promise<void> {
  await execFileP('tmux', ['rename-session', '-t', `=${oldName}`, newName])
}

async function tmuxRefreshClients(name: string): Promise<void> {
  // Redibujo completo de todos los clientes attacheados a la sesión (los ptys
  // de este server). El frontend lo pide al volver de background: iOS puede
  // dejar el buffer de xterm corrupto y, si el viewport no cambió, ningún
  // resize va a forzar el repaint (tarea 11).
  try {
    const { stdout } = await execFileP('tmux', ['list-clients', '-t', `=${name}`, '-F', '#{client_tty}'])
    const ttys = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    await Promise.all(ttys.map((tty) => execFileP('tmux', ['refresh-client', '-t', tty]).catch(() => {})))
  } catch {
    /* sesión sin clientes o muerta: nada que refrescar */
  }
}

async function tmuxPaneDir(name: string): Promise<string> {
  const { stdout } = await execFileP('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{pane_current_path}'])
  return stdout.trim()
}

async function tmuxListSessions(): Promise<Array<{ name: string; attached: boolean; dir: string }>> {
  let stdout = ''
  try {
    // separador: ESPACIO, nunca \t — sin LANG en el entorno (launchd), tmux
    // sanitiza los caracteres de control del output y el tab se vuelve "_",
    // fusionando nombre y flag en "deck_0"; la UI listaba esos nombres
    // fantasma y attach-or-create los CREABA. El espacio es imprimible en
    // cualquier locale y SESSION_RE garantiza que un nombre no lo contiene.
    stdout = (await execFileP('tmux', ['list-sessions', '-F', '#{session_name} #{session_attached}'])).stdout
  } catch {
    return [] // no hay servidor tmux corriendo
  }
  const out: Array<{ name: string; attached: boolean; dir: string }> = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const [name, attached] = line.split(' ')
    if (!name || name.endsWith('-shell')) continue
    let dir = ''
    try {
      dir = await tmuxPaneDir(name)
    } catch {
      /* la sesión pudo morir entre medio */
    }
    out.push({ name, attached: Number(attached) > 0, dir })
  }
  return out
}

/** Directorio actual del pane de una sesión tmux, con validaciones de nombre. */
async function resolvePaneDir(session: string): Promise<string> {
  if (!SESSION_RE.test(session)) throw new HttpError(400, 'nombre de sesión inválido')
  if (!(await tmuxHasSession(session))) throw new HttpError(404, `sesión tmux no encontrada: ${session}`)
  let dir: string
  try {
    dir = await tmuxPaneDir(session)
  } catch {
    throw new HttpError(404, `sesión tmux no encontrada: ${session}`)
  }
  // tmux puede devolver vacío para targets raros; nunca operar sobre ''
  if (!dir || !path.isAbsolute(dir)) throw new HttpError(404, `sesión tmux sin directorio: ${session}`)
  return dir
}

/** Realpath validado contra WORKSPACES_ROOT (el perímetro de todo acceso git/fs). */
function checkInsideWorkspaces(p: string): string {
  const real = fs.realpathSync(p)
  const realRoot = fs.realpathSync(WORKSPACES_ROOT)
  if (!insideDir(real, realRoot)) throw new HttpError(403, 'directorio fuera de WORKSPACES_ROOT')
  return real
}

/**
 * Resuelve el directorio git sobre el que operar.
 * Sin `session` → DEFAULT_DIR. Con `session` → directorio actual del pane de
 * esa sesión tmux. En ambos casos, validado como repo git dentro de
 * WORKSPACES_ROOT.
 */
async function resolveGitDir(session: string | undefined): Promise<string> {
  const dir = session ? await resolvePaneDir(session) : DEFAULT_DIR
  let toplevel: string
  try {
    toplevel = (await execFileP('git', ['-C', dir, 'rev-parse', '--show-toplevel'])).stdout.trim()
  } catch {
    throw new HttpError(400, `el directorio de la sesión no es un repo git: ${dir}`)
  }
  return checkInsideWorkspaces(toplevel)
}

/**
 * Raíz para el file browser: como resolveGitDir pero sin exigir repo git —
 * si el pane está dentro de uno se usa su toplevel (la raíz del proyecto,
 * estable aunque el shell haya hecho cd), si no, el directorio del pane.
 */
async function resolveFsDir(session: string | undefined): Promise<string> {
  const dir = session ? await resolvePaneDir(session) : DEFAULT_DIR
  let top = dir
  try {
    top = (await execFileP('git', ['-C', dir, 'rev-parse', '--show-toplevel'])).stdout.trim() || dir
  } catch {
    /* no es un repo: se lista el directorio del pane */
  }
  return checkInsideWorkspaces(top)
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------
interface GitFile {
  path: string
  status: string
  staged: boolean
  untracked: boolean
}

async function gitSummary(dir: string) {
  const { stdout } = await execFileP('git', [
    '-C', dir,
    'status', '--porcelain=v2', '--branch', '--untracked-files=all',
  ], { maxBuffer: 10 * 1024 * 1024 })

  let branch = ''
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitFile[] = []

  const pushEntry = (xy: string, filePath: string) => {
    const x = xy[0]
    const y = xy[1]
    if (x && x !== '.') files.push({ path: filePath, status: x, staged: true, untracked: false })
    if (y && y !== '.') files.push({ path: filePath, status: y, staged: false, untracked: false })
  }

  for (const line of stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length)
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    } else if (line.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const parts = line.split(' ')
      pushEntry(parts[1], parts.slice(8).join(' '))
    } else if (line.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore path\torigPath
      const parts = line.split(' ')
      const rest = parts.slice(9).join(' ')
      pushEntry(parts[1], rest.split('\t')[0])
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ')
      files.push({ path: parts.slice(10).join(' '), status: 'U', staged: false, untracked: false })
    } else if (line.startsWith('? ')) {
      files.push({ path: line.slice(2), status: '??', staged: false, untracked: true })
    }
  }

  return { branch, upstream, ahead, behind, files }
}

const DIFF_LIMIT = 500 * 1024

/** Validación estricta de un path relativo al repo: nada fuera del repo. Devuelve el absoluto. */
function checkRepoPath(dir: string, rel: string): string {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) {
    throw new HttpError(400, 'path inválido')
  }
  const realDir = fs.realpathSync(dir)
  const abs = path.resolve(realDir, rel)
  if (!insideDir(abs, realDir)) throw new HttpError(400, 'path fuera del repo')
  // Symlinks que escapen del repo → rechazar.
  if (fs.existsSync(abs)) {
    const real = fs.realpathSync(abs)
    if (!insideDir(real, realDir)) throw new HttpError(400, 'path fuera del repo (symlink)')
  }
  return abs
}

async function gitDiff(dir: string, rel: string, staged: boolean): Promise<string> {
  const abs = checkRepoPath(dir, rel)

  // ¿Untracked? (no está en el index pero existe en disco)
  let untracked = false
  try {
    await execFileP('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', rel])
  } catch {
    untracked = fs.existsSync(abs)
  }

  let out = ''
  const opts = { maxBuffer: 10 * 1024 * 1024 }
  if (untracked) {
    // Diff de archivo nuevo; exit code 1 es normal en --no-index con diferencias.
    try {
      out = (await execFileP('git', ['-C', dir, 'diff', '--no-color', '--no-index', '--', '/dev/null', rel], opts)).stdout
    } catch (e: any) {
      if (e && typeof e.code === 'number' && e.code === 1 && typeof e.stdout === 'string') out = e.stdout
      else throw e
    }
  } else {
    const args = staged
      ? ['-C', dir, 'diff', '--cached', '--no-color', '--', rel]
      : ['-C', dir, 'diff', '--no-color', '--', rel]
    out = (await execFileP('git', args, opts)).stdout
  }

  if (Buffer.byteLength(out) > DIFF_LIMIT) {
    out = out.slice(0, DIFF_LIMIT) + '\n... [diff truncado: supera 500 KB]\n'
  }
  return out
}

async function gitStage(dir: string, rel: string, action: 'stage' | 'unstage'): Promise<void> {
  checkRepoPath(dir, rel)
  try {
    if (action === 'stage') {
      await execFileP('git', ['-C', dir, 'add', '--', rel])
    } else {
      // repo sin commits: no hay HEAD contra el que restaurar → sacar del index
      let hasHead = true
      try {
        await execFileP('git', ['-C', dir, 'rev-parse', '--verify', 'HEAD'])
      } catch {
        hasHead = false
      }
      if (hasHead) await execFileP('git', ['-C', dir, 'restore', '--staged', '--', rel])
      else await execFileP('git', ['-C', dir, 'rm', '-r', '--cached', '--', rel])
    }
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e).split('\n')[0]
    throw new HttpError(400, `git ${action === 'stage' ? 'add' : 'restore --staged'} falló: ${msg}`)
  }
}

async function gitLog(dir: string, n: number) {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'log', '--no-color', '--oneline', '-n', String(n)])
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const sp = line.indexOf(' ')
        return { hash: sp === -1 ? line : line.slice(0, sp), subject: sp === -1 ? '' : line.slice(sp + 1) }
      })
  } catch {
    return [] // repo sin commits todavía
  }
}

// ---------------------------------------------------------------------------
// File browser (solo lectura, pestaña Archivos)
// ---------------------------------------------------------------------------
const FS_LIST_MAX = 500
const FS_FILE_LIMIT = 512 * 1024

interface FsEntry {
  name: string
  type: 'dir' | 'file'
  size: number
}

/** Lista un directorio (no recursivo: el árbol del frontend carga por nivel). */
function fsList(dir: string, rel: string) {
  const abs = rel ? checkRepoPath(dir, rel) : fs.realpathSync(dir)
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    throw new HttpError(404, 'directorio no encontrado')
  }
  if (!st.isDirectory()) throw new HttpError(400, 'no es un directorio')

  const realDir = fs.realpathSync(dir)
  const entries: FsEntry[] = []
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    if (d.name === '.git') continue
    const target = path.join(abs, d.name)
    try {
      // statSync sigue symlinks; los que escapan del root no se listan
      if (d.isSymbolicLink() && !insideDir(fs.realpathSync(target), realDir)) continue
      const s = fs.statSync(target)
      if (!s.isDirectory() && !s.isFile()) continue // sockets, fifos, etc.
      entries.push({ name: d.name, type: s.isDirectory() ? 'dir' : 'file', size: s.size })
    } catch {
      continue // symlink roto o sin permisos
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  const truncated = entries.length > FS_LIST_MAX
  return { root: realDir, path: rel, entries: truncated ? entries.slice(0, FS_LIST_MAX) : entries, truncated }
}

function fsReadFile(dir: string, rel: string) {
  const abs = checkRepoPath(dir, rel)
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    throw new HttpError(404, 'archivo no encontrado')
  }
  if (!st.isFile()) throw new HttpError(400, 'no es un archivo')

  const truncated = st.size > FS_FILE_LIMIT
  const buf = Buffer.alloc(Math.min(st.size, FS_FILE_LIMIT))
  const fd = fs.openSync(abs, 'r')
  try {
    fs.readSync(fd, buf, 0, buf.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  const binary = buf.subarray(0, 8192).includes(0)
  return { path: rel, size: st.size, binary, truncated, content: binary ? '' : buf.toString('utf8') }
}

// ---------------------------------------------------------------------------
// Rate limit básico (endpoints HTTP)
// ---------------------------------------------------------------------------
const RL_WINDOW_MS = 60_000
const RL_MAX = 300
const rlBuckets = new Map<string, { n: number; reset: number }>()

function rateLimited(key: string): boolean {
  const now = Date.now()
  const b = rlBuckets.get(key)
  if (!b || now > b.reset) {
    rlBuckets.set(key, { n: 1, reset: now + RL_WINDOW_MS })
    return false
  }
  b.n++
  return b.n > RL_MAX
}

// ---------------------------------------------------------------------------
// App HTTP
// ---------------------------------------------------------------------------
const app = new Hono()

// Auth: primera visita con ?token=XXX → cookie httpOnly + redirect.
// Todo (estáticos incluidos) exige cookie `deck_token` o header `x-deck-token`.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  const qtoken = url.searchParams.get('token')
  if (qtoken !== null) {
    if (isTokenValid(qtoken)) {
      setCookie(c, 'deck_token', AUTH_TOKEN, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      })
      url.searchParams.delete('token')
      return c.redirect(url.pathname + url.search)
    }
    return c.text('Unauthorized', 401)
  }
  if (isTokenValid(getCookie(c, 'deck_token')) || isTokenValid(c.req.header('x-deck-token'))) {
    return next()
  }
  return c.text('Unauthorized', 401)
})

// Rate limit en /api/*
app.use('/api/*', async (c, next) => {
  const ip = c.req.header('x-forwarded-for') || 'local'
  if (rateLimited(ip)) return c.text('Too Many Requests', 429)
  return next()
})

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400)
  console.error('[claude-deck]', err)
  return c.json({ error: 'internal error' }, 500)
})

app.get('/api/config', (c) => c.json({ session: TMUX_SESSION, defaultDir: DEFAULT_DIR }))

app.get('/api/tmux/sessions', async (c) => c.json(await tmuxListSessions()))

// Imagen desde el celular → Claude Code de la sesión.
// Camino ideal (macOS): guardar la imagen, ponerla en el clipboard de la Mac
// y mandar Ctrl+V a la sesión tmux — Claude Code la ingiere como [Image #N].
// Fallback (sin osascript / no-macOS): escribir la ruta del archivo al prompt.
const UPLOADS_DIR = path.join(os.tmpdir(), 'claude-deck-uploads')
const UPLOAD_LIMIT = 15 * 1024 * 1024

app.post('/api/paste-image', async (c) => {
  const session = c.req.query('session') || TMUX_SESSION
  if (!SESSION_RE.test(session)) throw new HttpError(400, 'nombre de sesión inválido')
  if (!(await tmuxHasSession(session))) throw new HttpError(404, `sesión tmux no encontrada: ${session}`)

  const buf = Buffer.from(await c.req.arrayBuffer())
  if (!buf.length) throw new HttpError(400, 'cuerpo vacío')
  if (buf.length > UPLOAD_LIMIT) throw new HttpError(413, 'imagen demasiado grande (máx 15 MB)')
  const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47
  const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  if (!isPng && !isJpeg) throw new HttpError(415, 'formato no soportado (PNG o JPEG)')

  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
  try {
    // limpiar subidas de más de una hora
    const cutoff = Date.now() - 3600_000
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const p = path.join(UPLOADS_DIR, f)
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)
    }
  } catch { /* mejor esfuerzo */ }

  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  let file = path.join(UPLOADS_DIR, `img-${stamp}.${isPng ? 'png' : 'jpg'}`)
  fs.writeFileSync(file, buf)

  let mode = 'clipboard'
  try {
    if (process.platform !== 'darwin') throw new Error('clipboard de imagen solo en macOS')
    if (!isPng) {
      // el clipboard se setea como PNGf; convertir JPEG con sips (viene con macOS)
      const pngFile = path.join(UPLOADS_DIR, `img-${stamp}.png`)
      await execFileP('sips', ['-s', 'format', 'png', file, '--out', pngFile])
      file = pngFile
    }
    await execFileP('osascript', ['-e', `set the clipboard to (read (POSIX file "${file}") as «class PNGf»)`])
    // ojo: send-keys necesita target de pane — `=sesion:` (como tmuxPaneDir)
    await execFileP('tmux', ['send-keys', '-t', `=${session}:`, 'C-v'])
  } catch {
    mode = 'path'
    await execFileP('tmux', ['send-keys', '-t', `=${session}:`, '-l', `${file} `])
  }
  return c.json({ ok: true, mode })
})

// Mata la sesión y su shell acompañante. El attach (pty) muere solo al morir
// la sesión; el cliente decide a qué sesión reconectarse.
app.delete('/api/tmux/sessions/:name', async (c) => {
  const name = c.req.param('name')
  if (!SESSION_RE.test(name)) throw new HttpError(400, 'nombre de sesión inválido')
  const killed: string[] = []
  if (await tmuxKillSession(name)) killed.push(name)
  if (await tmuxKillSession(`${name}-shell`)) killed.push(`${name}-shell`)
  if (!killed.length) throw new HttpError(404, `sesión tmux no encontrada: ${name}`)
  console.log(`[deck] ${new Date().toISOString()} kill ${killed.join(', ')}`)
  return c.json({ ok: true, killed })
})

// Renombra la sesión y su shell acompañante (la convención <name>-shell debe
// sobrevivir al rename). Los attaches vivos NO se cortan: tmux nunca desconecta
// clientes al renombrar, así que el pty sigue andando; el frontend solo tiene
// que actualizar el nombre con el que habla la API.
app.patch('/api/tmux/sessions/:name', async (c) => {
  const name = c.req.param('name')
  if (!SESSION_RE.test(name) || name.endsWith('-shell')) throw new HttpError(400, 'nombre de sesión inválido')
  let body: { newName?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  const newName = typeof body.newName === 'string' ? body.newName.trim() : ''
  if (!SESSION_RE.test(newName)) {
    throw new HttpError(400, 'nuevo nombre inválido (letras, números, "-" y "_", máx 32)')
  }
  if (newName.endsWith('-shell')) throw new HttpError(400, "el sufijo '-shell' está reservado")
  if (!(await tmuxHasSession(name))) throw new HttpError(404, `sesión tmux no encontrada: ${name}`)
  if (newName === name) return c.json({ ok: true, renamed: [] })
  if ((await tmuxHasSession(newName)) || (await tmuxHasSession(`${newName}-shell`))) {
    throw new HttpError(409, `ya existe una sesión llamada ${newName}`)
  }
  const renamed: string[] = []
  await tmuxRenameSession(name, newName)
  renamed.push(newName)
  if (await tmuxHasSession(`${name}-shell`)) {
    await tmuxRenameSession(`${name}-shell`, `${newName}-shell`)
    renamed.push(`${newName}-shell`)
  }
  console.log(`[deck] ${new Date().toISOString()} rename ${name} -> ${renamed.join(', ')}`)
  return c.json({ ok: true, renamed })
})

app.get('/api/git/summary', async (c) => {
  const dir = await resolveGitDir(c.req.query('session'))
  try {
    return c.json(await gitSummary(dir))
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(400, `no se pudo leer el estado git de ${dir}`)
  }
})

app.get('/api/git/diff', async (c) => {
  const dir = await resolveGitDir(c.req.query('session'))
  const rel = c.req.query('path') || ''
  const staged = c.req.query('staged') === '1'
  const diff = await gitDiff(dir, rel, staged)
  return c.text(diff)
})

// Stage / unstage de un archivo. Body JSON: { path, action: 'stage' | 'unstage' }
app.post('/api/git/stage', async (c) => {
  const dir = await resolveGitDir(c.req.query('session'))
  let body: { path?: unknown; action?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  const rel = typeof body.path === 'string' ? body.path : ''
  const action = body.action
  if (action !== 'stage' && action !== 'unstage') {
    throw new HttpError(400, "action debe ser 'stage' o 'unstage'")
  }
  await gitStage(dir, rel, action)
  return c.json({ ok: true })
})

app.get('/api/git/log', async (c) => {
  const dir = await resolveGitDir(c.req.query('session'))
  let n = Number.parseInt(c.req.query('n') || '15', 10)
  if (!Number.isFinite(n)) n = 15
  n = Math.min(Math.max(n, 1), 200)
  return c.json(await gitLog(dir, n))
})

// File browser (solo lectura). ?path= relativo a la raíz de la sesión;
// vacío → la raíz misma.
app.get('/api/fs/list', async (c) => {
  const dir = await resolveFsDir(c.req.query('session'))
  return c.json(fsList(dir, c.req.query('path') || ''))
})

app.get('/api/fs/file', async (c) => {
  const dir = await resolveFsDir(c.req.query('session'))
  return c.json(fsReadFile(dir, c.req.query('path') || ''))
})

// Estáticos (con auth, servidos desde public/)
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

app.get('*', (c) => {
  let p = decodeURIComponent(new URL(c.req.url).pathname)
  if (p === '/') p = '/index.html'
  const abs = path.normalize(path.join(PUBLIC_DIR, p))
  if (!insideDir(abs, PUBLIC_DIR)) return c.text('Not found', 404)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return c.text('Not found', 404)
  const body = new Uint8Array(fs.readFileSync(abs))
  return c.body(body, 200, {
    'content-type': MIME[path.extname(abs)] || 'application/octet-stream',
    'cache-control': 'no-cache',
  })
})

// ---------------------------------------------------------------------------
// WebSocket: /ws/term?session=<nombre>
// (el target=shell de la v1 se retiró con la pestaña Shell; kill/rename siguen
// limpiando pares <name>-shell que hayan quedado de esa época)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true })

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(Math.max(Math.round(n), min), max)
}

async function handleTerm(ws: WebSocket, url: URL) {
  const session = url.searchParams.get('session') || TMUX_SESSION
  if (!SESSION_RE.test(session)) {
    ws.close(1008, 'nombre de sesión inválido')
    return
  }
  const tmuxName = session
  const existed = await tmuxHasSession(tmuxName)

  // Solo un attach con intención explícita puede CREAR (create=1: botón + de
  // la UI; la default se recrea siempre). Sin esto, attach-or-create convertía
  // el retry de cualquier cliente desactualizado en una resurrección de la
  // sesión recién matada ("borro una y aparece otra").
  const allowCreate = url.searchParams.get('create') === '1' || tmuxName === TMUX_SESSION
  if (!existed && !allowCreate) {
    console.log(`[deck] ${new Date().toISOString()} ws attach session=${tmuxName} rechazado (no existe, sin create=1)`)
    ws.send(JSON.stringify({ t: 'meta', gone: true, session: tmuxName }))
    ws.close(1000, 'la sesión no existe')
    return
  }

  const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
  delete env.TMUX // permitir attach aunque el server corra dentro de tmux

  // attach-or-create: nunca se mata la sesión tmux, solo este attach (pty).
  let p: pty.IPty
  try {
    // `; set-option mouse on`: tmux captura la rueda del mouse y scrollea su
    // historial (copy-mode). El frontend traduce gestos táctiles a eventos de
    // rueda — sin esto, no habría forma de ver scrollback desde el celular.
    p = pty.spawn('tmux', ['new-session', '-A', '-s', tmuxName, '-c', DEFAULT_DIR, ';', 'set-option', 'mouse', 'on'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: DEFAULT_DIR,
      env,
    })
  } catch (e) {
    console.error('[claude-deck] no se pudo abrir el pty:', e)
    ws.send(JSON.stringify({ t: 'out', d: '\r\n[claude-deck] error al abrir la terminal\r\n' }))
    ws.close(1011, 'pty spawn failed')
    return
  }

  // log de attaches: si vuelven a aparecer sesiones fantasma (p. ej. nombres
  // con _0), acá queda QUIÉN pidió qué nombre y si eso la creó
  console.log(`[deck] ${new Date().toISOString()} ws attach session=${tmuxName} created=${!existed}`)
  ws.send(JSON.stringify({ t: 'meta', created: !existed, session: tmuxName }))

  p.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'out', d }))
  })
  p.onExit(() => {
    try { ws.close() } catch { /* ya cerrado */ }
  })

  ws.on('message', (raw: RawData) => {
    let m: any
    try { m = JSON.parse(String(raw)) } catch { return }
    if (m.t === 'in' && typeof m.d === 'string') {
      p.write(m.d)
    } else if (m.t === 'resize') {
      const cols = clampInt(m.cols, 20, 500)
      const rows = clampInt(m.rows, 5, 300)
      if (cols && rows) {
        try { p.resize(cols, rows) } catch { /* pty ya muerto */ }
      }
    } else if (m.t === 'refresh') {
      // resume desde el celular: forzar repaint (garantiza al menos un 'out',
      // que el frontend usa como señal de vida del socket)
      void tmuxRefreshClients(tmuxName)
    }
  })

  // Al cerrarse el WS: matar SOLO el pty (attach). La sesión tmux sigue viva.
  ws.on('close', () => {
    try { p.kill() } catch { /* ya muerto */ }
  })
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT }, async () => {
  const localUrl = `http://127.0.0.1:${PORT}`
  console.log('')
  console.log('  claude-deck listo')
  console.log(`  Local:            ${localUrl}`)
  console.log(`  Con token:        ${localUrl}/?token=${AUTH_TOKEN}`)
  console.log('')
  console.log('  Exponer al tailnet (HTTPS, solo tus dispositivos):')
  console.log(`    tailscale serve --bg ${PORT}`)
  try {
    const { stdout } = await execFileP('tailscale', ['status', '--json'])
    const dns: string = JSON.parse(stdout)?.Self?.DNSName || ''
    if (dns) {
      console.log('')
      console.log(`  URL desde el celu: https://${dns.replace(/\.$/, '')}/?token=${AUTH_TOKEN}`)
    }
  } catch {
    console.log(`  URL desde el celu: https://<maquina>.<tailnet>.ts.net/?token=${AUTH_TOKEN}`)
  }
  console.log('')
}) as http.Server

server.on('upgrade', (req: IncomingMessage, socket, head) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname !== '/ws/term') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    // Auth del handshake: cookie deck_token o header x-deck-token.
    const cookies = Object.fromEntries(
      (req.headers.cookie || '')
        .split(';')
        .map((s) => s.trim().split('=').map(decodeURIComponent))
        .filter((kv) => kv.length === 2),
    ) as Record<string, string>
    const headerToken = Array.isArray(req.headers['x-deck-token'])
      ? req.headers['x-deck-token'][0]
      : req.headers['x-deck-token']
    if (!isTokenValid(cookies['deck_token']) && !isTokenValid(headerToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTerm(ws, url).catch((e) => {
        console.error('[claude-deck] error en handleTerm:', e)
        try { ws.close(1011) } catch { /* ya cerrado */ }
      })
    })
  } catch {
    socket.destroy()
  }
})
