import { useEffect } from 'react'
import { useDeckStore } from '../store'
import { refreshHost } from '../lib/host'
import { refreshStatus } from '../lib/status'
import { refreshTree } from '../lib/files'

// Auto-refresh cada 8 s mientras la pestaña esté visible + manejo de
// visibilitychange (app.js:2185-2208). refreshGit y refreshHost corren en
// cualquier tab (badge de Cambios y chip de batería siempre al día).
//
// sessions solo corre en la tab claude; tree solo en la tab files (sigue el
// cwd del pane).
export function usePolling() {
  useEffect(() => {
    const { refreshGit, refreshSessions } = useDeckStore.getState()

    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      window.claudeConn?.sendVis() // re-afirmar presencia: el server la expira a los 25 s
      refreshGit()
      refreshHost()
      const tab = useDeckStore.getState().activeTab
      if (tab === 'claude') {
        refreshSessions()
        refreshStatus() // statusline: solo la sesión activa (piggyback, tarea 22)
      }
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
        refreshStatus()
        if (useDeckStore.getState().activeTab === 'files') refreshTree(false)
        // iOS suele matar los WS en background: reconectar sin esperar backoff
        window.claudeConn?.resume()
      }
    }
    document.addEventListener('visibilitychange', onVis)

    // Red de seguridad para la PWA standalone de iOS: al volver del app switcher
    // tras un freeze largo, `visibilitychange` no siempre dispara (tarea 33,
    // hipótesis 3), y sin él resume() no corre y la terminal queda corrupta.
    // `pageshow` (persisted = restaurada del bfcache) sí llega en ese camino.
    // resume() es idempotente (con OFF/CONNECTING no hace nada dañino), así que
    // llamarlo de más al restaurar la página es inocuo.
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return // carga normal: connect() ya se encarga
      if (document.visibilityState !== 'visible') return
      window.claudeConn?.sendVis()
      window.claudeConn?.resume()
    }
    window.addEventListener('pageshow', onPageShow)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])
}
