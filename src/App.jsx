import { useState, useEffect, useCallback } from 'react'
import { Layout, Menu, Badge, theme } from 'antd'
import {
  ToolOutlined,
  BellOutlined,
  GlobalOutlined,
  UserOutlined,
  LogoutOutlined,
  GitlabOutlined,
} from '@ant-design/icons'
import { getUserInfo } from './utils/chartApi'
import TemplateDevEditor from './pages/TemplateDevEditor'
import AlertUserView from './pages/AlertUserView'
import ZoneManager from './pages/ZoneManager'
import GitPanel from './components/GitPanel'
import { useGitStatus } from './hooks/useGitStatus'
import './App.css'

const HASH_TO_PAGE = { '#/templates': 'template-dev', '#/alerts': 'alert-user', '#/zones': 'zones', '#/git': 'git' }
const PAGE_TO_HASH = Object.fromEntries(Object.entries(HASH_TO_PAGE).map(([k, v]) => [v, k]))

function getPageFromHash() {
  return HASH_TO_PAGE[window.location.hash] || 'alert-user'
}

const { Sider, Content } = Layout

export default function App() {
  const [page, setPage] = useState(getPageFromHash)
  const [collapsed, setCollapsed] = useState(false)
  const [userInfo, setUserInfo] = useState({ user: null, logoutUrl: null })
  const { token } = theme.useToken()
  const gitStatus = useGitStatus()

  const navigate = useCallback((key) => {
    setPage(key)
    window.location.hash = PAGE_TO_HASH[key] || ''
  }, [])

  useEffect(() => {
    const onHashChange = () => setPage(getPageFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    getUserInfo().then(setUserInfo)
  }, [])

  const menuItems = [
    { key: 'template-dev', label: 'Templates', icon: <ToolOutlined /> },
    { key: 'alert-user',   label: 'Alerts',    icon: <BellOutlined /> },
    { key: 'zones',        label: 'Zones',     icon: <GlobalOutlined /> },
    {
      key: 'git',
      label: gitStatus.changeCount > 0
        ? <span>Git <Badge count={gitStatus.changeCount} size="small" style={{ marginLeft: 6 }} /></span>
        : 'Git',
      icon: <GitlabOutlined />,
    },
  ]

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        breakpoint="md"
        theme="dark"
        width={200}
        style={{ display: 'flex', flexDirection: 'column' }}
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
          {collapsed ? 'AF' : 'AlertForge'}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[page]}
          onClick={({ key }) => navigate(key)}
          items={menuItems}
          style={{ flex: 1 }}
        />
        {userInfo.user && (
          <div style={{
            padding: collapsed ? '12px 0' : '12px 16px',
            borderTop: '1px solid rgba(255,255,255,0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'space-between',
            gap: 8,
          }}>
            <span style={{ color: '#ffffffa6', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: collapsed ? 'none' : 'inline-flex', alignItems: 'center', gap: 6 }}>
              <UserOutlined /> {userInfo.user}
            </span>
            {userInfo.logoutUrl && (
              <a href={userInfo.logoutUrl} title="Logout" style={{ color: '#ffffffa6', fontSize: 14 }}>
                <LogoutOutlined />
              </a>
            )}
          </div>
        )}
      </Sider>
      <Content style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', flex: 1 }}>
        {page === 'template-dev' && <TemplateDevEditor />}
        {page === 'alert-user'   && <AlertUserView />}
        {page === 'zones'        && <ZoneManager />}
        {page === 'git'          && <GitPanel gitStatus={gitStatus} onRefresh={gitStatus.refresh} />}
      </Content>
    </Layout>
  )
}
