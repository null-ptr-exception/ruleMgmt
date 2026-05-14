import { useState } from 'react'
import AlertTypeEditor from './pages/AlertTypeEditor'
import AlertSuiteEditor from './pages/AlertSuiteEditor'
import ReceiversEditor from './pages/ReceiversEditor'
import GitopsEditor from './pages/GitopsEditor'
import PromQLEditor from './pages/PromQLEditor'
import AlertmanagerSmartEditor from './pages/AlertmanagerSmartEditor'
import AlertTypePackEditor from './pages/AlertTypePackEditor'
import TemplateDevEditor from './pages/TemplateDevEditor'
import AlertUserView from './pages/AlertUserView'

const NAV_ITEMS = [
  { id: 'template-dev', label: 'Template Editor',    icon: '🛠' },
  { id: 'alert-user',   label: 'Alert Manager',      icon: '🔔' },
  { id: 'alert-type',   label: 'Alert Type',         icon: '⚡' },
  { id: 'alert-pack',   label: 'Alert Pack',         icon: '📋' },
  { id: 'alert-suite',  label: 'Rule Group',         icon: '📦' },
  { id: 'receivers',    label: 'Receivers',           icon: '📣' },
  { id: 'amconfig',     label: 'AM Config',           icon: '🔀' },
  { id: 'gitops',       label: 'Gitops Deploy',       icon: '🚀' },
  { id: 'promql',       label: 'PromQL Builder',      icon: '📊' },
]

export default function App() {
  const [page, setPage] = useState('alert-user')

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-title">Alert Template UI</div>
        {NAV_ITEMS.map(item => (
          <button
            key={item.id}
            className={`nav-item${page === item.id ? ' active' : ''}`}
            onClick={() => setPage(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <main className="content">
        {page === 'template-dev' && <TemplateDevEditor />}
        {page === 'alert-user'   && <AlertUserView />}
        {page === 'alert-type'   && <AlertTypeEditor />}
        {page === 'alert-pack'   && <AlertTypePackEditor />}
        {page === 'alert-suite'  && <AlertSuiteEditor />}
        {page === 'receivers'    && <ReceiversEditor />}
        {page === 'amconfig'     && <AlertmanagerSmartEditor />}
        {page === 'gitops'       && <GitopsEditor />}
        {page === 'promql'       && <PromQLEditor onNavigate={setPage} />}
      </main>
    </div>
  )
}
