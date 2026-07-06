import { useDeckStore } from '../../store'

// Hint de sesión tmux nueva y vacía (index.html:34-36). show/hide + timer de
// 15 s viven en el store (showHint/hideHint, app.js:285-296); acá solo se pinta
// y se togglea .hidden. El fit() en rAF también lo hace el store (le come filas
// a la terminal). Se muestra cuando el server contesta meta.created (§Fase 2).
export function Hint() {
  const hintOpen = useDeckStore((s) => s.hintOpen)
  const hideHint = useDeckStore((s) => s.hideHint)

  return (
    <div id="hint-claude" className={'hint' + (hintOpen ? '' : ' hidden')}>
      Sesión tmux nueva y vacía — escribí <code>claude --continue</code> para retomar la última
      conversación del repo. <span className="hint-close" onClick={() => hideHint()}>✕</span>
    </div>
  )
}
