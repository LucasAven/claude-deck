import { useDeckStore } from '../../store'
import { useTap } from '../../hooks/useTap'
import { closeSettingsSheet } from '../../lib/settings'
import { openHostSheet } from '../../lib/host'
import { openQuickkeysSheet } from '../../lib/quickkeys'
import { togglePush } from '../../lib/push'

// Sheet de ajustes: lo abre el engranaje de la fila de sesiones (que reemplazó
// a la campana suelta). Esqueleto host-sheet (siempre montado, toggle hidden,
// backdrop cierra). Tres filas:
//  · Notificaciones push (tarea 23): el switch reemplaza a la campana; con
//    permiso denegado la fila queda atenuada (togglePush ya es no-op ahí) y el
//    subtítulo lo explica. Sin soporte (Safari suelto, no PWA) no se renderiza.
//  · Batería del equipo (tarea 17): navega al host-sheet de siempre (cerrando
//    este — comparten z-index, no se apilan).
//  · Teclas rápidas (tarea 11b): abre el editor de la barra — reemplaza al
//    long-press sobre las quickkeys.
// TODO va con useTap, nunca onClick: el sheet se cierra sobre la controlbar y
// un click fantasma sobre lo que quede debajo repetiría el bug de las tareas
// 20/27 (con la campana podía DESUSCRIBIR el push solo).

const svg = (body: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {body}
  </svg>
)
const SET_ICONS = {
  bell: svg(
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z" />
      <path d="M10.5 19a1.8 1.8 0 0 0 3 0" />
    </>,
  ),
  batt: svg(
    <>
      <rect x="2" y="7.5" width="17" height="9" rx="2.5" />
      <path d="M22 10.5v3" />
    </>,
  ),
  keys: svg(
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" />
    </>,
  ),
}

export function SettingsSheet() {
  const open = useDeckStore((s) => s.settingsSheetOpen)
  const pushState = useDeckStore((s) => s.pushState)
  const h = useDeckStore((s) => s.hostStatus)

  const pushTap = useTap(() => togglePush())
  const battTap = useTap(() => {
    closeSettingsSheet()
    openHostSheet()
  })
  const qkTap = useTap(() => {
    closeSettingsSheet()
    openQuickkeysSheet()
  })

  const pushSub =
    pushState === 'denied'
      ? 'Permiso denegado — activalo en Ajustes del sistema'
      : 'Cuando el agente termina o pide permiso'
  // "MacBook Pro de Lucas · 67% · alertas" (sin batería queda "Mac · alertas")
  const battSub = h ? [h.name || 'Mac', h.battery ? `${h.battery.pct}%` : null, 'alertas'].filter(Boolean).join(' · ') : ''

  return (
    <div
      id="settings-sheet"
      className={'host-sheet' + (open ? '' : ' hidden')}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSettingsSheet()
      }}
    >
      <div className="host-sheet-panel">
        <div className="sheet-grip" />
        <div className="set-title">Ajustes</div>
        {pushState !== 'unsupported' && (
          <div id="set-push-row" className={'set-row' + (pushState === 'denied' ? ' denied' : '')}>
            <span className="set-ico">{SET_ICONS.bell}</span>
            <div className="set-info">
              <div className="set-label">Notificaciones push</div>
              <div className="set-sub">{pushSub}</div>
            </div>
            <button
              id="push-toggle"
              className={'switch' + (pushState === 'on' ? ' on' : '')}
              role="switch"
              title="Notificaciones push"
              {...pushTap}
            />
          </div>
        )}
        {h && (
          <button id="set-batt-row" className="set-row" {...battTap}>
            <span className="set-ico">{SET_ICONS.batt}</span>
            <div className="set-info">
              <div className="set-label">Batería del equipo</div>
              <div className="set-sub">{battSub}</div>
            </div>
            <span className="set-chev">›</span>
          </button>
        )}
        <button id="set-qk-row" className="set-row" {...qkTap}>
          <span className="set-ico">{SET_ICONS.keys}</span>
          <div className="set-info">
            <div className="set-label">Teclas rápidas</div>
            <div className="set-sub">Editar la barra de la terminal</div>
          </div>
          <span className="set-chev">›</span>
        </button>
      </div>
    </div>
  )
}
