import { useDeckStore } from '../../store'
import { battLow, openHostSheet } from '../../lib/host'
import { openCreateMenu } from '../../lib/worktree'
import { togglePush } from '../../lib/push'
import { useTap } from '../../hooks/useTap'

// Fila de sesiones (index.html:23-33): chips + botón +, chip de host (Fase 4) y
// el punto de conexión. Port de refreshSessions/selectSession/renameSession/
// killSession/createSession (app.js:1443-1628) — la lógica vive en el store; acá
// solo se pinta. React reconcilia, así que el chipsKey anti-parpadeo ya no hace
// falta, pero el orden y la estructura del DOM se conservan: .chip con
// .chip-dot chip-dot-<estado> opcional + label; el activo suma .chip-name (tap →
// rename) y .chip-x (tap → kill). Rename/kill/confirm siguen con prompt/confirm.

function Chip({ name, state, active }: { name: string; state?: string; active: boolean }) {
  const selectSession = useDeckStore((s) => s.selectSession)
  const renameSession = useDeckStore((s) => s.renameSession)
  const killSession = useDeckStore((s) => s.killSession)

  // el chip activo ya no navega (selectSession retorna temprano): el nombre
  // renombra y la ✕ mata. Se usa onClick simple (como el vanilla): estos taps
  // no necesitan mantener el foco del teclado como las quickkeys.
  return (
    <button className={'chip' + (active ? ' active' : '')} onClick={() => selectSession(name)}>
      {state && <span className={'chip-dot chip-dot-' + state} />}
      {active ? (
        <>
          <span
            className="chip-name"
            title="Renombrar sesión"
            onClick={(e) => {
              e.stopPropagation()
              renameSession(name)
            }}
          >
            {name}
          </span>
          <span
            className="chip-x"
            title="Matar sesión"
            onClick={(e) => {
              e.stopPropagation()
              killSession(name)
            }}
          >
            ✕
          </span>
        </>
      ) : (
        <span>{name}</span>
      )}
    </button>
  )
}

export function SessionRow() {
  const sessions = useDeckStore((s) => s.sessions)
  const session = useDeckStore((s) => s.session)
  const connected = useDeckStore((s) => s.connected)
  const createSession = useDeckStore((s) => s.createSession)
  const hostStatus = useDeckStore((s) => s.hostStatus)

  // tarea 5: el + pasó de click simple a useTap para ganar el long-press (menú
  // CREAR); el tap corto sigue creando sesión igual que siempre
  const addTap = useTap(() => createSession(), openCreateMenu)

  // chip 🔋 solo si el host reporta batería (Mac de escritorio / pmset ilegible
  // → null); la barrita interna del ícono refleja el nivel (ancho útil 13.2px)
  const batt = hostStatus?.battery
  const fillW = batt ? Math.max(0.8, (13.2 * batt.pct) / 100).toFixed(1) : '0'

  // botón de opt-in de Web Push (tarea 23): oculto si el browser no soporta
  // (degradación silenciosa a ntfy). Ámbar cuando estás suscripto; el tap
  // alterna suscribir/desuscribir (o informa el permiso denegado).
  const pushState = useDeckStore((s) => s.pushState)
  const pushTitle =
    pushState === 'on'
      ? 'Notificaciones activas · tocá para desactivar'
      : pushState === 'denied'
        ? 'Permiso de notificaciones denegado (activalo en Ajustes)'
        : 'Activar notificaciones en esta app'

  return (
    <div className="session-row">
      <div id="session-chips" className="chips">
        {sessions.map((s) => (
          <Chip key={s.name} name={s.name} state={s.state} active={s.name === session} />
        ))}
      </div>
      <button id="btn-new-session" className="chip chip-add" title="Nueva sesión" {...addTap}>
        +
      </button>
      {/* chip de batería del host: pineado como el +, tap abre el sheet */}
      <button
        id="host-chip"
        className={'chip host-chip' + (batt ? '' : ' hidden') + (battLow(hostStatus) ? ' warn' : '')}
        title="Estado de la Mac"
        onClick={() => openHostSheet()}
      >
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7.5" width="17" height="9" rx="2.5" />
          <path d="M22 10.5v3" />
          <rect id="host-batt-fill" x="4.2" y="9.7" width={fillW} height="4.6" rx="1" fill="currentColor" stroke="none" />
        </svg>
        <span id="host-chip-pct">{batt ? `${batt.pct}%` : ''}</span>
      </button>
      {/* opt-in de Web Push (tarea 23): campana, oculta si no hay soporte */}
      <button
        id="btn-push"
        className={
          'chip push-chip' +
          (pushState === 'unsupported' ? ' hidden' : '') +
          (pushState === 'on' ? ' active' : '') +
          (pushState === 'denied' ? ' denied' : '')
        }
        title={pushTitle}
        onClick={() => togglePush()}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z" />
          <path d="M10.5 19a1.8 1.8 0 0 0 3 0" />
          {pushState === 'on' && <circle cx="18" cy="6" r="3" fill="currentColor" stroke="none" />}
        </svg>
      </button>
      <span className={'conn' + (connected ? ' on' : '')} id="conn-claude">
        <span className="dot" />
      </span>
    </div>
  )
}
