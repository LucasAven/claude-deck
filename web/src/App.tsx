import { useEffect } from 'react'
import { useDeckStore, restoreInitialSession } from './store'
import { useViewportGeometry } from './hooks/useViewportGeometry'
import { usePolling } from './hooks/usePolling'
import { TabBar } from './components/TabBar'
import { AuthError } from './components/AuthError'
import { SnipTip } from './components/SnipTip'

// Shell de la app (index.html:20-203). Las tres <section class="view"> están
// SIEMPRE montadas y se togglea .active por CSS — la vista Claude no puede
// desmontarse jamás (xterm + WS viven en un singleton, §5.1). El contenido de
// cada vista y los overlays los llenan las fases siguientes:
//   Fase 2 → SessionRow + Terminal (dentro de #view-claude)
//   Fase 3 → ControlBar + Composer + SwitchMenu + Snippets
//   Fase 4 → Scrollback + HostSheet + HostBanner
//   Fase 5 → ChangesView + FilesView
export function App() {
  const activeTab = useDeckStore((s) => s.activeTab)

  // arranque: config + sesión inicial (localStorage / deep-link). El terminal
  // se crea en la Fase 2; acá solo dejamos elegida la sesión y el primer git.
  useEffect(() => {
    restoreInitialSession().then(() => {
      useDeckStore.getState().refreshGit() // primer badge de Cambios sin esperar el poll
    })
  }, [])

  useViewportGeometry()
  usePolling()

  const cls = (name: string) => 'view' + (activeTab === name ? ' active' : '')

  return (
    <>
      <div id="app">
        {/* Pestaña Claude — SessionRow + Terminal + ControlBar (Fases 2/3) */}
        <section id="view-claude" className={cls('claude')} />

        {/* Pestaña Cambios — header + lista + diff (Fase 5) */}
        <section id="view-changes" className={cls('changes')} />

        {/* Pestaña Archivos — árbol + vista de archivo (Fase 5) */}
        <section id="view-files" className={cls('files')} />

        {/* overlays globales siempre montados (Fase 3/4): host-sheet, etc. */}
        <SnipTip />

        <TabBar />
      </div>
      <AuthError />
    </>
  )
}
