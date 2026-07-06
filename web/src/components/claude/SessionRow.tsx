import { useDeckStore } from '../../store'

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

  return (
    <div className="session-row">
      <div id="session-chips" className="chips">
        {sessions.map((s) => (
          <Chip key={s.name} name={s.name} state={s.state} active={s.name === session} />
        ))}
      </div>
      {/* + usa click simple, como el vanilla (app.js:2182) — no useTap */}
      <button
        id="btn-new-session"
        className="chip chip-add"
        title="Nueva sesión"
        onClick={() => createSession()}
      >
        +
      </button>
      {/* chip de batería del host: Fase 4 (host-chip) */}
      <span className={'conn' + (connected ? ' on' : '')} id="conn-claude">
        <span className="dot" />
      </span>
    </div>
  )
}
