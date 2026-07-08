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
