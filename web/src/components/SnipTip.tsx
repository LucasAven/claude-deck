import { useLayoutEffect, useRef } from 'react'
import { useDeckStore } from '../store'

// Tooltip de texto completo de un snippet (index.html:188, app.js:891-903).
// Siempre montado, oculto por defecto. La lógica de hover/long-press vive en
// lib/sniptip (setea snipTip con el rect del chip); acá se pinta el texto y se
// posiciona en un layout effect: hay que medir el ancho ya renderizado antes de
// centrarlo sobre el chip, clampeado al viewport (fixed = coords de getBoundingClientRect).
export function SnipTip() {
  const snipTip = useDeckStore((s) => s.snipTip)
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const tip = ref.current
    if (!snipTip || !tip) return
    const r = snipTip.rect
    const x = Math.max(8, Math.min(r.left + r.width / 2 - tip.offsetWidth / 2, window.innerWidth - tip.offsetWidth - 8))
    tip.style.left = `${x}px`
    tip.style.bottom = `${window.innerHeight - r.top + 8}px` // arriba del chip
  }, [snipTip])

  return (
    <div id="snip-tip" ref={ref} className={'snip-tip' + (snipTip ? '' : ' hidden')}>
      {snipTip?.text ?? ''}
    </div>
  )
}
