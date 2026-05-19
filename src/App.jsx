import { useState, useEffect } from 'react'
import { Layout, Menu, Badge, theme } from 'antd'
import {
  ToolOutlined,
  BellOutlined,
  BranchesOutlined,
  UserOutlined,
  LogoutOutlined,
  GitlabOutlined,
} from '@ant-design/icons'
import { getUserInfo } from './utils/chartApi'
import NotificationRoutesEditor from './pages/NotificationRoutesEditor'
import TemplateDevEditor from './pages/TemplateDevEditor'
import AlertUserView from './pages/AlertUserView'
import GitPanel from './components/GitPanel'
import { useGitStatus } from './hooks/useGitStatus'
import './App.css'

const { Sider, Content } = Layout

export default function App() {
  const [page, setPage] = useState('alert-user')
  const [collapsed, setCollapsed] = useState(false)
  const [userInfo, setUserInfo] = useState({ user: null, logoutUrl: null })
  const { token } = theme.useToken()
  const gitStatus = useGitStatus()

  useEffect(() => {
    getUserInfo().then(setUserInfo)
  }, [])

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
      key: 'git-group',
      label: 'Source Control',
      type: 'group',
      children: [
        {
          key: 'git',
          label: gitStatus.changeCount > 0
            ? <span>Git <Badge count={gitStatus.changeCount} size="small" style={{ marginLeft: 6 }} /></span>
            : 'Git',
          icon: <GitlabOutlined />,
        },
      ],
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
          onClick={({ key }) => setPage(key)}
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
        {page === 'template-dev'  && <TemplateDevEditor />}
        {page === 'alert-user'    && <AlertUserView />}
        {page === 'notifications' && <NotificationRoutesEditor />}
        {page === 'git'           && <GitPanel gitStatus={gitStatus} onRefresh={gitStatus.refresh} />}
      </Content>
    </Layout>
  )
}
