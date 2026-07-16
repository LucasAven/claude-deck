// claude-deck — servidor HTTP + WS + ptys
// Bind SOLO a 127.0.0.1; se expone al tailnet con `tailscale serve`.

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { getCookie, setCookie } from 'hono/cookie'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import * as pty from 'node-pty'
import webpush from 'web-push'
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
// Estáticos: el build de Vite (web/dist). El dual-root con fallback a public/
// se retiró al borrar la app vanilla del port a React;
// buildear es obligatorio, así que sin build frenamos acá con un error claro
// en vez de servir 404s silenciosos.
const PUBLIC_DIR = path.join(ROOT, 'web', 'dist')
if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
  console.error('web/dist no existe — corré `npm run build` antes de arrancar el server')
  process.exit(1)
}

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

// WORKSPACES_ROOTS es el perímetro de blast-radius de los endpoints estructurados
// (git/fs/dispatch/worktree): el server no lee ni opera git fuera de la UNION de
// estas raíces, sin importar a dónde haga cd una sesión tmux. No es confinamiento
// del usuario (la terminal tmux da un shell libre), sino la frontera de alcance de
// un bug en los lectores no-shell. Ver docs/adr/0002. Se parsea como PATH (rutas
// separadas por ":"). WORKSPACES_ROOT (singular) sigue como alias de compat de una
// sola raíz: si WORKSPACES_ROOTS no está seteada, se usa el singular.
// DEFAULT_DIR es solo el "home" del panel: dónde nacen las sesiones tmux nuevas
// y sobre qué operan los endpoints sin ?session=. Debe caer dentro del perímetro.
const WORKSPACES_ROOTS_RAW = process.env.WORKSPACES_ROOTS || process.env.WORKSPACES_ROOT || ''
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''
const TMUX_SESSION = process.env.TMUX_SESSION || 'deck'
const PORT = Number(process.env.DECK_PORT || 7433)

function die(msg: string): never {
  console.error(`[claude-deck] ERROR: ${msg}`)
  process.exit(1)
}

if (!WORKSPACES_ROOTS_RAW) die('falta WORKSPACES_ROOTS (o el alias de compat WORKSPACES_ROOT): lista de raíces separadas por ":" que contienen tus proyectos; el server no accede a nada fuera de la union de ellas')
// Cada raíz: existe, es dir, realpath-eada y deduplicada. El perímetro es su union.
const WORKSPACES_ROOTS: string[] = []
for (const raw of WORKSPACES_ROOTS_RAW.split(':').map((s) => s.trim()).filter(Boolean)) {
  if (!fs.existsSync(raw) || !fs.statSync(raw).isDirectory()) die(`raíz de WORKSPACES_ROOTS no existe o no es un directorio: ${raw}`)
  const real = fs.realpathSync(raw)
  if (!WORKSPACES_ROOTS.includes(real)) WORKSPACES_ROOTS.push(real)
}
if (WORKSPACES_ROOTS.length === 0) die('WORKSPACES_ROOTS quedó vacío tras el parseo (solo separadores ":" o espacios)')
// Sin DEFAULT_DIR explícito: la primera raíz (mismo default que el singular viejo).
// Es solo el FALLBACK del home: el default vivo lo manda defaultDirEffective()
// (el elegido desde la PWA gana, tarea 43).
const DEFAULT_DIR_RAW = process.env.DEFAULT_DIR || WORKSPACES_ROOTS[0]
if (!fs.existsSync(DEFAULT_DIR_RAW) || !fs.statSync(DEFAULT_DIR_RAW).isDirectory()) die(`DEFAULT_DIR no existe o no es un directorio: ${DEFAULT_DIR_RAW}`)
// realpath-eado como las raíces (tarea 43): el frontend compara esta ruta contra
// las de pins/recientes/browse (todas realpath-eadas) para pintar el badge de
// default; sin normalizar, un symlink o una barra final darían un falso negativo.
const DEFAULT_DIR = fs.realpathSync(DEFAULT_DIR_RAW)
if (!insideUnion(DEFAULT_DIR))
  die(`DEFAULT_DIR debe estar dentro de alguna raíz del perímetro: ${DEFAULT_DIR_RAW} ⊄ union{${WORKSPACES_ROOTS.join(', ')}}`)
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

// ---------------------------------------------------------------------------
// Guardián del perímetro de filesystem (docs/adr/0002)
//
// El perímetro es la UNION de WORKSPACES_ROOTS: la frontera de blast-radius de
// los endpoints estructurados (git/fs/dispatch/worktree/dirs), que toman rutas
// del cliente y tocan disco sin pasar por un shell. No confina al usuario (la
// terminal tmux ya da un shell libre): acota lo que un bug de path-traversal
// en esos lectores podría alcanzar (~/.ssh, ~/.aws, los transcripts, etc.).
//
// Gotcha central: la contención se decide por PREFIJO LEXICO (insideDir), que
// solo es sólida si ambos lados están normalizados. Las raíces se realpath-ean
// al boot; el lado del cliente se realpath-ea acá (resolveInside*), así un
// symlink dentro del perímetro que apunte afuera NO lo elude. insideUnion es
// la única puerta sin realpath: para rutas ya realpath-eadas o que todavía no
// existen (el destino de un worktree), donde el caller garantiza el prefijo.
//
// Interfaz (los endpoints usan ESTO, nunca insideDir directo):
//   resolveInside(p)        realpath dentro de la union, o HttpError 403.
//   resolveInsideOrNull(p)  idem pero null: guards y filtros silenciosos.
//   insideUnion(p)          check léxico contra la union, sin realpath.
//   resolveWithin(p, base)  genérica: realpath de p contenido en una base
//                           arbitraria YA realpath-eada, o null (filtros de
//                           symlinks por-raíz o por-repo, transcripts).
//
// Perímetros secundarios que comparten la primitiva léxica pero NO la union:
// checkRepoPath (subárbol del repo, 400) y el handler de estáticos
// (PUBLIC_DIR, léxico a propósito: PUBLIC_DIR no está realpath-eado y un
// realpath acá cambiaría qué se sirve). Son los únicos callers directos de
// insideDir fuera de este bloque.
// ---------------------------------------------------------------------------

/** Primitiva léxica de contención. Detalle interno del guardián (ver arriba). */
function insideDir(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep)
}

/** Check léxico contra la union de WORKSPACES_ROOTS, sin realpath (ver doc del bloque). */
function insideUnion(p: string): boolean {
  return WORKSPACES_ROOTS.some((root) => insideDir(p, root))
}

/** Realpath validado contra la UNION de WORKSPACES_ROOTS (perímetro git/fs). */
function resolveInside(p: string): string {
  const real = fs.realpathSync(p)
  if (insideUnion(real)) return real
  throw new HttpError(403, 'directorio fuera del perímetro (union de WORKSPACES_ROOTS)')
}

/** Variante silenciosa de resolveInside: null si no existe o cae fuera de la union. */
function resolveInsideOrNull(p: string): string | null {
  try {
    const real = fs.realpathSync(p)
    return insideUnion(real) ? real : null
  } catch {
    return null
  }
}

/**
 * Contención genérica en una base arbitraria YA realpath-eada (una raíz del
 * perímetro, el toplevel de un repo, una raíz de transcripts): realpath de p,
 * o null si p no existe o su realpath queda fuera de la base.
 */
