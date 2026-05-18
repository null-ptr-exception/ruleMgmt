import { Layout, Button, Typography, Empty, Tag } from 'antd'
import { PlusOutlined } from '@ant-design/icons'

const { Sider, Content } = Layout
const { Text } = Typography

function VersionList({ templates, selected, onSelect }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {Object.keys(templates).length === 0 && (
        <div style={{ padding: '20px 14px', color: '#8c8c8c', fontSize: 13 }}>Nothing yet.</div>
      )}
      {Object.entries(templates).map(([name, versions]) => (
        <div key={name}>
          <div style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, color: '#595959' }}>
            {name}
          </div>
          {versions.map(v => {
            const isActive = selected?.name === name && selected?.version === v
            return (
              <div
                key={v}
                onClick={() => onSelect(name, v)}
                style={{
                  padding: '4px 16px 4px 28px',
                  cursor: 'pointer',
                  fontSize: 12,
                  background: isActive ? '#e6f4ff' : undefined,
                  fontWeight: isActive ? 600 : undefined,
                  color: isActive ? '#1677ff' : '#262626',
                }}
              >
                <Tag color={isActive ? 'blue' : 'default'} style={{ fontSize: 11 }}>{v}</Tag>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export default function EditorLayout({
  title,
  templates,
  selected,
  onSelect,
  onNew,
  emptyIcon = '📝',
  emptyText = 'Select an item or click + New.',
  children,
  siderWidth = 240,
}) {
  return (
    <Layout style={{ height: '100%' }}>
      <Sider width={siderWidth} theme="light" style={{ borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{
          padding: '10px 16px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.04em', color: '#8c8c8c', borderBottom: '1px solid #f0f0f0',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          {title}
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={onNew}>New</Button>
        </div>
        <VersionList templates={templates} selected={selected} onSelect={onSelect} />
      </Sider>
      <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children || (
          <Empty
            style={{ margin: 'auto' }}
            description={emptyText}
          />
        )}
      </Content>
    </Layout>
  )
}
