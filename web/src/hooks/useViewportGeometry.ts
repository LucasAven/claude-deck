import { useEffect } from 'react'
import { useDeckStore } from '../store'

// visualViewport: la app se "pega" al área visible (teclado / rotación).
// Port de updateViewportGeometry (app.js:2100-2117). body queda fixed (la página
// nunca scrollea); #app se corre con --vvt para seguir el paneo del visual
// viewport cuando iOS muestra el teclado.
const KB_THRESHOLD = 100 // px: diferencia layout↔visual viewport que delata al teclado

export function useViewportGeometry() {
  useEffect(() => {
    let fitTimer: ReturnType<typeof setTimeout> | null = null

    const update = () => {
      const vv = window.visualViewport
      const h = vv ? vv.height : window.innerHeight
      const top = vv ? vv.offsetTop : 0
      document.documentElement.style.setProperty('--vvh', `${h}px`)
      document.documentElement.style.setProperty('--vvt', `${top}px`)
      // teclado abierto → ocultar la tabbar para darle esas filas a la terminal
      // (el fit con debounce corre después del toggle y toma el espacio)
      document.body.classList.toggle('kb-open', window.innerHeight - h > KB_THRESHOLD)
      // fit con debounce: el teclado dispara ráfagas de resize y cada re-fit real
      // provoca un redraw completo de tmux
      if (fitTimer) clearTimeout(fitTimer)
      fitTimer = setTimeout(() => {
        if (useDeckStore.getState().activeTab === 'claude') window.claudeConn?.fit()
      }, 120)
    }

    update()
    const vv = window.visualViewport
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    const onOrient = () => setTimeout(update, 300)
    window.addEventListener('orientationchange', onOrient)

    return () => {
      if (fitTimer) clearTimeout(fitTimer)
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', onOrient)
    }
  }, [])
}
