import { useEffect, useRef } from 'react'
import { useDeckStore } from '../../store'
import { useTap } from '../../hooks/useTap'
import {
  registerComposerTextarea,
  closeComposer,
  sendComposer,
  composerNewline,
  scheduleDraftSave,
  toggleComposerSnips,
} from '../../lib/composer'
import { SnippetsPalette } from './Snippets'

// Composer de prompts (index.html:47-66). SIEMPRE montado (§5.3), se togglea con
// la clase hidden. El <textarea> es NO-controlado (ref registrado en lib/composer):
// los borradores se guardan con debounce, sin re-render por tecla. Al abrir, el
// botón ✎ de la controlbar lo enfoca sincrónicamente dentro del gesto (el nodo ya
// existe porque nunca se desmonta). Toda la lógica vive en lib/composer.
export function Composer() {
  const open = useDeckStore((s) => s.composerOpen)
  const session = useDeckStore((s) => s.composerSession)
  const draftSaved = useDeckStore((s) => s.draftSaved)
  const snipsOpen = useDeckStore((s) => s.composerSnipsOpen)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    registerComposerTextarea(taRef.current)
    return () => registerComposerTextarea(null)
  }, [])

  const cancelTap = useTap(() => closeComposer())
  const sendTap = useTap(() => sendComposer())
  const nlTap = useTap(() => composerNewline())
  const snipsTap = useTap(() => toggleComposerSnips())

  return (
    <div id="composer" className={'composer' + (open ? '' : ' hidden')}>
      <div className="composer-head">
        <button id="composer-cancel" className="composer-lnk" {...cancelTap}>
          Cancelar
        </button>
        <div className="composer-title">
          Prompt a <span id="composer-session">{session}</span>
        </div>
        <button id="composer-send" className="composer-lnk composer-send" {...sendTap}>
          Enviar ↑
        </button>
      </div>
      <textarea id="composer-text" ref={taRef} placeholder="Escribí el prompt…" onInput={scheduleDraftSave} />
      {/* paleta de snippets dentro del composer: inserta en el cursor del textarea */}
      <div id="composer-snips" className={'composer-snips' + (snipsOpen ? '' : ' hidden')}>
        {snipsOpen && <SnippetsPalette />}
      </div>
      <div className="composer-foot">
        <button id="composer-nl" className="ctl-sq" title="Salto de línea" {...nlTap}>
          {'\\n'}
        </button>
        <button id="composer-snippets" className={'ctl-sq' + (snipsOpen ? ' active' : '')} title="Snippets" {...snipsTap}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6.5h16M4 12h16M4 17.5h16" />
          </svg>
        </button>
        <span id="composer-saved" className={'composer-saved' + (draftSaved ? '' : ' hidden')}>
          Borrador guardado
        </span>
      </div>
    </div>
  )
}
