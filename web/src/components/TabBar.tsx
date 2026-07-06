import { useDeckStore } from '../store'

// Tab bar (index.html:191-202). El badge de Cambios sale de git.files.length
// (app.js:1640-1648): 0 u error → oculto, cap a 99+.
export function TabBar() {
  const activeTab = useDeckStore((s) => s.activeTab)
  const setActiveTab = useDeckStore((s) => s.setActiveTab)
  const count = useDeckStore((s) => s.git?.files.length ?? 0)

  return (
    <nav className="tabbar">
      <button
        className={'tab' + (activeTab === 'claude' ? ' active' : '')}
        data-tab="claude"
        onClick={() => setActiveTab('claude')}
      >
        <span className="tab-icon">&#9670;</span>
        <span>Claude</span>
      </button>
      <button
        className={'tab' + (activeTab === 'changes' ? ' active' : '')}
        data-tab="changes"
        onClick={() => setActiveTab('changes')}
      >
        <span className="tab-icon">&#916;</span>
        <span>Cambios</span>
        <span id="tab-changes-badge" className={'tab-badge' + (count ? '' : ' hidden')}>
          {count ? (count > 99 ? '99+' : String(count)) : ''}
        </span>
      </button>
      <button
        className={'tab' + (activeTab === 'files' ? ' active' : '')}
        data-tab="files"
        onClick={() => setActiveTab('files')}
      >
        <span className="tab-icon">&#9636;</span>
        <span>Archivos</span>
      </button>
    </nav>
  )
}
