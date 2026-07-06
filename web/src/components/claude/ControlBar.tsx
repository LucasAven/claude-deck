import { KEYS } from '../../lib/keys'
import { useTap } from '../../hooks/useTap'

// Controlbar (index.html:88-133). Fase 2 cablea SOLO las quickkeys [data-k] →
// sendKeys(KEYS[k]) (app.js:301-339). El resto de la barra —img-chip,
// switch-menu, pills de modo/modelo, adjuntar/snippets/composer/scrollback— se
// cablea en las Fases 3/4. Los botones de acción se dejan en el markup (layout
// + ids/clases intactos) pero inertes por ahora.

// Una quickkey: useTap (preventDefault en pointerdown mantiene el foco del
// teclado virtual — §5.4, NO reemplazar por onClick) → manda la secuencia cruda.
function QuickKey({ k, title, children }: { k: string; title?: string; children: React.ReactNode }) {
  const tap = useTap(() => window.claudeConn?.sendKeys(KEYS[k]))
  return (
    <button data-k={k} title={title} {...tap}>
      {children}
    </button>
  )
}

export function ControlBar() {
  return (
    <div className="controlbar">
      {/* Fase 3: #img-chip, #switch-menu, .switchrow (pills modo/modelo) */}
      <div className="controlrow quickkeys" data-term="claude">
        {/* Fase 4: adjuntar / snippets / composer / scrollback (inertes por ahora) */}
        <button id="btn-attach" className="ctl-sq" title="Adjuntar: cámara o portapapeles">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <input id="img-input" type="file" accept="image/*" className="hidden" />
        <button id="btn-snippets" className="ctl-sq" title="Snippets">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6.5h16M4 12h16M4 17.5h16" /></svg>
        </button>
        <button id="btn-composer" className="ctl-sq" title="Componer prompt">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.7 3.8a2.1 2.1 0 0 1 3 3L7.5 19l-4 1 1-4z" /></svg>
        </button>
        <button id="btn-scrollback" className="ctl-sq" title="Ponerse al día (scrollback legible)">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5h16M4 9.5h16M4 13.5h10" /><path d="M17 21v-6M14 17.8l3 3 3-3" /></svg>
        </button>
        <span className="ctl-div" />
        {/* orden: nl primero, slash segundo (app.js:249) */}
        <QuickKey k="nl" title="Salto de línea (sin enviar)">{'\\n'}</QuickKey>
        <QuickKey k="slash">/</QuickKey>
        <QuickKey k="esc">esc</QuickKey>
        <QuickKey k="up">&#8593;</QuickKey>
        <QuickKey k="down">&#8595;</QuickKey>
        <QuickKey k="tab">tab</QuickKey>
        <QuickKey k="ctrlc">ctrl+c</QuickKey>
      </div>
    </div>
  )
}
