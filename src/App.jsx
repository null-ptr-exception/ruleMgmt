import { useState } from 'react'
import ReceiversEditor from './pages/ReceiversEditor'
import GitopsEditor from './pages/GitopsEditor'
import PromQLEditor from './pages/PromQLEditor'
import AlertmanagerSmartEditor from './pages/AlertmanagerSmartEditor'
import TemplateDevEditor from './pages/TemplateDevEditor'
import AlertUserView from './pages/AlertUserView'

const NAV_SECTIONS = [
  {
    label: 'Alert Rules',
    items: [
      { id: 'template-dev', label: 'Templates', icon: '🛠' },
      { id: 'alert-user',   label: 'Alerts',    icon: '🔔' },
    ],
  },
  {
    label: 'Notification Rules',
    items: [
      { id: 'receivers', label: 'Receivers',     icon: '📣' },
      { id: 'amconfig',  label: 'Notifications', icon: '🔀' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { id: 'gitops',  label: 'Gitops Deploy',  icon: '🚀' },
      { id: 'promql',  label: 'PromQL Builder', icon: '📊' },
    ],
  },
]

export default function App() {
  const [page, setPage] = useState('alert-user')

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-title">Alert Template UI</div>
        {NAV_SECTIONS.map(section => (
          <div key={section.label} className="nav-section">
            <div className="nav-section-label">{section.label}</div>
            {section.items.map(item => (
              <button
                key={item.id}
                className={`nav-item${page === item.id ? ' active' : ''}`}
                onClick={() => setPage(item.id)}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <main className="content">
        {page === 'template-dev' && <TemplateDevEditor />}
        {page === 'alert-user'   && <AlertUserView />}
        {page === 'receivers'    && <ReceiversEditor />}
        {page === 'amconfig'     && <AlertmanagerSmartEditor />}
        {page === 'gitops'       && <GitopsEditor />}
        {page === 'promql'       && <PromQLEditor onNavigate={setPage} />}
      </main>
    </div>
  )
}
