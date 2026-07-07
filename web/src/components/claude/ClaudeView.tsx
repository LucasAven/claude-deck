import { SessionRow } from './SessionRow'
import { CreateMenu } from './CreateMenu'
import { Hint } from './Hint'
import { HostBanner } from './HostBanner'
import { PushBanner } from './PushBanner'
import { Terminal } from './Terminal'
import { Composer } from './Composer'
import { Scrollback } from './Scrollback'
import { Statusline } from './Statusline'
import { ControlBar } from './ControlBar'

// Pestaña Claude (index.html:22-134). SIEMPRE montada (§5.1): el div del
// terminal no puede desmontarse jamás. Fase 2: sesiones + hint + terminal +
// quickkeys. Fase 3: composer + pills/adjuntar/snippets en ControlBar.
// Fase 4: HostBanner (roba filas a la terminal) + Scrollback. El orden del DOM
// sigue a index.html: session-row → hint → host-banner → push-banner → term →
// composer → scrollback → controlbar (PushBanner es post-port, tarea 26).
export function ClaudeView() {
  return (
    <>
      <SessionRow />
      <CreateMenu />
      <Hint />
      <HostBanner />
      <PushBanner />
      <Terminal />
      <Composer />
      <Scrollback />
      <Statusline />
      <ControlBar />
    </>
  )
}
