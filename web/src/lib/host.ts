import { useDeckStore, type HostStatus } from '../store'
import { api } from './api'

// Panel de host + alerta de batería (app.js:1233-1416): la Mac que sirve el deck
// es el único camino al tailnet — si `deck away` la deja despierta a batería y se
// agota, quedás afuera. Chip "🔋 N%" en la fila de sesiones (solo si el host
// reporta batería), banner ámbar sobre la terminal cuando descarga bajo el
// umbral, y bottom sheet con el detalle + toggle de la alerta push (server-side:
// el watcher corre sin ningún cliente — POST /api/host/alert).

export const BATT_STATES: Record<string, string> = {
  discharging: 'descargando',
  charging: 'cargando',
  charged: 'cargada',
  'finishing charge': 'terminando carga',
  'AC attached': 'en corriente',
}

export function fmtUptime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// condición del banner y del chip en alerta: descargando bajo el umbral
export function battLow(status: HostStatus | null): boolean {
  const b = status?.battery
  return !!(b && b.state === 'discharging' && b.pct < status!.alert.threshold)
}

export async function refreshHost(): Promise<void> {
  let status: HostStatus
  try {
    const res = await api('/api/host/status')
    if (!res.ok) return // error transitorio: conservar el último estado
    status = (await res.json()) as HostStatus
  } catch {
    return
  }
  const patch: Partial<{ hostStatus: HostStatus; hostBannerDismissed: boolean }> = { hostStatus: status }
  // terminó el episodio de descarga → re-armar el banner que se descartó
  if (!battLow(status)) patch.hostBannerDismissed = false
  useDeckStore.setState(patch)
}

export function openHostSheet() {
  if (!useDeckStore.getState().hostStatus) return
  useDeckStore.setState({ hostSheetOpen: true })
  refreshHost() // datos frescos al abrir (el poll es de 8 s)
}

export function closeHostSheet() {
  useDeckStore.setState({ hostSheetOpen: false })
}

// ✕ del banner: vale por episodio de descarga (se re-arma en refreshHost al salir)
export function dismissHostBanner() {
  useDeckStore.setState({ hostBannerDismissed: true })
}

// el toggle y el umbral gobiernan el watcher DEL SERVER (no un estado local)
async function postHostAlert(patch: { enabled?: boolean; threshold?: number }) {
  try {
    const res = await api('/api/host/alert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        msg = (await res.json()).error || msg
      } catch {
        /* sin body json */
      }
      alert(`No se pudo guardar la alerta: ${msg}`)
      return
    }
    const data = await res.json()
    const cur = useDeckStore.getState().hostStatus
    if (cur) {
      const status: HostStatus = { ...cur, alert: data.alert }
      const next: Partial<{ hostStatus: HostStatus; hostBannerDismissed: boolean }> = { hostStatus: status }
      if (!battLow(status)) next.hostBannerDismissed = false // el umbral también mueve el banner/chip
      useDeckStore.setState(next)
    }
  } catch (e) {
    if (String((e as Error).message) !== '401') alert('No se pudo guardar la alerta (error de red)')
  }
}

export function toggleHostAlert() {
  const h = useDeckStore.getState().hostStatus
  if (h) postHostAlert({ enabled: !h.alert.enabled })
}

// umbral configurable con el prompt() low-fi de siempre (rename, snippets)
export function editHostThreshold() {
  const h = useDeckStore.getState().hostStatus
  if (!h) return
  const input = window.prompt('Avisar cuando la batería baje de (%):', String(h.alert.threshold))
  if (input === null) return
  const n = Number.parseInt(input.trim(), 10)
  if (!Number.isFinite(n) || n < 5 || n > 95) {
    alert('Umbral inválido: un entero entre 5 y 95')
    return
  }
  postHostAlert({ threshold: n })
}

// puente para ui-test.mjs: la sección de host mockea fetch y llama refreshHost()
// (global) para repintar chip/banner/sheet, igual que en el vanilla
if (typeof window !== 'undefined') window.refreshHost = refreshHost