function resolveWithin(p: string, baseReal: string): string | null {
  try {
    const real = fs.realpathSync(p)
    return insideDir(real, baseReal) ? real : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Seam de spawn: runGit / runTmux
//
// TODO lo que el server ejecuta de git y de tmux pasa por estos dos wrappers
// (nunca execFileP directo): un único punto de spawn, sustituible en tests, y
// un único formateador del error visible (firstErrLine). Los demás binarios
// (pmset, launchctl, osascript, sips, gh, scutil, sudo, tailscale) siguen con
// execFileP directo a propósito: no son parte de este seam.
//
// Gotchas de tmux, documentados UNA vez acá (los call sites solo los
// referencian como "gotcha 3", el número histórico del HANDOFF):
//  - Targets de sesión SIEMPRE con prefijo `=` (match exacto: sin él tmux
//    hace prefix-matching y "deck" matchearía "deck-2"). Además, has-session/
//    kill-session aceptan `=nombre` pelado, pero los subcomandos de pane
//    (send-keys, capture-pane, display-message, set-option) exigen
//    `=nombre:` (con los dos puntos al final).
//  - Target INEXISTENTE: display-message y afines devuelven salida VACÍA con
//    exit 0, NO un error. Quien necesite distinguir "sesión muerta" tiene que
//    chequear el output vacío además del catch (así lo hacen
//    claudeRunningInSession, paneAtShellPrompt y resolvePaneDir).
// ---------------------------------------------------------------------------
type ExecOpts = { maxBuffer?: number; timeout?: number }

// Punto de inyección para tests futuros: pisar execImpl con un fake redirige
// TODO git/tmux del server sin tocar ningún caller. Default: el execFileP real.
let execImpl: (cmd: string, args: string[], opts?: ExecOpts) => Promise<{ stdout: string; stderr: string }> =
  (cmd, args, opts = {}) => execFileP(cmd, args, opts)

/**
 * `git -C <dir> <args>`. Devuelve el stdout crudo. Los errores se relanzan
 * TAL CUAL (el error de execFile trae code/stdout/stderr): los callers
 * tolerantes conservan su try/catch de siempre, y gitDiff necesita el objeto
 * entero para el exit 1 legítimo de `--no-index`. El mensaje que sube al
 * cliente sale de firstErrLine.
 */
async function runGit(dir: string, args: string[], opts?: ExecOpts): Promise<string> {
  return (await execImpl('git', ['-C', dir, ...args], opts)).stdout
}

/** `tmux <args>`. Mismo contrato que runGit (stdout crudo, error tal cual).
 *  Los gotchas de targets están en el comentario de esta sección. */
async function runTmux(args: string[], opts?: ExecOpts): Promise<string> {
  return (await execImpl('tmux', args, opts)).stdout
}

/**
 * Primer renglón no vacío del stderr de un execFile fallido (fallback: el
 * message del error, o 'error'): el formato canónico con el que los fallos de
 * git/tmux suben al cliente. Antes estaba copiado a mano en ~7 endpoints; los
 * mensajes por endpoint (prefijo y status) siguen viviendo en cada caller.
 */
function firstErrLine(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown } | null
  return String(err?.stderr || err?.message || e).split('\n').filter(Boolean)[0] || 'error'
}

// ---------------------------------------------------------------------------
// tmux
// ---------------------------------------------------------------------------
async function tmuxHasSession(name: string): Promise<boolean> {
  try {
    await runTmux(['has-session', '-t', `=${name}`])
    return true
  } catch {
    return false
  }
}

async function tmuxKillSession(name: string): Promise<boolean> {
  if (!(await tmuxHasSession(name))) return false
  try {
    await runTmux(['kill-session', '-t', `=${name}`])
    return true
  } catch {
    return false
  }
}

async function tmuxRenameSession(oldName: string, newName: string): Promise<void> {
  await runTmux(['rename-session', '-t', `=${oldName}`, newName])
}

// send-keys a un pane (target `=sesion:` por el gotcha 3, documentado en el
// seam de spawn). Los args van tal cual: nombres de tecla (`C-v`, `Escape`)
// o `-l <literal>` para texto crudo. Es el ÚNICO camino de send-keys del
// server: dispatch y session/cd mandan por acá su patrón "línea literal con
// -l, después Enter aparte".
async function tmuxSendKeys(session: string, ...keys: string[]): Promise<void> {
  await runTmux(['send-keys', '-t', `=${session}:`, ...keys])
}

// status bar de tmux (la franja verde con [sesión]/hora): es una opción POR
// SESIÓN — no hay forma de ocultarla solo en un cliente, así que apagarla afecta
// a todo attach de la misma sesión (incluida una terminal de la laptop). El
// toggle vive en la PWA (deck-hide-tmux-status en localStorage); el estado
// inicial se aplica al attachear (chain en el spawn) y los cambios en vivo por
// el mensaje WS {t:'statusbar'}. Fire-and-forget: un fallo no debe tirar nada.
async function tmuxSetStatus(name: string, on: boolean): Promise<void> {
  try {
    await runTmux(['set-option', '-t', `=${name}:`, 'status', on ? 'on' : 'off'])
  } catch { /* sesión muerta o sin permisos: sin efecto */ }
}

async function tmuxRefreshClients(name: string): Promise<void> {
  // Redibujo completo de todos los clientes attacheados a la sesión (los ptys
  // de este server). El frontend lo pide al volver de background: iOS puede
  // dejar el buffer de xterm corrupto y, si el viewport no cambió, ningún
  // resize va a forzar el repaint (tarea 11).
  try {
    const stdout = await runTmux(['list-clients', '-t', `=${name}`, '-F', '#{client_tty}'])
    const ttys = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    await Promise.all(ttys.map((tty) => runTmux(['refresh-client', '-t', tty]).catch(() => {})))
  } catch {
    /* sesión sin clientes o muerta: nada que refrescar */
  }
}

async function tmuxPaneDir(name: string): Promise<string> {
  return (await runTmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_current_path}'])).trim()
}

/**
 * Directorio de NACIMIENTO de una sesión (el `-c` del new-session). A diferencia
 * de tmuxPaneDir NO sigue el cwd vivo del shell, y por eso es la señal del
 * naming (dispatchSessionName), no del resto.
 *
 * Por qué (medido 2026-07-15, tarea 43): `pane_current_path` es INESTABLE en los
 * primeros ~50 ms de vida de la sesión, porque refleja el cwd del shell mientras
 * corre su rc y zsh se mete en `~/.oh-my-zsh` de paso. Leerlo en esa ventana
 * hacía que una segunda sesión sobre el MISMO dir leyera "/Users/lucas/.oh-my-zsh"
 * como dir de la primera, la tomara por un homónimo de otro proyecto y se llevara
 * el prefijo del padre: `a-claude-deck` en vez de `claude-deck-2`. `session_path`
 * queda clavado en el `-c` y no sufre ni el arranque ni un `cd` posterior, que es
 * justo lo que el naming quiere saber (de qué dir nació esta sesión).
 */
async function tmuxSessionPath(name: string): Promise<string> {
  return (await runTmux(['display-message', '-p', '-t', `=${name}:`, '#{session_path}'])).trim()
}

// --- estado por sesión (semáforo de chips, tarea 4) -------------------------
// Los hooks globales de Claude Code escriben ~/.claude-deck/state/<sesión> vía
// scripts/state.sh (contenido = estado, mtime = ts). Sesión sin registro (shell
// pelado, claude sin hooks) → null: la UI no pinta punto.
const STATE_DIR = path.join(os.homedir(), '.claude-deck', 'state')
// TTL solo para `working`: un claude matado con kill/kill-session nunca emite
// Stop y quedaría verde para siempre. `waiting`/`idle` NO decaen: son estados
// de reposo legítimos por horas (el caso de uso es justamente volver tarde a
// un prompt pendiente y ver el chip en ámbar).
const STATE_TTL_MS = 5 * 60 * 1000
type SessionState = 'working' | 'waiting' | 'idle'

function sessionState(name: string): SessionState | null {
  if (!SESSION_RE.test(name)) return null // nunca joinear nombres raros al path
  try {
    const file = path.join(STATE_DIR, name)
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (raw !== 'working' && raw !== 'waiting' && raw !== 'idle') return null
    if (raw === 'working' && Date.now() - fs.statSync(file).mtimeMs > STATE_TTL_MS) return null
    return raw
  } catch {
    return null
  }
}

// --- statusline por sesión (tarea 22) --------------------------------------
// El hook statusLine de Claude Code escribe ~/.claude-deck/state/<sesión>.status.json
// vía scripts/statusline.sh (curado a model/ctxPct/tokens/costo; mtime = ts).
// Contrato blando como el semáforo: sin archivo o JSON roto → null (nunca error),
// para que el panel muestre "sin datos" y no ensucie la consola.
function statusForSession(name: string): unknown | null {
  if (!SESSION_RE.test(name)) return null // nunca joinear nombres raros al path
  try {
    const file = path.join(STATE_DIR, `${name}.status.json`)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

// ¿Hay un claude VIVO en el pane de esta sesión? (tarea 34). El status.json lo
// escribe el hook statusLine y NADIE lo borra al salir claude, así que sobrevive
// al cierre y la statusline mostraba datos rancios. Señal robusta: el foreground
// del pane. Con claude corriendo, `pane_current_command` es el título que claude
// se pone (la versión, p.ej. "2.1.205"); las herramientas Bash que claude ejecuta
// NO cambian el foreground de la tty (corren por pipes, no la toman), así que el
// pane muestra claude de punta a punta hasta que claude EXIT → vuelve al shell.
// Se DESCARTÓ el TTL por mtime (hipótesis 2 del task): medido en vivo, un claude
// idle-pero-vivo puede no reescribir su status.json por 30+ min (hasta 3.6 h en
// una sesión observada), así que cualquier umbral corto ocultaría datos válidos;
// el estado del pane distingue vivo-idle de cerrado sin ese falso negativo.
// Solo HIDE cuando estamos seguros de que el pane está en un shell (match
// positivo contra shells conocidos); cualquier otra cosa → asumir vivo (muestra).
const SHELL_CMD_RE = /^-?(zsh|bash|sh|fish|tcsh|csh|ksh|dash)$/
async function claudeRunningInSession(name: string): Promise<boolean> {
  try {
    // display-message contra un target inexistente devuelve vacío con exit 0
    // (gotcha 3) → cmd vacío → sesión muerta → no hay claude.
    const cmd = (await runTmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_current_command}'])).trim()
    if (!cmd) return false
    return !SHELL_CMD_RE.test(cmd)
  } catch {
    return false // sesión muerta / tmux no responde
  }
}

// ¿El pane está parado en un prompt de shell PELADO? (tarea 40, gate de
// /api/session/cd). A diferencia de claudeRunningInSession (que asume "vivo"
// salvo match positivo contra un shell conocido), acá el positivo es
// obligatorio en el otro sentido: !claudeRunningInSession NO alcanza, porque
// también da true para una sesión MUERTA (display-message contra un target
// inexistente devuelve vacío con exit 0, gotcha 3: cmd vacío no matchea
// SHELL_CMD_RE, así que "no hay claude" sería true igual que con un shell
// real). Acá se exige el match POSITIVO y explícito: sesión viva, comando no
// vacío, Y matchea SHELL_CMD_RE. Sesión muerta o con claude corriendo → false.
async function paneAtShellPrompt(name: string): Promise<boolean> {
  try {
    const cmd = (await runTmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_current_command}'])).trim()
    if (!cmd) return false // sesión muerta / target inexistente (gotcha 3)
    return SHELL_CMD_RE.test(cmd)
  } catch {
    return false // sesión muerta / tmux no responde
  }
}

// --- transcript de Claude por sesión (tarea 9, fase jsonl) ----------------
// EXCEPCIÓN DELIBERADA AL PERÍMETRO (solo lectura, documentada en README):
// los transcripts viven en ~/.claude*/projects, FUERA del perímetro (WORKSPACES_ROOTS).
// El matching sesión↔jsonl no se adivina: scripts/state.sh anota el
// transcript_path que traen los hooks en ~/.claude-deck/state/<sesión>.transcript,
// y acá solo se acepta ese path si realpath-resuelve a un *.jsonl dentro de
// las raíces conocidas (los dos perfiles del usuario). Nada más es legible.
const TRANSCRIPT_ROOTS = [
  path.join(os.homedir(), '.claude', 'projects'),
  path.join(os.homedir(), '.claude-work', 'projects'),
]

function transcriptForSession(name: string): string | null {
  if (!SESSION_RE.test(name)) return null
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, `${name}.transcript`), 'utf8').trim()
    if (!path.isAbsolute(raw) || !raw.endsWith('.jsonl')) return null
    const real = fs.realpathSync(raw) // resuelve symlinks antes del check de raíz
    if (!real.endsWith('.jsonl')) return null
    const inRoots = TRANSCRIPT_ROOTS.some((root) => {
      try {
        return resolveWithin(real, fs.realpathSync(root)) !== null
      } catch {
        return false // el perfil no existe en esta máquina
      }
    })
    if (!inRoots || !fs.statSync(real).isFile()) return null
    return real
  } catch {
    return null
  }
}

/** Cola del jsonl acotada en bytes; si se recortó, descarta la primera línea parcial. */
async function readTranscriptTail(file: string, tailBytes: number): Promise<{ text: string; more: boolean }> {
  const fh = await fs.promises.open(file, 'r')
  try {
    const size = (await fh.stat()).size
    const start = Math.max(0, size - tailBytes)
    const len = size - start
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl === -1 ? '' : text.slice(nl + 1)
    }
    return { text, more: start > 0 }
  } finally {
    await fh.close()
  }
}

type TranscriptTurn = { role: 'user' | 'assistant' | 'tool'; text: string }

// resumen de una línea por tool_use: el nombre + el argumento más informativo
function toolLine(name: string, input: Record<string, unknown> | undefined): string {
  const pick = ['command', 'file_path', 'pattern', 'description', 'prompt', 'skill', 'url']
  let arg = ''
  for (const k of pick) {
    if (typeof input?.[k] === 'string') { arg = input[k] as string; break }
  }
  arg = arg.split('\n')[0].slice(0, 160)
  return arg ? `${name}: ${arg}` : name
}

// Turnos legibles del jsonl: prompts del usuario, texto del asistente y
// one-liners de tools. Se saltean: entradas meta (wrappers de slash commands,
// caveats), sidechains (subagentes), thinking y los tool_result (plomería).
function parseTranscriptTurns(text: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let e: any
    try {
      e = JSON.parse(line)
    } catch {
      continue // línea partida o corrupta: mejor esfuerzo
    }
    if (e?.isMeta || e?.isSidechain) continue
    const content = e?.message?.content
    if (e?.type === 'user') {
      let t = ''
      if (typeof content === 'string') t = content
      else if (Array.isArray(content)) {
        t = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text).join('\n')
      }
      t = t.trim()
      // los slash commands / interrupciones llegan envueltos en tags o caveats
      if (!t || t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')) continue
      turns.push({ role: 'user', text: t })
    } else if (e?.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          turns.push({ role: 'assistant', text: b.text.trim() })
        } else if (b?.type === 'tool_use' && typeof b.name === 'string') {
          turns.push({ role: 'tool', text: toolLine(b.name, b.input) })
        }
      }
    }
  }
  return turns
}

