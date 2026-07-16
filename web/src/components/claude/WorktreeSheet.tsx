import { useEffect, useState } from 'react'
import { useDeckStore } from '../../store'
import { closeWorktreeSheet, createWorktree, fetchBranches, type BranchInfo } from '../../lib/worktree'

// Sheet "Nuevo worktree" (tarea 5, design-refs/task05-worktree-sheet.png):
// rama nueva + "Basado en" + botón único que crea worktree + sesión tmux de un
// tap (el patrón recomendado del README para Claudes paralelos, sin manos).
// Siempre montado como HostSheet (toggle hidden). El formulario es estado local
// normal — no es el composer: sin dance de foco iOS ni borradores (la regla del
// textarea no-controlado no aplica acá). Los errores del endpoint (rama
// existente, base inexistente, path tomado) se muestran EN el sheet, no alert.

// último segmento de la rama → sufijo del path del worktree (igual que el server)
function lastSeg(branch: string): string {
  return branch.trim().split('/').filter(Boolean).pop() || '…'
}

export function WorktreeSheet() {
  const open = useDeckStore((s) => s.worktreeSheetOpen)
  const selectSession = useDeckStore((s) => s.selectSession)
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('')
  const [info, setInfo] = useState<BranchInfo | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // ramas frescas en cada apertura (elección de Lucas: endpoint propio fetcheado
  // acá, no en el poll); default preseleccionado = rama actual de la sesión
  useEffect(() => {
    if (!open) return
    setError('')
    fetchBranches().then((bi) => {
      setInfo(bi)
      if (bi) setBase(bi.current || bi.branches[0] || '')
      else setError('No se pudieron leer las ramas del repo')
    })
  }, [open])

  const submit = async () => {
    if (busy) return
    const b = branch.trim()
    if (!b) {
      setError('Poné un nombre de rama')
      return
    }
    setBusy(true)
    setError('')
    const res = await createWorktree(b, base)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    closeWorktreeSheet()
    setBranch('')
    // la sesión ya existe server-side: selectSession pelado y el guard
    // anti-resurrección ve una sesión viva (created=false)
    selectSession(res.session)
  }

  const repo = info?.repo || 'repo'

  return (
    <div
      id="worktree-sheet"
      className={'host-sheet' + (open ? '' : ' hidden')}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeWorktreeSheet()
      }}
    >
      <div className="host-sheet-panel">
        <div className="sheet-grip" />
        <div className="host-title">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="7" cy="6" r="2.5" />
            <circle cx="7" cy="18" r="2.5" />
            <circle cx="17" cy="9" r="2.5" />
            <path d="M7 8.5v7M17 11.5c0 3.5-4 3-7.5 4.5" />
          </svg>
          <span>Nuevo worktree</span>
        </div>

        <label className="wt-label" htmlFor="wt-branch">Nombre de rama</label>
        <input
          id="wt-branch"
          className="wt-input"
          type="text"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="feat/composer"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
        />

        <label className="wt-label" htmlFor="wt-base">Basado en</label>
        <select id="wt-base" className="wt-select" value={base} onChange={(e) => setBase(e.target.value)}>
          {(info?.branches || []).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>

        <div id="wt-info" className="wt-info">
          Corre <code>git worktree add ../{repo}-{lastSeg(branch)}</code> y abre una sesión tmux ahí. Tu{' '}
          <code>{base || 'rama'}</code> queda intacto.
        </div>

        <div id="wt-error" className={'wt-error' + (error ? '' : ' hidden')}>
          {error}
        </div>

        <button id="wt-submit" className="wt-submit" disabled={busy} onClick={submit}>
          {busy ? 'Creando…' : 'Crear worktree + sesión'}
        </button>
      </div>
    </div>
  )
}
