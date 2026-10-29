import { useEffect } from 'react'
import { useDeckStore } from '../store'

// visualViewport: la app se "pega" al área visible (teclado / rotación).
// Port de updateViewportGeometry (app.js:2100-2117). body queda fixed (la página
// nunca scrollea); #app se corre con --vvt para seguir el paneo del visual
// viewport cuando iOS muestra el teclado.
const KB_THRESHOLD = 100 // px que el visual viewport cae bajo su alto sin teclado

export function useViewportGeometry() {
  useEffect(() => {
    let fitTimer: ReturnType<typeof setTimeout> | null = null
    // Alto sin teclado = el mayor alto visto para ese ancho (el ancho solo
    // cambia al rotar). No se compara contra innerHeight: con
    // interactive-widget=resizes-content el layout viewport del iPhone encoge
    // junto con el visual y esa diferencia nunca pasaba el umbral. Solo en
    // touch: en desktop achicar la ventana no es un teclado.
    const fullHeight = new Map<number, number>()
    const touch = window.matchMedia('(pointer: coarse)')

    const update = () => {
      const vv = window.visualViewport
      const h = vv ? vv.height : window.innerHeight
      const top = vv ? vv.offsetTop : 0
      document.documentElement.style.setProperty('--vvh', `${h}px`)
      document.documentElement.style.setProperty('--vvt', `${top}px`)
      const w = window.innerWidth
      const seen = fullHeight.get(w)
      let kb: boolean
      if (seen === undefined && document.activeElement?.matches('textarea, input, [contenteditable="true"]')) {
        // rotó con el teclado arriba: este alto no sirve de "sin teclado", se
        // espera a una muestra con el teclado cerrado para guardar el ancho
        kb = true
      } else {
        const full = Math.max(seen ?? 0, h)
        fullHeight.set(w, full)
        kb = full - h > KB_THRESHOLD
      }
      // teclado abierto → fuera tabbar y statusline, la toolrow va pegada al
      // teclado con ⌄ en vez de Compose (el fit con debounce corre después del
      // toggle y le da esas filas a la terminal)
      document.body.classList.toggle('kb-open', touch.matches && kb)
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