async function tmuxListSessions(): Promise<Array<{ name: string; attached: boolean; dir: string; state: SessionState | null; claudeRunning: boolean }>> {
  let stdout = ''
  try {
    // separador: ESPACIO, nunca \t — sin LANG en el entorno (launchd), tmux
    // sanitiza los caracteres de control del output y el tab se vuelve "_",
    // fusionando nombre y flag en "deck_0"; la UI listaba esos nombres
    // fantasma y attach-or-create los CREABA. El espacio es imprimible en
    // cualquier locale y SESSION_RE garantiza que un nombre no lo contiene.
    stdout = await runTmux(['list-sessions', '-F', '#{session_name} #{session_attached}'])
  } catch {
    return [] // no hay servidor tmux corriendo
  }
  const out: Array<{ name: string; attached: boolean; dir: string; state: SessionState | null; claudeRunning: boolean }> = []
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
    // claudeRunning (tarea 41): mismo criterio que claudeRunningInSession
    // (pane_current_command no matchea un shell conocido). Alimenta el punto
    // verde/ámbar de la tab Proyectos y el gate visual del [cd] (deshabilitado
    // mientras haya claude corriendo). Una llamada extra de display-message por
    // sesión por poll: aceptable para el puñado de sesiones en juego.
    const claudeRunning = await claudeRunningInSession(name)
    out.push({ name, attached: Number(attached) > 0, dir, state: sessionState(name), claudeRunning })
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

/**
 * Resuelve el directorio git sobre el que operar.
 * Sin `session` → el home efectivo del panel (defaultDirEffective, tarea 43).
 * Con `session` → directorio actual del pane de esa sesión tmux. En ambos
 * casos, validado como repo git dentro del perímetro (union de
 * WORKSPACES_ROOTS).
 */
async function resolveGitDir(session: string | undefined): Promise<string> {
  const dir = session ? await resolvePaneDir(session) : defaultDirEffective()
  let toplevel: string
  try {
    toplevel = (await runGit(dir, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    throw new HttpError(400, `el directorio de la sesión no es un repo git: ${dir}`)
  }
  return resolveInside(toplevel)
}

/**
 * Raíz para el file browser: como resolveGitDir pero sin exigir repo git —
 * si el pane está dentro de uno se usa su toplevel (la raíz del proyecto,
 * estable aunque el shell haya hecho cd), si no, el directorio del pane.
 */
async function resolveFsDir(session: string | undefined): Promise<string> {
  const dir = session ? await resolvePaneDir(session) : defaultDirEffective()
  let top = dir
  try {
    top = (await runGit(dir, ['rev-parse', '--show-toplevel'])).trim() || dir
  } catch {
    /* no es un repo: se lista el directorio del pane */
  }
  return resolveInside(top)
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
  const stdout = await runGit(dir, [
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

/**
 * Validación estricta de un path relativo al repo: nada fuera del repo.
 * Devuelve el absoluto. Perímetro SECUNDARIO (el subárbol del repo, no la
 * union, ver el guardián): usa la primitiva léxica con realpath propio, y el
 * chequeo pre-realpath sobre `abs` es deliberado (el path puede no existir).
 */
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
    await runGit(dir, ['ls-files', '--error-unmatch', '--', rel])
  } catch {
    untracked = fs.existsSync(abs)
  }

  let out = ''
  const opts = { maxBuffer: 10 * 1024 * 1024 }
  if (untracked) {
    // Diff de archivo nuevo; exit code 1 es normal en --no-index con diferencias.
    try {
      out = await runGit(dir, ['diff', '--no-color', '--no-index', '--', '/dev/null', rel], opts)
    } catch (e: any) {
      if (e && typeof e.code === 'number' && e.code === 1 && typeof e.stdout === 'string') out = e.stdout
      else throw e
    }
  } else {
    const args = staged
      ? ['diff', '--cached', '--no-color', '--', rel]
      : ['diff', '--no-color', '--', rel]
    out = await runGit(dir, args, opts)
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
      await runGit(dir, ['add', '--', rel])
    } else {
      // repo sin commits: no hay HEAD contra el que restaurar → sacar del index
      let hasHead = true
      try {
        await runGit(dir, ['rev-parse', '--verify', 'HEAD'])
      } catch {
        hasHead = false
      }
      if (hasHead) await runGit(dir, ['restore', '--staged', '--', rel])
      else await runGit(dir, ['rm', '-r', '--cached', '--', rel])
    }
  } catch (e) {
    throw new HttpError(400, `git ${action === 'stage' ? 'add' : 'restore --staged'} falló: ${firstErrLine(e)}`)
  }
}

// Commit + push desde Cambios (tarea 12): subcomandos FIJOS, sin flags del
// cliente jamás. El mensaje viaja como UN solo argv (sin shell, sin
// interpolación); nunca --amend, -a ni nada más. Identidad = la del repo tal
// cual (no seteamos user/email/trailer: los commits parecen de Lucas).
async function gitCommit(dir: string, message: string): Promise<string> {
  try {
    await runGit(dir, ['commit', '-m', message])
  } catch (e: any) {
    // NO firstErrLine a propósito: git commit reporta "nothing to commit" por
    // STDOUT, así que la cadena incluye stdout y el fallback es más específico
    const msg = String(e?.stderr || e?.stdout || e?.message || e).split('\n').filter(Boolean)[0] || 'git commit falló'
    throw new HttpError(400, msg)
  }
  return (await runGit(dir, ['rev-parse', '--short', 'HEAD'])).trim()
}

// Push sin flags del cliente; --force/-f NO existen acá. Si la rama no tiene
// upstream configurado, degrada a `git push -u origin <rama>` (decisión de
// Lucas: -u es el ÚNICO flag extra permitido). Timeout holgado: es red.
async function gitPush(dir: string): Promise<void> {
  let hasUpstream = true
  try {
    await runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  } catch {
    hasUpstream = false
  }
  let args = ['push']
  if (!hasUpstream) {
    const branch = (await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    // detached / sin commits → push a secas: git tira el error correcto y sube al cliente
    if (branch && branch !== 'HEAD') args = ['push', '-u', 'origin', branch]
  }
  try {
    await runGit(dir, args, { timeout: 60000 })
  } catch (e: any) {
    // NO firstErrLine a propósito: errores de auth son verbosos, multilínea OK
    const raw = String(e?.stderr || e?.stdout || e?.message || e).trim()
    throw new HttpError(400, raw.slice(0, 500) || 'git push falló')
  }
}

// Historial de commits (tarea 14): hash/subject/autor/epoch + stats +N −M
// agregadas de --numstat. Separador %x00 (no aparece en subjects); cada commit
// arranca con %x01 y le siguen sus líneas de numstat (binarios emiten `-`/`-`
// → cuentan 0). El tiempo relativo lo calcula el cliente desde `ts` (endpoint
// locale-free).
interface Commit {
  hash: string
  subject: string
  author: string
  ts: number
  add: number
  del: number
}
async function gitLog(dir: string, n: number): Promise<Commit[]> {
  try {
    const stdout = await runGit(
      dir,
      ['log', '--no-color', '-n', String(n), '--format=%x01%h%x00%s%x00%an%x00%ct', '--numstat'],
      { maxBuffer: 10 * 1024 * 1024 },
    )
    const commits: Commit[] = []
    let cur: Commit | null = null
    for (const line of stdout.split('\n')) {
      if (line.startsWith('\x01')) {
        const [hash, subject, author, ct] = line.slice(1).split('\x00')
        cur = { hash, subject: subject ?? '', author: author ?? '', ts: Number(ct) || 0, add: 0, del: 0 }
        commits.push(cur)
      } else if (line.trim() && cur) {
        const [a, d] = line.split('\t')
        cur.add += a === '-' ? 0 : Number(a) || 0
        cur.del += d === '-' ? 0 : Number(d) || 0
      }
    }
    return commits
  } catch {
    return [] // repo sin commits todavía
  }
}

// git show de un commit (tarea 14): mismo visor diff2html que /api/git/diff.
// El hash se valida ANTES con ^[0-9a-f]{7,40}$ (nunca refs/rangos/HEAD^ sin
// validar); 404 si git falla (hash desconocido).
async function gitShow(dir: string, hash: string): Promise<string> {
  let out = ''
  try {
    out = await runGit(dir, ['show', '--no-color', hash], { maxBuffer: 10 * 1024 * 1024 })
  } catch {
    throw new HttpError(404, 'commit no encontrado')
  }
  if (Buffer.byteLength(out) > DIFF_LIMIT) {
    out = out.slice(0, DIFF_LIMIT) + '\n... [diff truncado: supera 500 KB]\n'
  }
  return out
}

// Chip de estado CI/PR (tarea 15): normaliza `gh pr view` a un JSON chico.
// DEGRADACIÓN SILENCIOSA ES EL CONTRATO: gh ausente (ENOENT) / sin auth / sin
// remote de GitHub / sin PR para la rama → { pr: null } con 200, nunca un
// error que la UI tenga que pintar (el chip simplemente no aparece). Cache por
// dir con TTL corto: el frontend pollea cada 8 s y pegarle a la API de GitHub
// en cada uno quemaría el rate limit sin ganar frescura. Ojo: bajo launchd gh
// puede faltar del PATH (el plist ya agrega el bin de homebrew para tmux/git);
// si falta, ENOENT → degradación, así que no rompe.
interface PrChecks {
  number: number
  title: string
  state: string
  checks: { total: number; passed: number; failed: number; pending: number }
  mergeable: string
}
const checksCache = new Map<string, { ts: number; data: { pr: PrChecks | null } }>()
const CHECKS_TTL = 60_000

async function gitChecks(dir: string): Promise<{ pr: PrChecks | null }> {
  const cached = checksCache.get(dir)
  if (cached && Date.now() - cached.ts < CHECKS_TTL) return cached.data

  let data: { pr: PrChecks | null } = { pr: null }
  try {
    const { stdout } = await execFileP(
      'gh',
      ['pr', 'view', '--json', 'number,title,state,mergeable,statusCheckRollup'],
      { cwd: dir, timeout: 10_000 },
    )
    const pr = JSON.parse(stdout)
    const checks = { total: 0, passed: 0, failed: 0, pending: 0 }
    for (const c of pr.statusCheckRollup || []) {
      checks.total++
      if (c.state) {
        // StatusContext (checks legacy de la API de status)
        if (c.state === 'SUCCESS') checks.passed++
        else if (c.state === 'PENDING' || c.state === 'EXPECTED') checks.pending++
        else checks.failed++
      } else {
        // CheckRun (GitHub Actions y afines)
        if (c.status && c.status !== 'COMPLETED') checks.pending++
        else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion)) checks.passed++
        else checks.failed++
      }
    }
    data = { pr: { number: pr.number, title: pr.title, state: pr.state, checks, mergeable: pr.mergeable } }
  } catch {
    data = { pr: null } // contrato: cualquier fallo → sin chip
  }
  checksCache.set(dir, { ts: Date.now(), data })
  return data
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
      if (d.isSymbolicLink() && resolveWithin(target, realDir) === null) continue
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

// Preview de imágenes (tarea 16): sirve el BYTE crudo de un archivo de imagen
// del repo para <img src>. Lista de extensiones PROPIA (no reusa extClass del
// frontend): svg SÍ se sirve (extClass lo cataloga como ft-html), y heic/ico
// quedan afuera (heic no renderiza en la mayoría de browsers). Cap chico: las
// screenshots de test entran de sobra.
const FS_RAW_LIMIT = 5 * 1024 * 1024
const FS_RAW_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

function fsRawFile(dir: string, rel: string): { body: Uint8Array; type: string } {
  const abs = checkRepoPath(dir, rel)
  const ext = path.extname(rel).toLowerCase()
  const type = FS_RAW_MIME[ext]
  if (!type) throw new HttpError(415, 'extensión no servible como imagen')
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    throw new HttpError(404, 'archivo no encontrado')
  }
  if (!st.isFile()) throw new HttpError(400, 'no es un archivo')
  if (st.size > FS_RAW_LIMIT) throw new HttpError(413, 'imagen demasiado grande (máx 5 MB)')
  return { body: new Uint8Array(fs.readFileSync(abs)), type }
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

// `defaultDir` sale EFECTIVO (el elegido desde la PWA o el fallback del .env,
// tarea 43): es el dir donde el "+" de la fila de chips pare la sesión.
app.get('/api/config', (c) => c.json({ session: TMUX_SESSION, defaultDir: defaultDirEffective() }))

app.get('/api/tmux/sessions', async (c) => c.json(await tmuxListSessions()))

// Presencia del celu (tarea 3): cada cliente WS reporta {t:'vis'} al conectar,
// en cada visibilitychange y re-afirmado en el poll de 8 s. notify.sh consulta
// este endpoint antes de pushear: PWA visible en primer plano = el usuario ya
// está mirando, el push sobra. El TTL corto existe porque un socket puede
// morir SIN close (celu sin batería, red cortada): la entrada caduca sola si
// el cliente deja de re-afirmar.
const PRESENCE_TTL_MS = 25_000
const presence = new Map<WebSocket, { session: string; visible: boolean; at: number }>()

app.get('/api/presence', (c) => {
  const now = Date.now()
  const sessions: string[] = []
  for (const p of presence.values()) {
    if (p.visible && now - p.at < PRESENCE_TTL_MS && !sessions.includes(p.session)) sessions.push(p.session)
  }
  return c.json({ visible: sessions.length > 0, sessions })
})

// Los endpoints /api/approve-nonce + /api/approve de la tarea 2 (Permitir/
// Denegar desde los botones del push de ntfy) se RETIRARON con ntfy (tarea 26):
// Lucas no usaba los botones, el Web Push de iOS no soporta actions custom, y
// /api/approve era la única ruta exenta de auth — sacarlos reduce superficie.
// El push de permiso ahora es plano: el tap abre la PWA y se contesta adentro.

// Scrollback legible (tarea 9): texto plano del pane para el overlay de
// lectura del frontend — sobre HTML plano el browser da selección, copy y
// find-in-page gratis (nada de eso existe dentro del canvas de xterm).
// Decisión abierta anotada: SIN `-e` (colores ANSI) a propósito — el texto
// plano es más legible a tamaños de lectura y copia limpio; revisitar si se
// extrañan los colores de diffs/status (implicaría conversión ansi→HTML).
const SCROLLBACK_DEFAULT = 500
const SCROLLBACK_MAX = 5000
app.get('/api/tmux/scrollback', async (c) => {
  const session = c.req.query('session') || TMUX_SESSION
  if (!SESSION_RE.test(session)) throw new HttpError(400, 'nombre de sesión inválido')
  if (!(await tmuxHasSession(session))) throw new HttpError(404, `sesión tmux no encontrada: ${session}`)
  let lines = Number.parseInt(c.req.query('lines') || String(SCROLLBACK_DEFAULT), 10)
  if (!Number.isFinite(lines)) lines = SCROLLBACK_DEFAULT
  lines = Math.min(Math.max(lines, 1), SCROLLBACK_MAX)
  // target `=sesion:` — capture-pane no acepta `=sesion` pelado (gotcha 3);
  // maxBuffer holgado: 5000 líneas anchas superan el mega default de execFile
  const stdout = await runTmux(
    ['capture-pane', '-p', '-t', `=${session}:`, '-S', `-${lines}`],
    { maxBuffer: 8 * 1024 * 1024 },
  )
  // el viewport del pane se captura entero: las filas vacías bajo el cursor
  // son ruido al final del texto — recortarlas (solo líneas en blanco)
  return c.text(stdout.replace(/[ \t]*(\n[ \t]*)*$/, '\n'))
})

// Transcript de la sesión como turnos legibles (tarea 9, fase jsonl): la
// fuente primaria del overlay 📜. Claude Code 2.x corre en alternate screen
// y repinta en el lugar — tmux NUNCA acumula su transcript en la historia
// (probado contra claude real, incluso con alternate-screen off), así que el
// capture-pane de arriba solo sirve para shells; lo que hizo Claude vive
// únicamente en su .jsonl. `bytes` acota la cola leída (cargar más = pedir
// más bytes hacia atrás). Sin marker NO es error: 200 con turns vacíos (el
// frontend cae a capture-pane) — un 404 acá ensuciaría la consola del browser
// en cada apertura del overlay sobre un shell pelado.
const TRANSCRIPT_BYTES_DEFAULT = 2 * 1024 * 1024
const TRANSCRIPT_BYTES_MAX = 32 * 1024 * 1024
const TRANSCRIPT_TURNS_MAX = 1000 // techo del DOM del overlay
app.get('/api/claude/transcript', async (c) => {
  const session = c.req.query('session') || TMUX_SESSION
  if (!SESSION_RE.test(session)) throw new HttpError(400, 'nombre de sesión inválido')
  if (!(await tmuxHasSession(session))) throw new HttpError(404, `sesión tmux no encontrada: ${session}`)
  const file = transcriptForSession(session)
  if (!file) return c.json({ file: null, turns: [], more: false })
  let bytes = Number.parseInt(c.req.query('bytes') || String(TRANSCRIPT_BYTES_DEFAULT), 10)
  if (!Number.isFinite(bytes)) bytes = TRANSCRIPT_BYTES_DEFAULT
  bytes = Math.min(Math.max(bytes, 64 * 1024), TRANSCRIPT_BYTES_MAX)
  const { text, more } = await readTranscriptTail(file, bytes)
  let turns = parseTranscriptTurns(text)
  // techo de turnos: pedir más bytes no agregaría nada visible una vez capado,
  // así que `more` sigue siendo solo el recorte por bytes (el frontend además
  // oculta el botón si un re-fetch no crece)
  if (turns.length > TRANSCRIPT_TURNS_MAX) turns = turns.slice(-TRANSCRIPT_TURNS_MAX)
  return c.json({ file: path.basename(file), turns, more })
})

// Statusline del panel (tarea 22): contexto/tokens/costo del Claude de la
// sesión, como el statusLine de Claude Code. Contrato blando: sesión inválida
// → 400, pero presente/ausente → 200 con {status:{...}|null} (nunca 404/500),
// así el poll piggyback no genera ruido cuando el hook aún no escribió nada.
app.get('/api/claude/status', async (c) => {
  const session = c.req.query('session') || TMUX_SESSION
  if (!SESSION_RE.test(session)) throw new HttpError(400, 'nombre de sesión inválido')
  const status = statusForSession(session)
  // Gate de frescura (tarea 34): si hay datos pero NO hay claude corriendo en el
  // pane, son de un claude ya cerrado/matado → no mostrar la línea rancia. El
  // check del pane solo se paga cuando existe el archivo (sesión con historia).
  if (status && !(await claudeRunningInSession(session))) return c.json({ status: null })
  return c.json({ status })
})

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
    await tmuxSendKeys(session, 'C-v')
  } catch {
    mode = 'path'
    await tmuxSendKeys(session, '-l', `${file} `)
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

// Al renombrar hay que migrar también los archivos de estado que los hooks
// escriben keyados por nombre de sesión (semáforo, statusline, transcript):
// si quedan con el nombre viejo, transcriptForSession() no encuentra nada y
// el scrollback cae al fallback capture-pane hasta el próximo evento de hook.
// Best-effort: un fallo acá no debe abortar un rename que tmux ya aplicó.
function renameStateFiles(oldName: string, newName: string) {
  for (const suffix of ['', '.transcript', '.status.json']) {
    try {
      fs.renameSync(path.join(STATE_DIR, `${oldName}${suffix}`), path.join(STATE_DIR, `${newName}${suffix}`))
    } catch {
      /* el archivo puede no existir (sesión sin hooks) */
    }
  }
}

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
  renameStateFiles(name, newName)
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

// Commit (tarea 12). Body JSON: { message }. Subcomando fijo, mensaje como
// argv único; devuelve el hash corto nuevo para que la UI confirme.
app.post('/api/git/commit', async (c) => {
  const dir = await resolveGitDir(c.req.query('session'))
  let body: { message?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) throw new HttpError(400, 'el mensaje del commit no puede estar vacío')
  if (message.length > 2000) throw new HttpError(400, 'el mensaje del commit es demasiado largo (máx 2000)')
  const hash = await gitCommit(dir, message)
  return c.json({ hash })
})

// Push (tarea 12). Sin body, sin flags del cliente. --force nunca existe.
app.post('/api/git/push', async (c) => {
  const dir = await resolveGitDir(c.req.query('session'))
  await gitPush(dir)
  return c.json({ ok: true })
})

app.get('/api/git/log', async (c) => {
  const dir = await resolveGitDir(c.req.query('session'))
  let n = Number.parseInt(c.req.query('n') || '15', 10)
  if (!Number.isFinite(n)) n = 15
  n = Math.min(Math.max(n, 1), 200)
  return c.json(await gitLog(dir, n))
})

// Chip de CI/PR (tarea 15). Degradación silenciosa: sin repo/gh/PR → { pr:null }
// con 200 (nunca error — el chip solo no aparece).
app.get('/api/git/checks', async (c) => {
  let dir: string
  try {
    dir = await resolveGitDir(c.req.query('session'))
  } catch {
    return c.json({ pr: null })
  }
  return c.json(await gitChecks(dir))
})

// Diff completo de un commit (tarea 14): visor diff2html vía git show.
app.get('/api/git/show', async (c) => {
  const dir = await resolveGitDir(c.req.query('session'))
  const hash = c.req.query('hash') || ''
  if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new HttpError(400, 'hash inválido')
  return c.text(await gitShow(dir, hash))
})

// Ramas del repo de la sesión (tarea 5): alimenta el dropdown "Basado en" del
// sheet de worktree. `repo` (basename del toplevel) va para que el sheet pueda
// mostrar la ruta del worktree antes de crear nada. Repo sin commits → listas
// vacías, no error (igual que gitLog).
app.get('/api/git/branches', async (c) => {
  const dir = await resolveGitDir(c.req.query('session'))
  let current = ''
  try {
    current = (await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    /* repo sin commits: sin HEAD */
  }
  if (current === 'HEAD') current = '' // detached: nada que preseleccionar
  let branches: string[] = []
  try {
    branches = (await runGit(dir, ['branch', '--format=%(refname:short)']))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    /* sin ramas todavía */
  }
  return c.json({ repo: path.basename(dir), branches, current })
})

// Worktree en un tap (tarea 5): git worktree add + rama nueva + sesión tmux en
// una sola llamada. El path del worktree es HERMANO del repo
// (../<repo>-<último-segmento-de-la-rama>): queda fuera del repo pero tiene que
// seguir dentro del perímetro (alguna raíz de WORKSPACES_ROOTS; si el repo ES una
// raíz, el hermano cae afuera → 400).
//
// La rama NO valida con SESSION_RE (feat/composer lleva "/"): regex propia.
// Los "/" y los ".." se controlan acá porque el último segmento se joinea a un
// path y el nombre entero viaja como argv de git (nunca shell, pero un leading
// "-" se volvería flag).
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,80}$/
function checkBranchName(name: string, what: string): string {
  const segs = name.split('/')
  if (
    !BRANCH_RE.test(name) ||
    name.startsWith('-') ||
    name.includes('..') ||
    segs.some((s) => !s || /^\.+$/.test(s)) // "//", "/" al borde, segmentos solo-puntos
  ) {
    throw new HttpError(400, `${what} inválido: letras, números, ".", "_", "-" y "/" (máx 80), sin ".." ni "-" inicial`)
  }
  return name
}

// sanitiza un string arbitrario (rama, basename de dir) a un nombre válido de
// sesión tmux (SESSION_RE), esquivando el sufijo reservado -shell (como
// session_name_for_cwd en scripts/deck)
function sanitizeToSession(s: string, fallback: string): string {
  let base = s.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || fallback
  if (base.endsWith('-shell')) base = `${base.slice(0, -'-shell'.length)}-s`
  return base
}

// nombre de sesión tmux derivado de la rama: sanitizado a SESSION_RE (como
// session_name_for_cwd en scripts/deck), esquivando el sufijo reservado -shell
// y colisiones con sesiones vivas
async function worktreeSessionName(branch: string): Promise<string> {
  const base = sanitizeToSession(branch, 'wt')
  let name = base
  for (let n = 2; (await tmuxHasSession(name)) || (await tmuxHasSession(`${name}-shell`)); n++) {
    name = `${base.slice(0, 32 - 1 - String(n).length)}-${n}`
  }
  return name
}

app.post('/api/worktree', async (c) => {
  const repo = await resolveGitDir(c.req.query('session'))
  let body: { branch?: unknown; base?: unknown; hideStatus?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  const branch = checkBranchName(typeof body.branch === 'string' ? body.branch.trim() : '', 'nombre de rama')
  const base = checkBranchName(typeof body.base === 'string' ? body.base.trim() : '', 'rama base')
  // pref del celu (deck-hide-tmux-status): aplicarla al crear deja la sesión sin
  // la franja verde ya desde otra vía, no solo cuando el panel se attachea (tarea 32)
  const hideStatus = body.hideStatus === true

  // el destino no existe todavía → no se puede realpathear: se realpathea el
  // PADRE (el dir del repo, que sí existe) y se prefix-checkea el join
  const parent = fs.realpathSync(path.dirname(repo))
  const lastSeg = branch.split('/').pop() as string
  const wtPath = path.join(parent, `${path.basename(repo)}-${lastSeg}`)
  if (!insideUnion(wtPath)) {
    throw new HttpError(400, `el worktree caería fuera del perímetro (union de WORKSPACES_ROOTS): ${wtPath}`)
  }
  if (fs.existsSync(wtPath)) throw new HttpError(409, `ya existe ${wtPath}`)

  try {
    await runGit(repo, ['worktree', 'add', wtPath, '-b', branch, base])
  } catch (e: any) {
    // rama existente, base inexistente, etc. — el primer renglón de git alcanza
    const msg = firstErrLine(e)
    throw new HttpError(400, `git worktree add falló: ${msg}`)
  }

  const session = await worktreeSessionName(branch)
  try {
    await runTmux(['new-session', '-d', '-s', session, '-c', wtPath])
  } catch (e: any) {
    // el worktree quedó creado pero sin sesión: avisar sin inventar rollback
    // (borrar un worktree recién pedido sería peor que dejarlo attacheable)
    const msg = firstErrLine(e)
    throw new HttpError(500, `worktree creado en ${wtPath}, pero tmux falló: ${msg}`)
  }
  // honrar la pref de ocultar la franja verde ya al nacer (fire-and-forget)
  if (hideStatus) await tmuxSetStatus(session, false)
  console.log(`[deck] ${new Date().toISOString()} worktree ${branch} -> ${wtPath} (sesión ${session})`)
  return c.json({ session, path: wtPath, branch })
})

// Directorios candidatos para despachar (tarea 6): subdirectorios de PRIMER
// nivel de CADA raíz del perímetro, solo dirs, NO recursivo. /api/fs/list no
// sirve para esto: sin session cae a DEFAULT_DIR (que suele ser un repo → devuelve
// su toplevel, no la raíz) y mezcla archivos. Acá listamos cada raíz misma.
//
// Shape (superset de compat): `roots` es la lista canónica agrupada (una entrada
// por raíz, en orden de configuración, cada una con su `root` realpath-eado y sus
// `dirs`), que consumen las tareas 39/41/42; `root`/`dirs` top-level espejan la
// PRIMERA raíz tal cual antes, para que el consumidor viejo (sheet de despacho)
// siga andando sin tocar web/src.
app.get('/api/workspaces', (c) => {
  const roots = WORKSPACES_ROOTS.map((root) => {
    const dirs: string[] = []
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue // .git, dotdirs
      const target = path.join(root, d.name)
      try {
        const s = fs.statSync(target) // sigue symlinks
        // contención POR-RAIZ a propósito (no la union): un symlink de primer
        // nivel que apunte a OTRA raíz no se lista bajo esta
        if (s.isDirectory() && resolveWithin(target, root) !== null) dirs.push(d.name)
      } catch {
        continue // symlink roto / sin permisos
      }
    }
    dirs.sort((a, b) => a.localeCompare(b))
    return { root, dirs }
  })
  return c.json({ roots, root: roots[0].root, dirs: roots[0].dirs })
})

// Despachar un agente (tarea 6, design-refs/task06-dispatch-sheet.png): crea una
// sesión tmux nueva en un dir del perímetro (WORKSPACES_ROOTS) y lanza `claude` con un prompt
// inicial + permission-mode. Fire-and-forget desde el celu; se sigue como un
// chip normal (con dot de estado de la tarea 4).
//
// Entrega del prompt (decidido con prototipo contra un claude real, tarea 6):
// argv posicional `claude $'<prompt>' --permission-mode <m> [--model <a>] [--effort <e>]` vía send-keys -l
// (quoting ANSI-C, ver shQuote). Se probó (a) argv vs (b) paste con
// bracketed-paste; (a) resultó 100% confiable en la matriz de quoting (comillas
// dobles/simples, $(), backticks, y prompts MULTILÍNEA) y se validó end-to-end
// con un claude real en modo plan (recibió el prompt como argumento posicional
// y arrancó en plan). (b) quedó descartado: más frágil (delay de readiness del
// TUI + envelope de bracketed-paste racy) sin ganar nada. Con single-quote plano
// un \n crudo dejaba a zsh en continuación `quote>` (colgaba si se perdía un
// char); ANSI-C mantiene todo en una línea y evita esa trampa.
// Pill Autorun → --permission-mode auto (elección de Lucas: más seguro que
// bypassPermissions). Valores verificados contra el claude real (choices del
// flag: acceptEdits/auto/bypassPermissions/manual/dontAsk/plan).
const DISPATCH_MODES = ['plan', 'acceptEdits', 'auto']
// Modelo opcional → --model <alias>. '' = sin flag (default del CLI). Aliases
// verificados contra el claude real (--model opus arrancó [Opus 4.8]); el CLI no
// valida el alias al parsear, así que acotamos server-side a este whitelist.
const DISPATCH_MODELS = ['', 'sonnet', 'opus', 'haiku']
// Effort opcional → --effort <level>. '' = sin flag (default del CLI). Valores
// verificados contra el claude real: el propio CLI los enumera ("Valid values:
// low, medium, high, xhigh, max") al rechazar uno inválido.
const DISPATCH_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max']
// binario a lanzar; override SOLO para tests (un stub que ecoa su argv, así la
// matriz de quoting se aserta sin lanzar un claude real — jamás un auto/bypass
// de verdad en tests). En producción siempre 'claude'.
const CLAUDE_BIN = process.env.DECK_CLAUDE_BIN || 'claude'
// Quoting ANSI-C ($'...') en vez de single-quote plano: mantiene TODO en una
// sola línea física (los \n del prompt viajan como la secuencia de dos chars
// `\n`, no como bytes newline crudos). Con single-quote un newline crudo hacía
// que zsh entrara en continuación `quote>` — si un char se perdiera en el
// send-keys, la comilla quedaría abierta y el shell colgaría esperando input.
// Dentro de $'...' NO hay expansión de $(), backticks ni $VAR (quedan literales
// → el prompt llega verbatim). Asume shell zsh/bash (el login shell del user).
function shQuote(s: string): string {
  return (
    "$'" +
    s
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') +
    "'"
  )
}

/**
 * Nombre de sesión para el dispatch y para "+ nueva sesión acá", con
 * desambiguación de homónimos (tarea 39). `dir` ya llega realpath-eado y
 * validado dentro de la unión. Siempre devuelve un nombre LIBRE: varias
 * sesiones sobre el mismo dir son legítimas (decisión de Lucas 2026-07-15,
 * ver abajo), así que ningún caso aborta.
 *
 * Regla:
 *  1. Preferido: sanitizeToSession(basename(dir)). Compat con el caso de un
 *     solo nivel: "~/proyectos/claude-deck" sigue dando la sesión
 *     "claude-deck".
 *  2. Si el preferido (o su acompañante "-shell") está tomado por una sesión
 *     cuyo pane dir resuelve al MISMO `dir`, se apila con sufijo numérico
 *     sobre el BASE: claude-deck-2, claude-deck-3. El prefijo del padre NO
 *     aplica acá: no hay homonimia que aclarar, es el mismo proyecto y el
 *     número es lo que distingue.
 *  3. Si está tomado pero el pane dir es OTRO directorio (homónimo real, ej.
 *     dos carpetas "web" en raíces distintas), se desambigua a
 *     sanitizeToSession("<basename del padre>-<basename>"), que dice ALGO del
 *     dir. Si ESE nombre también está tomado (por el mismo dir o por otro),
 *     sufijo numérico sobre el prefijado.
 *  4. Si no se puede resolver el pane dir de una sesión tomada (murió entre
 *     el check y el resolve, o quedó rara), se trata como homónimo: se
 *     desambigua igual, nunca se asume "mismo dir" a ciegas.
 *
 * Asimetría documentada a propósito: el PRIMER homónimo despachado se queda
 * con el nombre pelado; los que vienen después cargan el prefijo del padre.
 * Es la regla elegida (desambiguar recién en la colisión), no un bug.
 *
 * Historia: hasta 2026-07-15 el caso 2 era un 409 "ya hay una sesión ahí"
 * (decisión (a) de la tarea 6: nunca doblar sesión sobre el mismo dir). Lucas
 * lo revirtió: querer DOS claude sobre el mismo path (uno laburando, otro para
 * preguntar) es un caso real, y el 409 solo lo estorbaba. Nunca fue una
 * invariante de seguridad, y tmux no impone nada. Contrapartida asumida: el
 * panel ya no avisa si despachás un segundo agente sobre el mismo working tree
 * (para trabajo paralelo aislado está el worktree en un tap, tarea 5).
 */
async function dispatchSessionName(dir: string): Promise<string> {
  async function status(name: string): Promise<'free' | 'same' | 'other'> {
    const nameExists = await tmuxHasSession(name)
    const shellExists = await tmuxHasSession(`${name}-shell`)
    if (!nameExists && !shellExists) return 'free'
    const probe = nameExists ? name : `${name}-shell`
    try {
      // session_path, NO pane_current_path: ver tmuxSessionPath (el cwd vivo es
      // basura durante el arranque del shell y ensuciaba el nombre)
      const born = await tmuxSessionPath(probe)
      if (!born || !path.isAbsolute(born)) return 'other'
      return fs.realpathSync(born) === dir ? 'same' : 'other'
    } catch {
      return 'other' // no se pudo resolver: tratar como colisión, desambiguar
    }
  }

  const base = sanitizeToSession(path.basename(dir), 'sess')
  const baseStatus = await status(base)
  if (baseStatus === 'free') return base

  // mismo dir -> apilar sobre el base; homónimo en otro dir -> prefijo del padre
  let stem = base
  if (baseStatus === 'other') {
    const parent = path.basename(path.dirname(dir))
    const prefixed = sanitizeToSession(`${parent}-${path.basename(dir)}`, 'sess')
    if ((await status(prefixed)) === 'free') return prefixed
    stem = prefixed
  }

  for (let n = 2; ; n++) {
    const candidate = `${stem.slice(0, 32 - 1 - String(n).length)}-${n}`
    if ((await status(candidate)) === 'free') return candidate
  }
}

app.post('/api/dispatch', async (c) => {
  let body: { dir?: unknown; prompt?: unknown; mode?: unknown; model?: unknown; effort?: unknown; hideStatus?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  const dirName = typeof body.dir === 'string' ? body.dir : ''
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  const mode = typeof body.mode === 'string' ? body.mode : ''
  const model = typeof body.model === 'string' ? body.model : ''
  const effort = typeof body.effort === 'string' ? body.effort : ''
  // pref del celu (deck-hide-tmux-status): sin esto la sesión nace con el status
  // global (on) y muestra la franja hasta que el panel se attachee mandando el
  // param; aplicarla al crear la deja consistente ya desde otra vía (tarea 32)
  const hideStatus = body.hideStatus === true

  if (!DISPATCH_MODES.includes(mode)) throw new HttpError(400, 'modo inválido')
  if (!DISPATCH_MODELS.includes(model)) throw new HttpError(400, 'modelo inválido')
  if (!DISPATCH_EFFORTS.includes(effort)) throw new HttpError(400, 'effort inválido')
  if (!prompt) throw new HttpError(400, 'prompt vacío')
  if (prompt.length > 10000) throw new HttpError(400, 'prompt demasiado largo (máx 10000)')
  if (!dirName || dirName === '.' || dirName === '..') throw new HttpError(400, 'directorio inválido')

  // Tarea 39: relaja el dispatch a cualquier raíz/profundidad. Dos formas
  // aceptadas en `dir` (documentado, ver README):
  //  (a) ruta ABSOLUTA dentro de la unión, a cualquier profundidad (la que
  //      van a mandar las tareas 41/42 desde pins/recent/browse).
  //  (b) basename SIN separadores (compat con el sheet viejo de la tarea 6,
  //      que solo conoce basenames de primer nivel de `data.dirs`): se
  //      resuelve como antes, hijo directo de la PRIMERA raíz.
  let dir: string
  if (path.isAbsolute(dirName)) {
    if (dirName.includes('\0')) throw new HttpError(400, 'directorio inválido')
    let real: string
    try {
      real = fs.realpathSync(dirName)
    } catch {
      throw new HttpError(404, 'directorio no encontrado')
    }
    dir = resolveInside(real) // 403 si cae fuera de la unión
    if (!fs.statSync(dir).isDirectory()) throw new HttpError(400, 'no es un directorio')
  } else {
    if (dirName.includes('/') || dirName.includes(path.sep)) throw new HttpError(400, 'directorio inválido')
    const root = WORKSPACES_ROOTS[0]
    try {
      dir = fs.realpathSync(path.join(root, dirName))
    } catch {
      throw new HttpError(404, 'directorio no encontrado')
    }
    // hijo DIRECTO de la raíz (no un nieto tras seguir un symlink) y un dir real
    if (path.dirname(dir) !== root || !fs.statSync(dir).isDirectory()) {
      throw new HttpError(400, 'el directorio debe ser hijo directo de la raíz')
    }
  }

  // un dir que ya tiene sesión NO es un error: se apila (<nombre>-2), igual que
  // un homónimo en otro dir se desambigua (ver dispatchSessionName)
  const session = await dispatchSessionName(dir)

  try {
    await runTmux(['new-session', '-d', '-s', session, '-c', dir])
  } catch (e: any) {
    const msg = firstErrLine(e)
    throw new HttpError(500, `tmux falló: ${msg}`)
  }
  // sesión ya nacida: registrar el MRU (tarea 39). Best-effort, no aborta el
  // dispatch si por lo que sea falla la escritura del store de dirs.
  try {
    recordRecentDir(dir)
  } catch {
    /* no crítico: el dispatch ya creó la sesión */
  }
  // honrar la pref de ocultar la franja verde ya al nacer (fire-and-forget)
  if (hideStatus) await tmuxSetStatus(session, false)

  // el shell recién nacido tarda un toque en estar listo; luego mandamos la
  // línea literal y, con otro respiro, el Enter (mismo patrón que el prototipo)
  // sin modelo/effort elegido NO se pasa la flag (queda el default del CLI)
  const modelFlag = model ? ` --model ${model}` : ''
  const effortFlag = effort ? ` --effort ${effort}` : ''
  const line = `${CLAUDE_BIN} ${shQuote(prompt)} --permission-mode ${mode}${modelFlag}${effortFlag}`
  await new Promise((r) => setTimeout(r, 250))
  try {
    await tmuxSendKeys(session, '-l', line)
    await new Promise((r) => setTimeout(r, 150))
    await tmuxSendKeys(session, 'Enter')
  } catch (e: any) {
    const msg = firstErrLine(e)
    throw new HttpError(500, `sesión ${session} creada, pero el envío del prompt falló: ${msg}`)
  }
  console.log(`[deck] ${new Date().toISOString()} dispatch ${dirName} (modo ${mode}${model ? `, modelo ${model}` : ''}${effort ? `, effort ${effort}` : ''}) -> sesión ${session}`)
  return c.json({ session, dir, mode, model, effort })
})

// "[+ nueva sesion aca]" (tarea 41) y el "+" de la fila de chips (tarea 43):
// crea una sesion tmux PELADA (un shell, sin lanzar claude) enraizada en un dir
// del perimetro. Es el primo del dispatch sin prompt/modelo/effort: reusa el
// mismo naming desambiguado (dispatchSessionName), la misma pref hideStatus y el
// mismo registro de MRU (recordRecentDir, tarea 39). Fire-and-forget: valida
// ANTES de tocar tmux; el frontend selecciona la sesion devuelta y salta a la
// tab Claude. Es el UNICO camino de creacion del panel por HTTP: el "+" pasa por
// aca con el default efectivo (defaultDirEffective), no por el WS.
app.post('/api/session/new', async (c) => {
  let body: { path?: unknown; hideStatus?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  const pathIn = typeof body.path === 'string' ? body.path : ''
  if (!pathIn) throw new HttpError(400, 'path requerido')
  const hideStatus = body.hideStatus === true

  let dir: string
  try {
    dir = resolveInside(pathIn) // 403 fuera de la union; ENOENT -> 404 abajo
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(404, 'directorio no encontrado')
  }
  if (!fs.statSync(dir).isDirectory()) throw new HttpError(400, 'no es un directorio')

  // mismo naming que el dispatch: varias sesiones sobre un mismo dir se apilan
  // (<nombre>-2) y los homonimos de otras raices se desambiguan por el padre
  // (ver dispatchSessionName)
  const session = await dispatchSessionName(dir)

  try {
    await runTmux(['new-session', '-d', '-s', session, '-c', dir])
  } catch (e: any) {
    const msg = firstErrLine(e)
    throw new HttpError(500, `tmux falló: ${msg}`)
  }
  // honrar la pref de ocultar la franja verde ya al nacer (fire-and-forget)
  if (hideStatus) await tmuxSetStatus(session, false)
  // MRU (tarea 39): best-effort, la sesion ya existe aunque falle la escritura
  try {
    recordRecentDir(dir)
  } catch {
    /* no crítico */
  }
  console.log(`[deck] ${new Date().toISOString()} nueva sesión pelada en ${dir} -> sesión ${session}`)
  return c.json({ session, dir })
})

// "cd acá" a un shell existente (tarea 40): manda `cd <path> && clear` al pane
// de una sesión que ya está en un shell pelado (gateado con paneAtShellPrompt,
// nunca si hay claude corriendo ahí adentro). Mismo patrón de send-keys que
// /api/dispatch (línea literal con -l, después Enter aparte) y mismo quoting
// (shQuote, ANSI-C). Fire-and-forget: valida todo ANTES de tocar tmux y
// devuelve rápido; el envío en sí es best-effort como el dispatch.
app.post('/api/session/cd', async (c) => {
  let body: { session?: unknown; path?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  const session = typeof body.session === 'string' ? body.session : ''
  if (!SESSION_RE.test(session)) throw new HttpError(400, 'nombre de sesión inválido')
  const pathIn = typeof body.path === 'string' ? body.path : ''
  if (!pathIn) throw new HttpError(400, 'path requerido')

  let dir: string
  try {
    dir = resolveInside(pathIn) // 403 fuera de la unión; ENOENT -> 404 abajo
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(404, 'directorio no encontrado')
  }
  if (!fs.statSync(dir).isDirectory()) throw new HttpError(400, 'no es un directorio')

  // gate: solo si el pane está VIVO y parado en un shell pelado (nunca con
  // claude corriendo, nunca sobre una sesión muerta)
  if (!(await paneAtShellPrompt(session))) {
    throw new HttpError(409, 'hay claude corriendo o la sesión no está en un shell')
  }

  const line = `cd ${shQuote(dir)} && clear`
  try {
    await tmuxSendKeys(session, '-l', line)
    await tmuxSendKeys(session, 'Enter')
  } catch (e: any) {
    const msg = firstErrLine(e)
    throw new HttpError(500, `cd falló: ${msg}`)
  }
  // MRU (tarea 39): best-effort, no aborta la respuesta si falla la escritura
  try {
    recordRecentDir(dir)
  } catch {
    /* no crítico */
  }
  console.log(`[deck] ${new Date().toISOString()} cd ${dir} -> sesión ${session}`)
  return c.json({ ok: true })
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

// Byte crudo de una imagen del repo, para <img src> (tarea 16). Sólo lectura,
// extensión whitelisteada, Content-Type real. Un SVG puede llevar <script>/
// handlers: como <img src> el browser NO los ejecuta, pero una navegación
// DIRECTA a esta URL sí abriría el SVG como documento de nuestro origen. Por
// eso mandamos CSP sandbox (documento sin scripts/mismo-origen) + nosniff +
// script-src 'none': aunque alguien pegue la URL en la barra, nada corre.
app.get('/api/fs/raw', async (c) => {
  const dir = await resolveFsDir(c.req.query('session'))
  const { body, type } = fsRawFile(dir, c.req.query('path') || '')
  // Buffer tipa Uint8Array<ArrayBufferLike> y c.body() exige ArrayBuffer: la
  // copia re-ancla los bytes en un ArrayBuffer propio (barata, cap 5 MB).
  return c.body(new Uint8Array(body), 200, {
    'content-type': type,
    'cache-control': 'no-cache',
    'content-security-policy': "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
  })
})

// Snippets (tarea 10): lista GLOBAL de frases para la paleta del frontend.
// Server-side a pedido de Lucas para que sincronice celu ↔ desktop — única
// escritura de "datos de la app": un JSON propio en ~/.claude-deck (fuera del
// perímetro WORKSPACES_ROOTS a propósito: no es contenido de repos).
const SNIPPETS_FILE = path.join(os.homedir(), '.claude-deck', 'snippets.json')
// presets del mockup (design-refs/task10-snippets.png): se sirven mientras no
// exista el archivo; el primer PUT los materializa (editados o no)
const SNIPPET_SEEDS = ['dale, seguí', '/compact', 'commit y push', 'sí, hacelo', 'explicá primero', '/clear']
const SNIPPETS_MAX = 50
const SNIPPET_LEN_MAX = 500

function readSnippets(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(SNIPPETS_FILE, 'utf8'))
    if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string')
  } catch {
    /* sin archivo todavía (primera vez) o JSON roto: seeds */
  }
  return [...SNIPPET_SEEDS]
}

app.get('/api/snippets', (c) => c.json({ snippets: readSnippets() }))

// Reemplaza la lista completa: la paleta edita de a una operación y manda todo
// (más simple que un CRUD por ítem para una lista de este tamaño).
app.put('/api/snippets', async (c) => {
  let body: { snippets?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  const list = body.snippets
  if (!Array.isArray(list) || list.length > SNIPPETS_MAX
    || !list.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= SNIPPET_LEN_MAX)) {
    throw new HttpError(400, `snippets: lista de hasta ${SNIPPETS_MAX} strings no vacíos (máx ${SNIPPET_LEN_MAX} caracteres)`)
  }
  fs.mkdirSync(path.dirname(SNIPPETS_FILE), { recursive: true })
  // escritura atómica (tmp + rename): un crash a mitad de write no puede
  // dejar el JSON trunco — un archivo roto degradaría la lista a los seeds
  const tmp = `${SNIPPETS_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n')
  fs.renameSync(tmp, SNIPPETS_FILE)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Directorios: pins + MRU + default (tareas 39 y 43). Mismo patrón EXACTO que
// snippets arriba (server-side para que sincronice celu ↔ desktop; JSON propio
// en ~/.claude-deck, fuera del perímetro WORKSPACES_ROOTS a propósito: es
// app-data de la app, no contenido de un repo). Shape: `pins` (curada a mano
// vía PUT) + `recent` (MRU que el propio server va escribiendo) + `defaultDir`
// (dónde nacen las sesiones del "+", elegido desde la PWA, tarea 43). Las rutas
// se guardan siempre realpath-eadas.
//
// Semillas (decisión de Lucas): a diferencia de los snippets, los pins NO se
// siembran con nada, arrancan vacíos. El array vacío sigue siendo la
// "seed" en el sentido de "lo que se sirve si el archivo no existe todavía".
// `defaultDir` arranca en null = "usá el DEFAULT_DIR del .env".
const DIRS_FILE = path.join(os.homedir(), '.claude-deck', 'dirs.json')
type DirsStore = { pins: string[]; recent: string[]; defaultDir: string | null }
const DIRS_SEEDS: DirsStore = { pins: [], recent: [], defaultDir: null }
const DIRS_PINS_MAX = 50
const DIR_PATH_LEN_MAX = 1024
// MRU: más nueva primera, dedup por ruta realpath-eada, tope 10 (decisión de Lucas).
const RECENT_DIRS_MAX = 10

function readDirs(): DirsStore {
  try {
    const raw = JSON.parse(fs.readFileSync(DIRS_FILE, 'utf8'))
    const pins = Array.isArray(raw?.pins) ? raw.pins.filter((s: unknown): s is string => typeof s === 'string') : []
    const recent = Array.isArray(raw?.recent) ? raw.recent.filter((s: unknown): s is string => typeof s === 'string') : []
    const defaultDir = typeof raw?.defaultDir === 'string' && raw.defaultDir.length > 0 ? raw.defaultDir : null
    return { pins, recent, defaultDir }
  } catch {
    /* sin archivo todavía (primera vez) o JSON roto: seeds (pins vacíos) */
    return { ...DIRS_SEEDS, pins: [...DIRS_SEEDS.pins], recent: [...DIRS_SEEDS.recent] }
  }
}

function writeDirs(data: DirsStore): void {
  fs.mkdirSync(path.dirname(DIRS_FILE), { recursive: true })
  // escritura atómica (tmp + rename), igual que snippets
  const tmp = `${DIRS_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, DIRS_FILE)
}

/** ¿Sigue siendo un dir válido? (existe, es directorio, cae dentro de la unión). */
function dirStillValid(p: string): boolean {
  try {
    const real = resolveInsideOrNull(p)
    return real !== null && fs.statSync(real).isDirectory()
  } catch {
    return false
  }
}

/**
 * Valida una ruta para guardarla en el store (pin o default): realpath, existe,
 * es directorio y cae dentro de la unión. Devuelve la realpath-eada o tira 400.
 */
function resolveStorableDir(p: string): string {
  let real: string
  try {
    real = fs.realpathSync(p)
  } catch {
    throw new HttpError(400, `ruta inexistente: ${p}`)
  }
  if (!fs.statSync(real).isDirectory()) throw new HttpError(400, `no es un directorio: ${p}`)
  // 400 (no el 403 de resolveInside): acá se valida un body, criterio del PUT
  if (!insideUnion(real)) {
    throw new HttpError(400, `fuera del perímetro (unión de WORKSPACES_ROOTS): ${p}`)
  }
  return real
}

/**
 * El "home" efectivo del panel (tarea 43): dónde nacen las sesiones nuevas y
 * sobre qué operan los endpoints sin `?session=`. Gana el default elegido desde
 * la PWA; si no hay ninguno, o el guardado dejó de ser válido (repo borrado,
 * perímetro reconfigurado), cae al `DEFAULT_DIR` del `.env`, que siempre es
 * válido porque se valida al boot. Se lee en cada uso (no se cachea): el store
 * puede cambiar en cualquier momento desde el celu, y son microsegundos.
 */
function defaultDirEffective(): string {
  const stored = readDirs().defaultDir
  if (stored && dirStillValid(stored)) return fs.realpathSync(stored)
  return DEFAULT_DIR
}

// GET filtra EN LECTURA (no persiste el filtrado): si un pin/recent dejó de
// existir o quedó fuera de la unión (repo borrado, perímetro reconfigurado),
// no se muestra, pero el archivo en disco no se toca acá. `defaultDir` sale
// EFECTIVO (nunca null): es la ruta donde el "+" va a parir la sesión, sea la
// elegida o el fallback del .env, así el frontend pinta el badge sin recalcular.
app.get('/api/dirs', (c) => {
  const stored = readDirs()
  return c.json({
    pins: stored.pins.filter(dirStillValid),
    recent: stored.recent.filter(dirStillValid),
    defaultDir: defaultDirEffective(),
  })
})

// Reemplaza POR CLAVE PRESENTE: `pins` reemplaza la lista completa (como
// snippets), `defaultDir` setea el home del panel (null = volver al .env). Una
// clave ausente NO se toca: así el pin/unpin del frontend (que manda solo
// `pins`) no pisa el default, y "hacer default" (que manda solo `defaultDir`)
// no pisa los pins. Valida todo ANTES de escribir: todo o nada.
app.put('/api/dirs', async (c) => {
  let body: { pins?: unknown; defaultDir?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  const hasPins = 'pins' in body
  const hasDefault = 'defaultDir' in body
  if (!hasPins && !hasDefault) throw new HttpError(400, 'nada que actualizar: mandá `pins` y/o `defaultDir`')

  let resolvedPins: string[] | null = null
  if (hasPins) {
    const list = body.pins
    if (!Array.isArray(list) || list.length > DIRS_PINS_MAX
      || !list.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= DIR_PATH_LEN_MAX)) {
      throw new HttpError(400, `pins: lista de hasta ${DIRS_PINS_MAX} rutas no vacías (máx ${DIR_PATH_LEN_MAX} caracteres)`)
    }
    resolvedPins = (list as string[]).map(resolveStorableDir)
  }

  let resolvedDefault: string | null = null
  if (hasDefault) {
    const d = body.defaultDir
    if (d !== null && (typeof d !== 'string' || d.trim().length === 0 || d.length > DIR_PATH_LEN_MAX)) {
      throw new HttpError(400, `defaultDir: ruta no vacía (máx ${DIR_PATH_LEN_MAX} caracteres) o null para volver al .env`)
    }
    resolvedDefault = d === null ? null : resolveStorableDir(d as string)
  }

  const current = readDirs()
  writeDirs({
    pins: resolvedPins ?? current.pins,
    recent: current.recent,
    defaultDir: hasDefault ? resolvedDefault : current.defaultDir,
  })
  return c.json({ ok: true, defaultDir: defaultDirEffective() })
})

// MRU: la llama el dispatch (esta tarea) al nacer una sesión, y la tarea 40 la
// va a llamar también desde /api/session/cd, por eso vive acá como helper de
// módulo reusable y no inline en la ruta. Guarda SIEMPRE la ruta realpath-eada;
// una ruta fuera de la unión no se registra (guard silencioso, no revienta el
// caller: esto corre fire-and-forget después de que la sesión ya existe).
function recordRecentDir(dir: string): void {
  const real = resolveInsideOrNull(dir)
  if (!real) return // no debería pasar (la sesión ya se creó ahí), pero por las dudas
  const current = readDirs()
  const recent = [real, ...current.recent.filter((p) => p !== real)].slice(0, RECENT_DIRS_MAX)
  writeDirs({ ...current, recent })
}

// Browse (tarea 39): /api/fs/list está anclado a la raíz de una SESIÓN
// (checkRepoPath), no puede navegar una ruta absoluta arbitraria de OTRA raíz
// de la unión. Este endpoint chico sí: lista subdirectorios inmediatos de
// cualquier `path` absoluto dentro de la unión (NO recursivo, solo dirs, sin
// dotdirs), lo que van a consumir las tareas 41/42 para el árbol de picker.
// Shape: `{ path: <abs realpath-eado>, dirs: string[] }` (nombres, no rutas
// completas: el cliente arma el join). Fuera de la unión: 403 (mismo criterio
// que resolveGitDir/resolveFsDir, es una resolución de ruta como esas, a
// diferencia de /api/dirs PUT que valida un body y devuelve 400).
app.get('/api/dirs/browse', (c) => {
  const raw = c.req.query('path') || ''
  if (!raw || !path.isAbsolute(raw)) throw new HttpError(400, 'path debe ser una ruta absoluta')
  let abs: string
  try {
    abs = resolveInside(raw) // 403 si cae fuera de la unión
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(404, 'directorio no encontrado') // ENOENT del realpath interno
  }
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    throw new HttpError(404, 'directorio no encontrado')
  }
  if (!st.isDirectory()) throw new HttpError(400, 'no es un directorio')
  const dirs: string[] = []
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue // .git, dotdirs
    const target = path.join(abs, d.name)
    try {
      const s = fs.statSync(target) // sigue symlinks
      // symlink que escapa de la unión: no se lista (mismo guard que fsList)
      if (s.isDirectory() && resolveInsideOrNull(target)) dirs.push(d.name)
    } catch {
      continue // symlink roto/fuera de la unión, o sin permisos
    }
  }
  dirs.sort((a, b) => a.localeCompare(b))
  return c.json({ path: abs, dirs })
})

// ---------------------------------------------------------------------------
// Web Push (tarea 23): notificaciones nativas de la PWA instalada — las maneja
// el service worker (handler notificationclick → clients.focus()/openWindow) y
// el tap CAE en la PWA. Desde la tarea 26 es la ÚNICA vía de notificación:
// ntfy se retiró por completo (Lucas no usaba los botones Permitir/Denegar,
// el único motivo del dual). Las pushes de permiso son planas: el tap abre la
// app con la sesión seleccionada y se contesta adentro. Sin suscripción NO hay
// push — por eso cada envío sin entrega se cuenta (pushMissed) y el panel lo
// muestra: la red de seguridad si Apple rota la suscripción o se reinstala la
// PWA es ese aviso + el log.
//
// VAPID con la dep `web-push` (sí a la dep — decisión de Lucas, nada de JWT a
// mano). El par de claves se genera una vez y se persiste en ~/.claude-deck;
// las subscriptions (endpoint del push service + claves p256dh/auth del
// browser) también, como app-data (mismo patrón que snippets.json). El
// AUTH_TOKEN jamás toca al push service: la firma es VAPID, y notify.sh llama a
// /api/push/send SOLO contra 127.0.0.1 con el x-deck-token.
// ---------------------------------------------------------------------------
const VAPID_FILE = path.join(os.homedir(), '.claude-deck', 'vapid.json')
const PUSH_SUBS_FILE = path.join(os.homedir(), '.claude-deck', 'push-subscriptions.json')
// asunto VAPID: los push services piden un mailto/URL de contacto. Apple lo
// VALIDA de verdad: con `mailto:...@localhost` responde 403 BadJwtToken y la
// push nunca sale (probado 2026-07-07; ntfy tapaba el fallo por la degradación
// silenciosa) — por eso el default es la DECK_URL, una https real del tailnet
// que Apple acepta (201). Override por si Lucas quiere otro contacto.
const VAPID_SUBJECT =
  process.env.DECK_VAPID_SUBJECT || process.env.DECK_URL || 'mailto:claude-deck@localhost'

type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } }

// Par VAPID persistente: se genera la primera vez y se reusa siempre (rotarlo
// invalidaría todas las subscriptions existentes). Si el archivo está roto se
// regenera — las subs viejas dejan de andar, pero es mejor que frenar el boot.
function loadVapid(): { publicKey: string; privateKey: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'))
    if (typeof raw?.publicKey === 'string' && typeof raw?.privateKey === 'string') return raw
  } catch { /* sin archivo o roto: generar abajo */ }
  const keys = webpush.generateVAPIDKeys()
  fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true })
  const tmp = `${VAPID_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2) + '\n')
  fs.renameSync(tmp, VAPID_FILE)
  return keys
}

const VAPID_KEYS = loadVapid()
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_KEYS.publicKey, VAPID_KEYS.privateKey)

function isPushSub(v: unknown): v is PushSub {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  const k = s.keys as Record<string, unknown> | undefined
  return typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint)
    && !!k && typeof k.p256dh === 'string' && typeof k.auth === 'string'
}

function readSubs(): PushSub[] {
  try {
    const raw = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8'))
    if (Array.isArray(raw)) return raw.filter(isPushSub)
  } catch { /* sin archivo todavía o roto: lista vacía */ }
  return []
}

function writeSubs(subs: PushSub[]): void {
  fs.mkdirSync(path.dirname(PUSH_SUBS_FILE), { recursive: true })
  const tmp = `${PUSH_SUBS_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(subs, null, 2) + '\n')
  fs.renameSync(tmp, PUSH_SUBS_FILE)
}

