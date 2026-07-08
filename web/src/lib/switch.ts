import { useDeckStore } from '../store'
import type { SwitchState } from '../store'
import { hideSnipTip } from './sniptip'

// Switchers de modo (shift+tab) y modelo/esfuerzo (/model, /effort). Port de
// app.js:341-474. Modo: cada tap manda UN shift+tab (\x1b[Z), igual que en la
// terminal — la app no puede leer el estado real de Claude desde el pty, así que
// la pill tiene label fijo. Modelo/esfuerzo se persisten por sesión en
// deck-switch:<sesión>. El popover #switch-menu es único: kind vive en el store.

export function loadSwitch(session: string | null): SwitchState {
  try {
    return (JSON.parse(localStorage.getItem(`deck-switch:${session}`) || 'null') as SwitchState) || {}
  } catch {
    return {}
  }
}

export function saveSwitch(session: string | null, sw: SwitchState) {
  try {
    localStorage.setItem(`deck-switch:${session}`, JSON.stringify(sw))
  } catch {
    /* localStorage puede fallar (modo privado) */
  }
}

export function closeSwitchMenu() {
  if (useDeckStore.getState().switchMenu !== null) useDeckStore.setState({ switchMenu: null })
  hideSnipTip() // que el tooltip no sobreviva a la paleta
}

// toggle: si ya está abierto CON este kind, cerrarlo; si muestra otro, re-pintarlo
function toggle(kind: 'model' | 'attach') {
  if (useDeckStore.getState().switchMenu === kind) {
    closeSwitchMenu()
    return
  }
  useDeckStore.setState({ switchMenu: kind })
}

export const openModelMenu = () => toggle('model')
export const openAttachMenu = () => toggle('attach')

// un shift+tab por llamada (la app no lee el modo real del pty; el estado se
// mira en la terminal). No cierra el menú acá: #btn-mode no está en la lista de
// exclusión del closer global de App, así que si el popover estaba abierto el
// propio pointerdown del tap ya lo cerró
export function cycleMode() {
  window.claudeConn?.sendKeys('\x1b[Z')
}

// manda un slash command al prompt de Claude; el Enter va aparte con una pausa
// corta para que el autocomplete de "/" no se coma el submit (app.js:386-390)
export function sendSlashCommand(cmd: string) {
  const conn = window.claudeConn
  if (!conn) return
  conn.sendKeys(cmd)
  setTimeout(() => window.claudeConn?.sendKeys('\r'), 150)
}
