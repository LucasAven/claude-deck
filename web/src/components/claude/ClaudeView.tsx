import { SessionRow } from './SessionRow'
import { Hint } from './Hint'
import { HostBanner } from './HostBanner'
import { Terminal } from './Terminal'
import { Composer } from './Composer'
import { Scrollback } from './Scrollback'
import { ControlBar } from './ControlBar'

// Pestaña Claude (index.html:22-134). SIEMPRE montada (§5.1): el div del
// terminal no puede desmontarse jamás. Fase 2: sesiones + hint + terminal +
// quickkeys. Fase 3: composer + pills/adjuntar/snippets en ControlBar.
// Fase 4: HostBanner (roba filas a la terminal) + Scrollback. El orden del DOM
// sigue a index.html: session-row → hint → host-banner → term → composer →
// scrollback → controlbar.
export function ClaudeView() {
  return (
    <>
      <SessionRow />
      <Hint />
      <HostBanner />
      <Terminal />
      <Composer />
      <Scrollback />
      <ControlBar />
    </>
  )
}