// Pushes sin entrega (tarea 26): sin ntfy no hay red de seguridad si la
// suscripción se cae (Apple la rota, PWA reinstalada) — se cuenta cada envío
// que no entregó a nadie y /api/host/status lo expone para que el panel avise.
// En memoria a propósito: un restart resetea, pero el aviso es best-effort.
let pushMissed = { count: 0, last: 0 }

// clave pública VAPID para que el frontend se suscriba (applicationServerKey).
app.get('/api/push/vapid', (c) => c.json({ publicKey: VAPID_KEYS.publicKey }))

// guarda (o refresca) una subscription del browser; dedupe por endpoint.
app.post('/api/push/subscribe', async (c) => {
  let body: { subscription?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  const sub = body.subscription
  if (!isPushSub(sub)) throw new HttpError(400, 'subscription inválida (endpoint https + keys.p256dh/auth)')
  const subs = readSubs().filter((s) => s.endpoint !== sub.endpoint)
  subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } })
  writeSubs(subs)
  pushMissed = { count: 0, last: 0 } // hay quién escuche de nuevo: aviso saldado
  return c.json({ ok: true })
})

// baja una subscription (el usuario apagó el opt-in o el browser la rotó).
app.post('/api/push/unsubscribe', async (c) => {
  let body: { endpoint?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  if (typeof body.endpoint !== 'string') throw new HttpError(400, 'endpoint requerido')
  const subs = readSubs()
  const left = subs.filter((s) => s.endpoint !== body.endpoint)
  if (left.length !== subs.length) writeSubs(left)
  return c.json({ ok: true, removed: subs.length - left.length })
})

// envía una Web Push a TODAS las subscriptions; poda las expiradas (404/410).
// Lo llama notify.sh para todos los eventos (permiso/Stop/idle) — es la única
// vía de notificación (tarea 26): un envío sin entrega alimenta pushMissed.
async function sendWebPush(payload: { title: string; body: string; url?: string; tag?: string }): Promise<number> {
  const subs = readSubs()
  const data = JSON.stringify(payload)
  const survivors: PushSub[] = []
  let sent = 0
  for (const s of subs) {
    try {
      await webpush.sendNotification(s, data, { TTL: 300 })
      sent++
      survivors.push(s)
    } catch (e) {
      // 404/410 = subscription muerta (browser desinstaló / rotó) → podar; el
      // resto de los errores (red, 5xx del push service) se conservan. Loguear
      // siempre: un rechazo silencioso acá pierde la notificación y nadie se
      // entera (así se escondió el 403 BadJwtToken del subject inválido).
      const code = (e as { statusCode?: number }).statusCode
      const detail = String((e as { body?: unknown }).body ?? (e as Error).message ?? '').slice(0, 200)
      console.log(`[deck] ${new Date().toISOString()} web push falló endpoint=…${s.endpoint.slice(-10)} status=${code ?? '?'} ${detail}`)
      if (code !== 404 && code !== 410) survivors.push(s)
    }
  }
  if (survivors.length !== subs.length) writeSubs(survivors)
  if (sent === 0) {
    pushMissed = { count: pushMissed.count + 1, last: Date.now() }
    console.log(`[deck] ${new Date().toISOString()} web push sin entrega (${subs.length} subscriptions): "${payload.title}" — ${pushMissed.count} perdidas`)
  }
  return sent
}

app.post('/api/push/send', async (c) => {
  let body: { title?: unknown; body?: unknown; url?: unknown; tag?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  const title = typeof body.title === 'string' && body.title ? body.title.slice(0, 100) : 'claude-deck'
  const text = typeof body.body === 'string' ? body.body.slice(0, 500) : ''
  const url = typeof body.url === 'string' ? body.url.slice(0, 500) : undefined
  const tag = typeof body.tag === 'string' ? body.tag.slice(0, 100) : undefined
  const sent = await sendWebPush({ title, body: text, url, tag })
  return c.json({ sent })
})

// ---------------------------------------------------------------------------
// Host (tarea 17): salud de la Mac anfitriona + alerta proactiva de batería.
// La matemática del modo remoto: `deck away` mantiene la Mac despierta a
// batería → si se agota, se cae el tailnet y quedás afuera hasta volver
// físicamente. El panel muestra el estado y un watcher server-side avisa por
// web push ANTES de que pase (el push tiene que salir sin ningún cliente mirando).
// Parsing defensivo: el formato de pmset es estable pero no documentado —
// cualquier miss devuelve null y la UI degrada (Mac de escritorio sin batería
// → battery: null y el chip no se renderiza).
// ---------------------------------------------------------------------------
type HostBattery = { pct: number; state: string }

function parsePmsetBatt(out: string): { battery: HostBattery | null; ac: boolean | null } {
  let ac: boolean | null = null
  const draw = out.match(/Now drawing from '([^']+)'/)
  if (draw) ac = draw[1].includes('AC')
  // línea típica: " -InternalBattery-0 (id=…)\t83%; discharging; 10:55 remaining present: true"
  const m = out.match(/InternalBattery[^\n]*?(\d{1,3})%;\s*([^;\n]+)/)
  if (!m) return { battery: null, ac }
  const pct = Number(m[1])
  if (pct > 100) return { battery: null, ac }
  return { battery: { pct, state: m[2].trim() }, ac }
}

async function readHostBattery(): Promise<{ battery: HostBattery | null; ac: boolean | null }> {
  try {
    return parsePmsetBatt((await execFileP('pmset', ['-g', 'batt'])).stdout)
  } catch {
    return { battery: null, ac: null } // sin pmset (no-macOS): todo null
  }
}

/** SleepDisabled de `pmset -g` — la palanca de `deck away` ("no dormirá"). */
async function readSleepDisabled(): Promise<boolean | null> {
  try {
    const m = (await execFileP('pmset', ['-g'])).stdout.match(/^\s*SleepDisabled\s+(\d)/m)
    return m ? m[1] !== '0' : null
  } catch {
    return null
  }
}

// nombre visible de la Mac ("MacBook Pro de Lucas"): no cambia nunca → cache
let hostNameCache: string | null = null
async function hostName(): Promise<string> {
  if (hostNameCache) return hostNameCache
  try {
    hostNameCache = (await execFileP('scutil', ['--get', 'ComputerName'])).stdout.trim()
  } catch { /* no-macOS o scutil raro */ }
  if (!hostNameCache) hostNameCache = os.hostname()
  return hostNameCache
}

// Estado de la alerta: server-side (el watcher corre sin ningún cliente, un
// localStorage no puede gobernarlo — decisión de Lucas 2026-07-05, igual que
// el umbral configurable). Mismo patrón de app-data que snippets.json.
const HOST_ALERT_FILE = path.join(os.homedir(), '.claude-deck', 'host-alert.json')
const HOST_ALERT_DEFAULT = { enabled: true, threshold: 30 }
const BATT_THRESHOLD_MIN = 5
const BATT_THRESHOLD_MAX = 95

function readHostAlert(): { enabled: boolean; threshold: number } {
  try {
    const raw = JSON.parse(fs.readFileSync(HOST_ALERT_FILE, 'utf8'))
    return {
      enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : HOST_ALERT_DEFAULT.enabled,
      threshold: Number.isInteger(raw?.threshold) && raw.threshold >= BATT_THRESHOLD_MIN && raw.threshold <= BATT_THRESHOLD_MAX
        ? raw.threshold
        : HOST_ALERT_DEFAULT.threshold,
    }
  } catch {
    return { ...HOST_ALERT_DEFAULT } // sin archivo todavía o JSON roto: defaults
  }
}

function writeHostAlert(alert: { enabled: boolean; threshold: number }): void {
  fs.mkdirSync(path.dirname(HOST_ALERT_FILE), { recursive: true })
  // atómico (tmp + rename), como snippets: un crash no deja JSON trunco
  const tmp = `${HOST_ALERT_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(alert, null, 2) + '\n')
  fs.renameSync(tmp, HOST_ALERT_FILE)
}

app.get('/api/host/status', async (c) => {
  const [name, { battery, ac }, sleepDisabled, crd] = await Promise.all([
    hostName(),
    readHostBattery(),
    readSleepDisabled(),
    readCrdState(),
  ])
  // pushMissed viaja acá (y no en un endpoint propio) porque este status ya se
  // pollea cada 8 s + visibilitychange: el aviso de suscripción caída sale gratis
  return c.json({
    name, battery, ac, sleepDisabled, crd, uptime: Math.round(os.uptime()), alert: readHostAlert(),
    pushMissed: pushMissed.count > 0 ? pushMissed : null,
  })
})

app.post('/api/host/alert', async (c) => {
  let body: { enabled?: unknown; threshold?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  const next = readHostAlert()
  let touched = false
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled debe ser booleano')
    next.enabled = body.enabled
    touched = true
  }
  if (body.threshold !== undefined) {
    if (typeof body.threshold !== 'number' || !Number.isInteger(body.threshold)
      || body.threshold < BATT_THRESHOLD_MIN || body.threshold > BATT_THRESHOLD_MAX) {
      throw new HttpError(400, `threshold debe ser un entero entre ${BATT_THRESHOLD_MIN} y ${BATT_THRESHOLD_MAX}`)
    }
    next.threshold = body.threshold
    touched = true
  }
  if (!touched) throw new HttpError(400, 'mandá enabled y/o threshold')
  writeHostAlert(next)
  return c.json({ ok: true, alert: next })
})

// Watcher de batería: UNA notificación por episodio de descarga, con
// histéresis — se re-arma recién al volver a corriente o al subir por encima
// de umbral + margen (cargas parciales cortas no re-disparan a cada rato).
// DECK_BATT_WATCH_MS existe para poder testear el ciclo sin esperar minutos.
const BATT_WATCH_MS = Math.max(1000, Number(process.env.DECK_BATT_WATCH_MS) || 60_000)
const BATT_REARM_MARGIN = 5
let battAlertFired = false

setInterval(async () => {
  try {
    const { battery } = await readHostBattery()
    if (!battery) return
    const alert = readHostAlert()
    const discharging = battery.state === 'discharging'
    if (!discharging || battery.pct >= alert.threshold + BATT_REARM_MARGIN) battAlertFired = false
    if (alert.enabled && discharging && battery.pct < alert.threshold && !battAlertFired) {
      battAlertFired = true // antes del push: un error de red no debe spamear
      const title = await hostName()
      const body = `🔋 Batería al ${battery.pct}% y descargando. Si se agota perdés el acceso al tailnet — enchufá la Mac o cerrá lo que no uses.`
      // web push, única vía (tarea 26); sin entrega queda el log + pushMissed
      const sent = await sendWebPush({ title, body, url: '/', tag: 'battery' })
      console.log(`[deck] ${new Date().toISOString()} batería ${battery.pct}% < ${alert.threshold}% descargando → web push (${sent})`)
    }
  } catch { /* el watcher jamás tira el server */ }
}, BATT_WATCH_MS)

// ---------------------------------------------------------------------------
// CRD (tarea 36): mantener usable el acceso remoto de Chrome Remote Desktop.
// El host de CRD corre como LaunchAgent (org.chromium.chromoting) con RunAtLoad
// pero SIN KeepAlive: si el proceso muere (auto-update del host, crash), queda
// caído hasta el próximo login y la Mac desaparece de CRD justo cuando estás
// lejos. Medido 2026-07-10: el update de anoche lo dejó muerto; un `launchctl
// kickstart` lo revive. Dos piezas: un watchdog que lo revive solo (como el de
// batería: corre sin ningún cliente mirando) y el modo away disparable desde la
// PWA (POST /api/host/away = lo que hace `deck away` con pmset, + el kickstart).
// Seguridad: subcomandos fijos (label hardcodeado, args de pmset fijos), sin
// shell, igual que el resto del server. DECK_CRD_* son overrides SOLO para tests.
// ---------------------------------------------------------------------------
const CRD_LABEL = 'org.chromium.chromoting'
// el instalador de CRD deja este marker cuando el acceso remoto está habilitado;
// sin él no hay nada que mantener vivo (CRD no instalado o deshabilitado)
const CRD_ENABLED_FILE = process.env.DECK_CRD_ENABLED_FILE
  || '/Library/PrivilegedHelperTools/org.chromium.chromoting.me2me_enabled'

type CrdState = 'running' | 'stopped' | 'absent'

async function readCrdState(): Promise<CrdState> {
  if (!fs.existsSync(CRD_ENABLED_FILE)) return 'absent'
  try {
    const out = (await execFileP('launchctl', ['print', `gui/${os.userInfo().uid}/${CRD_LABEL}`])).stdout
    return /^\s*state = running/m.test(out) ? 'running' : 'stopped'
  } catch {
    return 'stopped' // print falla con el agent descargado: instalado pero no corriendo
  }
}

// kickstart sin -k: no-op si ya corre, levanta si está muerto (idempotente)
async function kickstartCrd(): Promise<void> {
  await execFileP('launchctl', ['kickstart', `gui/${os.userInfo().uid}/${CRD_LABEL}`])
}

const CRD_WATCH_MS = Math.max(1000, Number(process.env.DECK_CRD_WATCH_MS) || 60_000)

setInterval(async () => {
  try {
    if ((await readCrdState()) !== 'stopped') return
    await kickstartCrd()
    console.log(`[deck] ${new Date().toISOString()} host CRD muerto → kickstart (${await readCrdState()})`)
  } catch { /* el watchdog jamás tira el server */ }
}, CRD_WATCH_MS)

// Modo away desde la PWA: away=true deja la Mac lista para acceso remoto (no
// dormir + host CRD vivo), away=false restaura el sueño normal (deck back).
// pmset exige la regla sudoers acotada que instala `deck install`; si falta,
// error claro (el kickstart de CRD se intenta ANTES para que al menos eso quede).
app.post('/api/host/away', async (c) => {
  let body: { away?: unknown }
  try {
    body = await c.req.json()
  } catch {
    throw new HttpError(400, 'body JSON requerido')
  }
  if (typeof body.away !== 'boolean') throw new HttpError(400, 'away debe ser booleano')
  let crd = await readCrdState()
  if (body.away && crd === 'stopped') {
    try {
      await kickstartCrd()
      crd = await readCrdState()
    } catch { /* estado queda como esté: lo reporta la respuesta */ }
  }
  try {
    await execFileP('sudo', ['-n', '/usr/bin/pmset', '-a', 'disablesleep', body.away ? '1' : '0'])
  } catch {
    throw new HttpError(500, 'pmset necesita sudo sin password: corré `scripts/deck install` en la Mac (regla sudoers)')
  }
  const sleepDisabled = await readSleepDisabled()
  if (sleepDisabled !== body.away) throw new HttpError(500, 'pmset corrió pero SleepDisabled no quedó aplicado')
  return c.json({ ok: true, sleepDisabled, crd })
})

// Estáticos (con auth, servidos desde PUBLIC_DIR: web/dist)
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

app.get('*', (c) => {
  let p = decodeURIComponent(new URL(c.req.url).pathname)
  if (p === '/') p = '/index.html'
  const abs = path.normalize(path.join(PUBLIC_DIR, p))
  // perímetro secundario de estáticos: léxico a propósito, sin realpath
  // (PUBLIC_DIR no está realpath-eado; ver la doc del guardián)
  if (!insideDir(abs, PUBLIC_DIR)) return c.text('Not found', 404)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return c.text('Not found', 404)
  const body = new Uint8Array(fs.readFileSync(abs))
  // Vite emite /assets/* con nombres hasheados por contenido → cachear a full;
  // el resto (index.html, sw.js, manifest…) sigue no-cache para no servir stale.
  const cacheControl = p.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
  return c.body(body, 200, {
    'content-type': MIME[path.extname(abs)] || 'application/octet-stream',
    'cache-control': cacheControl,
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

  // Presencia (tarea 3): registrado ANTES de cualquier await — la PWA manda
  // {t:'vis'} apenas abre el socket, y ws no bufferea mensajes sin listener:
  // si esto viviera en el handler principal (que recién se registra después
  // del spawn del pty), ese primer report se perdería en la ventana del spawn.
  ws.on('message', (raw: RawData) => {
    let m: any
    try { m = JSON.parse(String(raw)) } catch { return }
    if (m.t === 'vis') presence.set(ws, { session: tmuxName, visible: m.visible === true, at: Date.now() })
  })
  ws.on('close', () => { presence.delete(ws) })

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
    // `; set-option status <on|off>`: refleja la pref de la PWA (statusbar=off)
    // al attachear, siempre explícito para RE-encender si otro cliente la apagó.
    // `-c`: solo pesa si la sesión NO existe todavía (attach-or-create). Desde
    // la tarea 43 el "+" de los chips crea por HTTP (/api/session/new) con un
    // dir explícito, así que el único nacimiento que pasa por acá es el de la
    // sesión default (bootstrap): va al home efectivo, no al DEFAULT_DIR pelado.
    const homeDir = defaultDirEffective()
    const statusOn = url.searchParams.get('statusbar') !== 'off'
    p = pty.spawn('tmux', ['new-session', '-A', '-s', tmuxName, '-c', homeDir, ';', 'set-option', 'mouse', 'on', ';', 'set-option', 'status', statusOn ? 'on' : 'off'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: homeDir,
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
      // resume desde el celular: forzar un repaint COMPLETO del pane. El freeze
      // de iOS deja el buffer local de xterm corrupto (frames perdidos), y el
      // único camino que lo arreglaba era abrir el teclado: eso achica el
      // viewport → cambian los rows → resize REAL del pty → SIGWINCH → tmux
      // re-emite TODO el grid. Un resize al mismo tamaño (lo que hace doFit al
      // volver, con el viewport intacto) es no-op y no dispara redraw, y
      // refresh-client solo redibuja lo que tmux cree sucio. Replicamos el
      // teclado con un "ghost resize" (una fila menos y de vuelta) que invalida
      // el modelo de pantalla de tmux y fuerza el redraw completo; de paso
      // garantiza al menos un 'out' (señal de vida para el watchdog del cliente).
      const c = p.cols
      const r = p.rows
      if (typeof c === 'number' && typeof r === 'number' && c >= 20 && r > 5) {
        try {
          p.resize(c, r - 1)
          setTimeout(() => { try { p.resize(c, r) } catch { /* pty ya muerto */ } }, 50)
        } catch { void tmuxRefreshClients(tmuxName) }
      } else {
        // dims degeneradas (pty recién nacido o tamaño inválido): al menos pedir
        // el redibujo estándar
        void tmuxRefreshClients(tmuxName)
      }
    } else if (m.t === 'statusbar') {
      // toggle en vivo del status bar de tmux desde el sheet de ajustes; el
      // estado inicial ya vino por el query param al attachear
      void tmuxSetStatus(tmuxName, m.on === true)
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
