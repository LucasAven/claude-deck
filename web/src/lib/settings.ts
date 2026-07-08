import { useDeckStore } from '../store'

// Sheet de ajustes: bottom sheet (esqueleto host-sheet) que abre el engranaje
// de la fila de sesiones. Agrupa el opt-in de Web Push (antes la campana suelta,
// tarea 23), el acceso al panel de batería del host (tarea 17) y el editor de
// quickkeys (tarea 11b, antes long-press sobre la barra).

export function openSettingsSheet() {
  useDeckStore.setState({ settingsSheetOpen: true })
}

export function closeSettingsSheet() {
  useDeckStore.setState({ settingsSheetOpen: false })
}

// toggle del status bar de tmux (franja verde): flip + persist + aplicar en vivo
// a la sesión attacheada. El estado inicial de cada attach viaja por el query
// param statusbar=off (ver term.ts); esto cubre el cambio sin reconectar.
export function toggleTmuxStatus() {
  const hide = !useDeckStore.getState().hideTmuxStatus
  useDeckStore.setState({ hideTmuxStatus: hide })
  try {
    localStorage.setItem('deck-hide-tmux-status', hide ? '1' : '0')
  } catch {
    /* modo privado: no crítico */
  }
  window.claudeConn?.setStatusBar(!hide)
}
