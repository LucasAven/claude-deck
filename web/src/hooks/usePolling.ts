import { useEffect } from 'react'
import { useDeckStore } from '../store'
import { refreshHost } from '../lib/host'
import { refreshTree } from '../lib/files'

// Auto-refresh cada 8 s mientras la pestaña esté visible + manejo de
// visibilitychange (app.js:2185-2208). refreshGit y refreshHost corren en
// cualquier tab (badge de Cambios y chip de batería siempre al día).
//
// Fase 1: presencia (sendVis) + git. Fase 2 suma sessions (solo en la tab
// claude). Fase 4 suma host. tree se suma en la Fase 5 — ver docs/REACT-PORT.md §3.
export function usePolling() {
  useEffect(() => {
    const { refreshGit, refreshSessions } = useDeckStore.getState()

    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      window.claudeConn?.sendVis() // re-afirmar presencia: el server la expira a los 25 s
      refreshGit()
      refreshHost()
      const tab = useDeckStore.getState().activeTab
      if (tab === 'claude') refreshSessions()
      if (tab === 'files') refreshTree(false) // sigue el cwd del pane: re-render solo si cambió la raíz
    }, 8000)

    const onVis = () => {
      // presencia: avisar también el pasaje a hidden — iOS congela la página
      // después de este evento, es la última chance de decir "no miro más"
      window.claudeConn?.sendVis()
      if (document.visibilityState === 'visible') {
        refreshGit()
        refreshHost()
        refreshSessions()
        if (useDeckStore.getState().activeTab === 'files') refreshTree(false)
        // iOS suele matar los WS en background: reconectar sin esperar backoff
        window.claudeConn?.resume()
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])
}
