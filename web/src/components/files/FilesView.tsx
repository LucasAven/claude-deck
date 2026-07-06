import { useCallback, useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useDeckStore } from '../../store'
import { fetchList, fetchFile, registerTree, refreshTree, type FsEntry } from '../../lib/files'
import { FT_ICONS, fileIcon } from '../../lib/icons'
import { fmtSize, highlightCode, canRenderMd } from '../../lib/format'

// Pestaña Archivos (index.html:150-164, app.js:1787-2081): árbol read-only del
// directorio de la sesión, carga lazy por nivel. Cada nodo guarda su propio
// estado (expandido + hijos cargados) en useState local → colapsar conserva lo
// cargado y un re-render de la raíz sin cambios NO resetea la expansión, porque
// el poll con la misma raíz hace early-return (no setState, §5.10).

const emptyNote = (text: string) => <div className="empty-state">{text}</div>

// --- nodo del árbol (recursivo) ---
function TreeNode({ ent, base, depth, onOpenFile }: { ent: FsEntry; base: string; depth: number; onOpenFile: (rel: string) => void }) {
  const rel = base ? `${base}/${ent.name}` : ent.name
  const pad = { paddingLeft: `${12 + depth * 16}px` }

  if (ent.type !== 'dir') {
    const { cls, icon } = fileIcon(ent.name)
    return (
      <div className="ft-row file" style={pad} onClick={() => onOpenFile(rel)}>
        <span className={`ft-ico ${cls}`}>{icon}</span>
        <span className="ft-name">{ent.name}</span>
      </div>
    )
  }

  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [kids, setKids] = useState<FsEntry[]>([])
  const [truncated, setTruncated] = useState(false)

  const onClick = async () => {
    if (!loaded) {
      // primer expand: fetch lazy de los hijos (los guardamos aunque se colapse)
      try {
        const data = await fetchList(rel)
        setKids(data.entries)
        setTruncated(!!data.truncated)
        setLoaded(true)
        setExpanded(true)
      } catch (e) {
        if (String((e as Error).message) === '401') return
        /* otro error: dejar la carpeta colapsada, reintentar en el próximo tap */
      }
      return
    }
    setExpanded((x) => !x) // colapsar = ocultar (se conserva lo ya cargado)
  }

  return (
    <>
      <div className="ft-row dir" style={pad} onClick={onClick}>
        <span className="ft-caret">{expanded ? '▾' : '▸'}</span>
        <span className="ft-ico ft-dir">{expanded ? FT_ICONS.folderOpen : FT_ICONS.folder}</span>
        <span className="ft-name">{ent.name}</span>
      </div>
      <div className={'ft-kids' + (expanded ? '' : ' hidden')}>
        {loaded &&
          kids.map((k) => <TreeNode key={`${rel}/${k.name}`} ent={k} base={rel} depth={depth + 1} onOpenFile={onOpenFile} />)}
        {loaded && truncated && emptyNote(`… lista truncada a ${kids.length} entradas`)}
        {loaded && !kids.length && emptyNote('(vacío)')}
      </div>
    </>
  )
}

interface TreeView {
  rootName: string
  entries: FsEntry[]
  truncated: boolean
  loading: boolean
  error: string | null
}
interface OpenFile {
  rel: string
  loading: boolean
  error: string | null
  binary: boolean
  content: string
  truncated: boolean
  size: number
}

