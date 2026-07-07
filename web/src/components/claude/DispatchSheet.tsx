import { useEffect, useState } from 'react'
import { useDeckStore } from '../../store'
import {
  closeDispatchSheet,
  dispatchAgent,
  fetchWorkspaces,
  type DispatchMode,
} from '../../lib/worktree'

// Sheet "Despachar agente" (tarea 6, design-refs/task06-dispatch-sheet.png):
// dropdown de directorio + prompt inicial + pills de modo → crea una sesión
// tmux nueva en ese dir y lanza claude con el prompt. Siempre montado como
// HostSheet (toggle hidden); formulario en estado local (no es el composer:
// sin dance de foco iOS ni borradores). Errores del endpoint (dir ya con
// sesión → 409, etc.) inline, no alert.

const MODES: Array<{ key: DispatchMode; label: string }> = [
  { key: 'plan', label: 'Plan' },
  { key: 'acceptEdits', label: 'Auto-edits' },
  { key: 'bypassPermissions', label: 'Autorun' },
]

export function DispatchSheet() {
  const open = useDeckStore((s) => s.dispatchSheetOpen)
  const selectSession = useDeckStore((s) => s.selectSession)
  const [dirs, setDirs] = useState<string[]>([])
  const [dir, setDir] = useState('')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<DispatchMode>('plan')
  // Autorun (bypassPermissions) exige una confirmación extra antes de lanzar
  // (decisión de Lucas): el botón se arma con un estado de confirmación que dice
  // "corre sin pedir permisos" en vez de un alert.
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // dirs frescos en cada apertura (subdirectorios de primer nivel de WORKSPACES_ROOT)
  useEffect(() => {
    if (!open) return
    setError('')
    setArmed(false)
    fetchWorkspaces().then((ds) => {
      if (ds) {
        setDirs(ds)
        setDir((cur) => cur || ds[0] || '')
      } else {
        setError('No se pudieron leer los directorios')
      }
    })
  }, [open])

  const pickMode = (m: DispatchMode) => {
    setMode(m)
    setArmed(false) // cambiar de modo desarma la confirmación de Autorun
  }

  const launch = async () => {
    if (busy) return
    if (!dir) {
      setError('Elegí un directorio')
      return
    }
    if (!prompt.trim()) {
      setError('Escribí un prompt inicial')
      return
    }
    // primer tap en Autorun arma la confirmación en vez de lanzar
    if (mode === 'bypassPermissions' && !armed) {
      setArmed(true)
      setError('')
      return
    }
    setBusy(true)
    setError('')
    const res = await dispatchAgent(dir, prompt.trim(), mode)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      setArmed(false)
      return
    }
    closeDispatchSheet()
    setPrompt('')
    setArmed(false)
    // la sesión ya existe server-side: selectSession pelado (sin create=1)
    selectSession(res.session)
  }

  const confirming = mode === 'bypassPermissions' && armed
  const launchLabel = busy
    ? 'Lanzando…'
    : confirming
      ? 'Confirmar: corre sin pedir permisos'
      : '→ Lanzar agente'

  return (
    <div
      id="dispatch-sheet"
      className={'host-sheet' + (open ? '' : ' hidden')}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeDispatchSheet()
      }}
    >
      <div className="host-sheet-panel">
        <div className="sheet-grip" />
        <div className="host-title">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h13M13 6l6 6-6 6" />
          </svg>
          <span>Despachar agente</span>
        </div>

        <label className="wt-label" htmlFor="dp-dir">Directorio</label>
        <select id="dp-dir" className="wt-select" value={dir} onChange={(e) => setDir(e.target.value)}>
          {dirs.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>

        <label className="wt-label" htmlFor="dp-prompt">Prompt inicial</label>
        <textarea
          id="dp-prompt"
          className="dp-textarea"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Revisá los tests que fallan y arreglalos…"
          rows={4}
          autoCapitalize="sentences"
        />

        <label className="wt-label">Modo del agente</label>
        <div id="dp-modes" className="dp-modes">
          {MODES.map((m) => (
            <button
              key={m.key}
              className={'dp-pill' + (mode === m.key ? ' active' : '')}
              data-mode={m.key}
              onClick={() => pickMode(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div id="dp-error" className={'wt-error' + (error ? '' : ' hidden')}>
          {error}
        </div>

        <button
          id="dp-submit"
          className={'wt-submit' + (confirming ? ' dp-confirm' : '')}
          disabled={busy}
          onClick={launch}
        >
          {launchLabel}
        </button>
      </div>
    </div>
  )
}
