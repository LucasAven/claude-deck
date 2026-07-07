import { useDeckStore, sessionQuery, type ClaudeStatus } from '../store'
import { api } from './api'

// Statusline del panel (tarea 22): línea fina tipo statusLine de Claude Code con
// % de contexto usado + tokens (+ modelo y costo de la sesión, que vienen gratis
// en el mismo JSON). Fuente: GET /api/claude/status?session=, que lee el
// <sesión>.status.json que escribe el hook statusLine (scripts/statusline.sh).
// Se refresca en el poll de 8 s existente (piggyback, sin poll nuevo) y al
// cambiar de sesión. Contrato blando: ausente → claudeStatus null (línea oculta).

// Umbral de alerta: el contexto se acerca al límite. Se pinta ámbar/rojo cuando
// el % RESTANTE cae bajo estos umbrales (o si el server marca exceeds200k).
// Nota: el endpoint expone ctxPct = context_window.used_percentage (verdad
// server-side, contrato ya testeado). El "restante" es exactamente 100 - usado
// (verificado en el probe: usado 15 ⇄ restante 85), así que se invierte SOLO en
// el display — no se toca el campo del endpoint. Los cortes de restante 25/10
// son equivalentes a los de usado 75/90 de antes (100 - usado).
export const CTX_WARN_REMAINING = 25
export const CTX_ALERT_REMAINING = 10

export type CtxLevel = 'ok' | 'warn' | 'alert'

// Contexto restante (%) para el display; null si el hook aún no lo reporta.
export function ctxRemaining(s: ClaudeStatus | null): number | null {
  if (!s || s.ctxPct == null) return null
  return 100 - s.ctxPct
}

export function ctxLevel(s: ClaudeStatus | null): CtxLevel {
  if (!s) return 'ok'
  if (s.exceeds200k) return 'alert'
  const rem = ctxRemaining(s)
  if (rem == null) return 'ok'
  if (rem <= CTX_ALERT_REMAINING) return 'alert'
  if (rem <= CTX_WARN_REMAINING) return 'warn'
  return 'ok'
}

// Tokens compactos: 30060 → "30k", 1_234_567 → "1.2M". El statusLine muestra el
// total de input (lo que llena el contexto) — es la cifra que le importa a Lucas.
export function fmtTokens(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// Costo de la sesión: siempre en centavos-legibles (0.0235 → "$0.02", 1.5 → "$1.50").
export function fmtCost(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return ''
  return `$${n.toFixed(2)}`
}

export async function refreshStatus(): Promise<void> {
  const session = useDeckStore.getState().session
  if (!session) return
  try {
    const res = await api(`/api/claude/status?${sessionQuery(session)}`)
    if (!res.ok) return // transitorio: conservar el último estado
    const data = (await res.json()) as { status: ClaudeStatus | null }
    // ojo carrera: si el usuario cambió de sesión mientras esperábamos, descartar
    if (useDeckStore.getState().session !== session) return
    useDeckStore.setState({ claudeStatus: data.status })
  } catch {
    /* error de red: conservar */
  }
}

// puente para ui-test.mjs (mockea fetch y llama refreshStatus() global, igual
// que refreshHost) y para selectSession en el store (evita el ciclo de imports)
if (typeof window !== 'undefined') window.refreshClaudeStatus = refreshStatus
