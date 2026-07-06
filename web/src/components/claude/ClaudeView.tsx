import { SessionRow } from './SessionRow'
import { Hint } from './Hint'
import { Terminal } from './Terminal'
import { ControlBar } from './ControlBar'

// Pestaña Claude (index.html:22-134). SIEMPRE montada (§5.1): el div del
// terminal no puede desmontarse jamás. Fase 2: fila de sesiones + hint +
// terminal + quickkeys. Pendientes:
//   Fase 3 → pills/adjuntar/snippets/composer en ControlBar + Composer
//   Fase 4 → HostBanner + Scrollback
export function ClaudeView() {
  return (
    <>
      <SessionRow />
      <Hint />
      {/* Fase 4: #host-banner */}
      <Terminal />
      {/* Fase 3: #composer  ·  Fase 4: #scrollback */}
      <ControlBar />
    </>
  )
}
