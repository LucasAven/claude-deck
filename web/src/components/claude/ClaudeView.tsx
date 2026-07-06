import { SessionRow } from './SessionRow'
import { Hint } from './Hint'
import { Terminal } from './Terminal'
import { Composer } from './Composer'
import { ControlBar } from './ControlBar'

// Pestaña Claude (index.html:22-134). SIEMPRE montada (§5.1): el div del
// terminal no puede desmontarse jamás. Fase 2: sesiones + hint + terminal +
// quickkeys. Fase 3: composer + pills/adjuntar/snippets en ControlBar.
// Pendiente Fase 4: HostBanner + Scrollback. El orden del DOM sigue a index.html:
// session-row → hint → term → composer → controlbar.
export function ClaudeView() {
  return (
    <>
      <SessionRow />
      <Hint />
      {/* Fase 4: #host-banner */}
      <Terminal />
      <Composer />
      {/* Fase 4: #scrollback */}
      <ControlBar />
    </>
  )
}
