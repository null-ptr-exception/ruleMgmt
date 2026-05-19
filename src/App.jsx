import { useState } from 'react'
import { Layout, Menu, theme, Spin } from 'antd'
import {
  ToolOutlined,
  BellOutlined,
  BranchesOutlined,
  RocketOutlined,
  BarChartOutlined,
} from '@ant-design/icons'
import NotificationRoutesEditor from './pages/NotificationRoutesEditor'
import GitopsEditor from './pages/GitopsEditor'
import PromQLEditor from './pages/PromQLEditor'
import TemplateDevEditor from './pages/TemplateDevEditor'
import AlertUserView from './pages/AlertUserView'
import { AuthProvider, useAuth } from './hooks/useAuth.jsx'
import { useGitStatus } from './hooks/useGitStatus'
import LoginPage from './components/LoginPage'
import GitStatusBar from './components/GitStatusBar'
import './App.css'

const { Sider, Content } = Layout

const menuItems = [
  {
    key: 'alert-rules',
    label: 'Alert Rules',
    type: 'group',
    children: [
      { key: 'template-dev', label: 'Templates', icon: <ToolOutlined /> },
      { key: 'alert-user', label: 'Alerts', icon: <BellOutlined /> },
      { key: 'notifications', label: 'Routes', icon: <BranchesOutlined /> },
    ],
  },
  {
    key: 'tools',
    label: 'Tools',
    type: 'group',
    children: [
      { key: 'gitops', label: 'Gitops Deploy', icon: <RocketOutlined /> },
      { key: 'promql', label: 'PromQL Builder', icon: <BarChartOutlined /> },
    ],
  },
]

function AppContent() {
  const [page, setPage] = useState('alert-user')
  const [collapsed, setCollapsed] = useState(false)
  const { token } = theme.useToken()
  const auth = useAuth()
  const gitStatus = useGitStatus()

  if (auth.loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Spin size="large" />
      </div>
    )
  }

  if (!auth.isAuthenticated) {
    return <LoginPage />
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        breakpoint="md"
        theme="dark"
        width={200}
      >
        <div style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          padding: collapsed ? 0 : '0 16px',
          margin: '12px 0',
          color: token.colorPrimary,
          fontWeight: 700,
          fontSize: 14,
          letterSpacing: '0.03em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}>
          {collapsed ? 'AT' : 'Alert Template UI'}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[page]}
          onClick={({ key }) => setPage(key)}
          items={menuItems}
        />
      </Sider>
      <Content style={{ overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <GitStatusBar gitStatus={gitStatus} onRefresh={gitStatus.refresh} />
        {page === 'template-dev' && <TemplateDevEditor />}
        {page === 'alert-user'   && <AlertUserView />}
        {page === 'notifications' && <NotificationRoutesEditor />}
        {page === 'gitops'       && <GitopsEditor />}
        {page === 'promql'       && <PromQLEditor onNavigate={setPage} />}
      </Content>
    </Layout>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}
