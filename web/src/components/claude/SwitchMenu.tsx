import { useDeckStore } from '../../store'
import { MODELS, EFFORTS } from '../../lib/keys'
import { saveSwitch, sendSlashCommand, closeSwitchMenu } from '../../lib/switch'
import { pasteFromClipboard } from '../../lib/image'
import { useTap } from '../../hooks/useTap'
import { SnippetsPalette } from './Snippets'

// Popover único de la controlbar (#switch-menu, app.js:398-464, 630-654,
// 1027-1043): un solo contenedor con kind 'model'|'attach'|'snippets' en el
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

// Adjuntar (app.js:617-654): chooser cámara / pegar. Corre dentro del pointerup
// (useTap) → sigue habiendo user activation para abrir el file picker / clipboard.
function AttachMenu({ onCamera }: { onCamera: () => void }) {
  const cameraTap = useTap(() => {
    closeSwitchMenu()
    onCamera()
  })
  const pasteTap = useTap(() => {
    closeSwitchMenu()
    pasteFromClipboard()
  })
  return (
    <>
      <div className="mh">Adjuntar</div>
      <button className="mi" {...cameraTap}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="7" width="18" height="13" rx="2.5" />
          <path d="M8.5 7l1.6-2.4h3.8L15.5 7" />
          <circle cx="12" cy="13.2" r="3.4" />
        </svg>
        <span>Cámara o galería</span>
      </button>
      <button className="mi" {...pasteTap}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="4.5" width="14" height="17" rx="2.5" />
          <path d="M9 4.5a3 3 0 0 1 6 0" />
          <path d="M9.3 13.5l2 2 3.4-3.8" />
        </svg>
        <span>Pegar del portapapeles</span>
      </button>
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
      {kind === 'attach' && <AttachMenu onCamera={onCamera} />}
      {kind === 'snippets' && <SnippetsPalette />}
    </div>
  )
}
