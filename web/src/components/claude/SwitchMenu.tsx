import { useEffect, useRef } from 'react'
import { useDeckStore } from '../../store'
import { MODELS, EFFORTS, KEYS, QUICKKEY_CATALOG } from '../../lib/keys'
import { saveSwitch, sendSlashCommand, closeSwitchMenu } from '../../lib/switch'
import { pasteFromClipboard } from '../../lib/image'
import { useTap } from '../../hooks/useTap'
import { SnippetsPalette } from './Snippets'

// Popover único de la controlbar (#switch-menu, app.js:398-464, 630-654,
// 1027-1043): un solo contenedor con kind 'model'|'dpad'|'snippets' en el
// store. El toggle (tap en el kind abierto lo cierra) y el tap-afuera los manejan
// lib/switch y el listener global de App. Acá solo se pinta el contenido del kind.

function MenuItem({ label, selected, onPick }: { label: string; selected: boolean; onPick: () => void }) {
  const tap = useTap(onPick)
  return (
    <button className={'mi' + (selected ? ' sel' : '')} {...tap}>
      <span>{label}</span>
      {selected && <span className="mi-check">✓</span>}
    </button>
  )
}

function EffortButton({ label, selected, onPick }: { label: string; selected: boolean; onPick: () => void }) {
  const tap = useTap(onPick)
  return (
    <button className={selected ? 'sel' : ''} {...tap}>
      {label}
    </button>
  )
}

function ModelMenu() {
  const session = useDeckStore((s) => s.session)
  const sw = useDeckStore((s) => s.switchState)
  const setSwitchState = useDeckStore((s) => s.setSwitchState)

  const pickModel = (id: string) => {
    sendSlashCommand(`/model ${id}`)
    const next = { ...sw, model: id }
    saveSwitch(session, next)
    setSwitchState(next)
    closeSwitchMenu()
  }
  const pickEffort = (id: string) => {
    sendSlashCommand(`/effort ${id}`)
    const next = { ...sw, effort: id }
    saveSwitch(session, next)
    setSwitchState(next)
    closeSwitchMenu()
  }

  return (
    <>
      <div className="mh">Modelo</div>
      {MODELS.map((m) => (
        <MenuItem key={m.id} label={m.label} selected={m.id === sw.model} onPick={() => pickModel(m.id)} />
      ))}
      <div className="mdiv" />
      <div className="mh">Esfuerzo</div>
      <div className="mi-efforts">
        {EFFORTS.map((e) => (
          <EffortButton key={e.id} label={e.label} selected={e.id === sw.effort} onPick={() => pickEffort(e.id)} />
        ))}
      </div>
    </>
  )
}

// Íconos de las dos esquinas FIJAS de arriba. Se exportan por lo mismo que
// TOOL_ICONS en ControlBar: el diagrama del d-pad en el editor de teclas
// rápidas los vuelve a pintar en chico y no quiere una segunda copia del svg.
export const DPAD_ICONS = {
  camera: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="18" height="13" rx="2.5" />
      <path d="M8.5 7l1.6-2.4h3.8L15.5 7" />
      <circle cx="12" cy="13.2" r="3.4" />
    </svg>
  ),
  paste: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="4.5" width="14" height="17" rx="2.5" />
      <path d="M9 4.5a3 3 0 0 1 6 0" />
      <path d="M9.3 13.5l2 2 3.4-3.8" />
    </svg>
  ),
}

const REPEAT_DELAY_MS = 350
const REPEAT_EVERY_MS = 80

// Flecha del d-pad: manda en pointerdown (no en el up como useTap) para que
// mantener apretado auto-repita. En el popover no hay scroll que proteger, así
// que no hace falta el slop. El preventDefault mantiene el teclado virtual.
function ArrowCell({ k, title, children }: { k: string; title: string; children: React.ReactNode }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stop = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }
  useEffect(() => stop, [])
  const send = () => window.claudeConn?.sendKeys(KEYS[k])
  const repeat = () => {
    send()
    timerRef.current = setTimeout(repeat, REPEAT_EVERY_MS)
  }
  return (
    <button
      className="dp-cell"
      data-k={k}
      title={title}
      onPointerDown={(e) => {
        e.preventDefault()
        stop()
        send()
        timerRef.current = setTimeout(repeat, REPEAT_DELAY_MS)
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
    >
      {children}
    </button>
  )
}

// Esquina de abajo configurable (sheet de teclas rápidas): manda la tecla
// asignada y NO cierra el menú, igual que enter, para poder tocarla varias
// veces seguidas. Sin tecla asignada el DOM queda igual que antes (.dp-empty).
function CornerCell({ id }: { id: string | null }) {
  const tap = useTap(() => {
    if (id) window.claudeConn?.sendKeys(KEYS[id])
  })
  const cat = id ? QUICKKEY_CATALOG.find((c) => c.id === id) : undefined
  if (!cat) return <div className="dp-empty" />
  // el modificador (^ o ⇧) va apagado delante de la tecla, mismo tamaño y fuente
  const [, mod, key] = cat.label.match(/^([\^⇧]?)(.*)$/) ?? ['', '', cat.label]
  return (
    <button className="dp-cell dp-corner" data-k={cat.id} title={cat.desc} {...tap}>
      {mod && <span className="dp-mod">{mod}</span>}
      {key}
    </button>
  )
}

// D-pad: grilla 3x3. Flechas, enter y las esquinas configurables NO cierran el
// menú (↓ ↓ ⏎ seguidos); cámara y pegar sí. Esos dos corren dentro del
// pointerup (useTap) → sigue habiendo user activation para abrir el file
// picker / clipboard.
function DpadMenu({ onCamera }: { onCamera: () => void }) {
  const corners = useDeckStore((s) => s.dpad.corners)
  const cameraTap = useTap(() => {
    closeSwitchMenu()
    onCamera()
  })
  const pasteTap = useTap(() => {
    closeSwitchMenu()
    pasteFromClipboard()
  })
  const enterTap = useTap(() => window.claudeConn?.sendKeys(KEYS.enter))
  return (
    <>
      <button className="dp-cell" data-act="camera" title="Cámara o galería" {...cameraTap}>
        {DPAD_ICONS.camera}
      </button>
      <ArrowCell k="up" title="Flecha arriba">↑</ArrowCell>
      <button className="dp-cell" data-act="paste" title="Pegar del portapapeles" {...pasteTap}>
        {DPAD_ICONS.paste}
      </button>
      <ArrowCell k="left" title="Flecha izquierda">←</ArrowCell>
      <button className="dp-cell dp-enter" data-k="enter" title="Enter" {...enterTap}>
        {'⏎︎'}
      </button>
      <ArrowCell k="right" title="Flecha derecha">→</ArrowCell>
      <CornerCell id={corners.bl} />
      <ArrowCell k="down" title="Flecha abajo">↓</ArrowCell>
      <CornerCell id={corners.br} />
    </>
  )
}

export function SwitchMenu({ onCamera }: { onCamera: () => void }) {
  const kind = useDeckStore((s) => s.switchMenu)
  // data-kind espeja el kind al DOM: parte del contrato con ui-test.mjs (lee
  // menu.dataset.kind) y con el CSS, igual que el `dataset.kind` del vanilla.
  return (
    <div id="switch-menu" className={'switch-menu' + (kind ? '' : ' hidden')} data-kind={kind ?? undefined}>
      {kind === 'model' && <ModelMenu />}
      {kind === 'dpad' && <DpadMenu onCamera={onCamera} />}
      {kind === 'snippets' && <SnippetsPalette />}
    </div>
  )
}
