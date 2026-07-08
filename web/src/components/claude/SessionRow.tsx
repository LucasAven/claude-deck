import { useDeckStore } from '../../store'
import { openCreateMenu } from '../../lib/worktree'
import { openSettingsSheet } from '../../lib/settings'
import { useTap } from '../../hooks/useTap'
import { useChipDrag } from '../../hooks/useChipDrag'

// Fila de sesiones (index.html:23-33): chips + botón + y engranaje de ajustes
// (que reemplazó a la campana de push — el toggle vive en el SettingsSheet).
// El chip de batería y el punto de conexión se mudaron a la Statusline.
// Port de refreshSessions/selectSession/renameSession/
// killSession/createSession (app.js:1443-1628) — la lógica vive en el store; acá
// solo se pinta. React reconcilia, así que el chipsKey anti-parpadeo ya no hace
// falta, pero el orden y la estructura del DOM se conservan: .chip con
// .chip-dot chip-dot-<estado> opcional + label; el activo suma .chip-name (tap →
// rename) y .chip-x (tap → kill). Rename/kill/confirm siguen con prompt/confirm.

function Chip({ name, state, active, lifted }: { name: string; state?: string; active: boolean; lifted: boolean }) {
  const selectSession = useDeckStore((s) => s.selectSession)
  const renameSession = useDeckStore((s) => s.renameSession)
  const killSession = useDeckStore((s) => s.killSession)

  // el chip activo ya no navega (selectSession retorna temprano): el nombre
  // renombra y la ✕ mata. Se usa onClick simple (como el vanilla): estos taps
  // no necesitan mantener el foco del teclado como las quickkeys.
  // data-name: lo lee el hit-test del drag (tarea 19). lifted: chip levantado.
  return (
    <button
      className={'chip' + (active ? ' active' : '') + (lifted ? ' dragging' : '')}
      data-name={name}
      onClick={() => selectSession(name)}
    >
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
  const createSession = useDeckStore((s) => s.createSession)

  // tarea 5: el + pasó de click simple a useTap para ganar el long-press (menú
  // CREAR); el tap corto sigue creando sesión igual que siempre
  const addTap = useTap(() => createSession(), openCreateMenu)
  // el engranaje va por useTap (no onClick): el `click` fantasma que el
  // navegador sintetiza al cerrar un overlay encima lo abriría solo (misma
  // trampa que el host-chip, tarea 20)
  const settingsTap = useTap(() => openSettingsSheet())

  // tarea 19: drag para reordenar. El hook devuelve el orden en vivo (durante el
  // drag) y el chip levantado; fuera del drag displayNames == orden del store.
  const { ref: chipsRef, handlers: dragHandlers, displayNames, lifted } = useChipDrag(sessions)
  const stateByName: Record<string, string | undefined> = {}
  for (const s of sessions) stateByName[s.name] = s.state

  return (
    <div className="session-row">
      <div id="session-chips" className="chips" ref={chipsRef} {...dragHandlers}>
        {displayNames.map((name) => (
          <Chip key={name} name={name} state={stateByName[name]} active={name === session} lifted={name === lifted} />
        ))}
      </div>
      <button id="btn-new-session" className="chip chip-add" title="Nueva sesión" {...addTap}>
        +
      </button>
      {/* engranaje: abre el sheet de ajustes (push + batería + quickkeys) */}
      <button id="btn-settings" className="chip settings-chip" title="Ajustes" {...settingsTap}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
        </svg>
      </button>
    </div>
  )
}