export function FilesView() {
  const activeTab = useDeckStore((s) => s.activeTab)
  const session = useDeckStore((s) => s.session)

  const [view, setView] = useState<TreeView>({ rootName: 'Archivos', entries: [], truncated: false, loading: false, error: null })
  const [treeKey, setTreeKey] = useState(0) // bump → remonta el árbol (raíz nueva o refresh manual)
  const [file, setFile] = useState<OpenFile | null>(null)
  const [mdRender, setMdRender] = useState(false)
  const fileRef = useRef<HTMLDivElement>(null)

  // sesión/raíz actualmente renderizadas (treeSession/treeRoot del vanilla). Refs
  // para que el refresher (registrado una vez) compare sin cerrar sobre estado viejo.
  const sessionRef = useRef<string | null>(null)
  const rootRef = useRef<string | null>(null)

  const resetFile = useCallback(() => {
    setFile(null)
    setMdRender(false)
  }, [])

  // re-lista la raíz; si el cwd del pane sigue en la misma raíz NO toca el DOM
  // (carpetas expandidas y archivo abierto sobreviven); si cambió, re-render.
  const refresh = useCallback(
    async (force: boolean) => {
      const ses = useDeckStore.getState().session
      const cached = sessionRef.current === ses && !force
      if (!cached) {
        resetFile()
        setView((v) => ({ ...v, entries: [], loading: true, error: null }))
      }
      let data
      try {
        data = await fetchList('')
      } catch (e) {
        if (ses !== useDeckStore.getState().session) return // cambió la sesión mientras cargaba
        sessionRef.current = null
        resetFile()
        setView((v) => ({ ...v, entries: [], loading: false, error: String((e as Error).message) === '401' ? null : `No se pudo listar: ${(e as Error).message}` }))
        return
      }
      if (ses !== useDeckStore.getState().session) return // que una respuesta vieja no pise el árbol nuevo
      if (cached && data.root === rootRef.current) return // misma raíz: no tocar el árbol
      resetFile() // raíz nueva: resetear archivo abierto y expansión
      sessionRef.current = ses
      rootRef.current = data.root
      setView({
        rootName: data.root.split('/').pop() || 'Archivos',
        entries: data.entries,
        truncated: !!data.truncated,
        loading: false,
        error: null,
      })
      setTreeKey((k) => k + 1) // raíz nueva → remontar (expansión desde cero)
    },
    [resetFile],
  )

  // el fallback puede reusar el nombre de una sesión muerta: marcar stale para
  // que la próxima re-lista aunque "la sesión no cambió" (app.js:1550)
  const invalidate = useCallback(() => {
    sessionRef.current = null
  }, [])

  useEffect(() => registerTree(refresh, invalidate), [refresh, invalidate])

  // entrar a la tab Archivos o cambiar de sesión estando en ella → re-lista
  useEffect(() => {
    if (activeTab === 'files') refresh(false)
  }, [activeTab, session, refresh])

  // archivo recién pintado → al tope (view.scrollTop = 0)
  useEffect(() => {
    if (file && fileRef.current) fileRef.current.scrollTop = 0
  }, [file?.rel, file?.content, mdRender])

  const openFile = async (rel: string) => {
    setMdRender(false)
    setFile({ rel, loading: true, error: null, binary: false, content: '', truncated: false, size: 0 })
    let data
    try {
      data = await fetchFile(rel)
    } catch (e) {
      setFile({ rel, loading: false, error: String((e as Error).message) === '401' ? null : `No se pudo leer el archivo: ${(e as Error).message}`, binary: false, content: '', truncated: false, size: 0 })
      return
    }
    setFile({ rel, loading: false, error: null, binary: !!data.binary, content: data.content ?? '', truncated: !!data.truncated, size: data.size })
  }

  const canMd = !!file && !file.binary && !file.loading && !file.error && canRenderMd(file.rel)
  const title = file ? file.rel : view.rootName

  // contenido de #file-view según el estado del archivo abierto
  let fileBody: React.ReactNode = null
  if (file) {
    if (file.loading) fileBody = emptyNote('Cargando…')
    else if (file.error) fileBody = emptyNote(file.error)
    else if (file.binary) fileBody = emptyNote(`Archivo binario · ${fmtSize(file.size)}`)
    else {
      const note = file.truncated ? emptyNote(`… truncado a 512 KB (el archivo pesa ${fmtSize(file.size)})`) : null
      if (mdRender && canRenderMd(file.rel)) {
        // sanitizado obligatorio: se abren archivos arbitrarios del repo y el
        // HTML corre en el origin de la app (§5.7)
        const html = DOMPurify.sanitize(marked.parse(file.content) as string)
        fileBody = (
          <>
            <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
            {note}
          </>
        )
      } else {
        const hl = highlightCode(file.rel, file.content)
        fileBody = (
          <>
            <pre className="file-pre">
              {hl !== null ? (
                <code className="hljs" dangerouslySetInnerHTML={{ __html: hl }} />
              ) : (
                <code>{file.content}</code>
              )}
            </pre>
            {note}
          </>
        )
      }
    }
  }

  return (
    <>
      <div className="changes-header">
        <button id="btn-file-back" className={'icon-btn' + (file ? '' : ' hidden')} onClick={resetFile}>
          ←
        </button>
        <div className="branch-info">
          <span id="files-title">{title}</span>
        </div>
        <button
          id="btn-md-render"
          className={'icon-btn' + (canMd ? '' : ' hidden') + (mdRender ? ' active' : '')}
          title="Vista renderizada"
          onClick={() => canMd && setMdRender((x) => !x)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 12s3.5-6.2 9.5-6.2S21.5 12 21.5 12s-3.5 6.2-9.5 6.2S2.5 12 2.5 12z" />
            <circle cx="12" cy="12" r="3.1" />
          </svg>
        </button>
        <button id="btn-files-refresh" className="icon-btn" onClick={() => refreshTree(true)}>
          ↻
        </button>
      </div>

      <div id="file-tree" className={'scroll' + (file ? ' hidden' : '')}>
        {view.loading && emptyNote('Cargando…')}
        {view.error && emptyNote(view.error)}
        {!view.loading && !view.error && !view.entries.length && emptyNote('Directorio vacío')}
        {view.entries.map((ent) => (
          <TreeNode key={`${treeKey}:${ent.name}`} ent={ent} base="" depth={0} onOpenFile={openFile} />
        ))}
        {view.truncated && emptyNote(`… lista truncada a ${view.entries.length} entradas`)}
      </div>

      <div id="file-view" ref={fileRef} className={'scroll' + (file ? '' : ' hidden')}>
        {fileBody}
      </div>
    </>
  )
}
