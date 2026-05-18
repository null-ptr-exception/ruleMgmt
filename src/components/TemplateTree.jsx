import { useState } from 'react'
import { Typography, Badge } from 'antd'
import { RightOutlined } from '@ant-design/icons'
import { buildTree } from '../utils/treeGrouping'

const { Text } = Typography

function countLeaves(node) {
  if (!node.children || node.children.length === 0) return 1
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0)
}

function TreeNode({ node, activeTemplate, onSelect }) {
  const [expanded, setExpanded] = useState(true)

  if (node.children && node.children.length > 0) {
    return (
      <div>
        <div
          onClick={() => setExpanded(!expanded)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 12px', cursor: 'pointer', fontSize: 13,
            color: '#595959',
          }}
        >
          <RightOutlined style={{
            fontSize: 10, transition: 'transform 0.2s',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }} />
          <Text strong style={{ fontSize: 13 }}>{node.label}</Text>
          <Badge count={countLeaves(node)} showZero color="#d9d9d9" style={{ color: '#595959' }} />
        </div>
        {expanded && (
          <div style={{ paddingLeft: 12 }}>
            {node.children.map((child) => (
              <TreeNode
                key={child.fullName || child.label}
                node={child}
                activeTemplate={activeTemplate}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  const isActive = node.fullName === activeTemplate
  return (
    <div
      onClick={() => onSelect(node.fullName)}
      style={{
        padding: '5px 12px 5px 30px',
        cursor: 'pointer',
        fontSize: 13,
        background: isActive ? '#e6f4ff' : undefined,
        fontWeight: isActive ? 600 : undefined,
        color: isActive ? '#1677ff' : '#262626',
      }}
    >
      {node.label}
    </div>
  )
}

export default function TemplateTree({ templates, activeTemplate, onSelect }) {
  const names = (templates || []).map((t) => (typeof t === 'string' ? t : t.name))
  const tree = buildTree(names)

  return (
    <div style={{ padding: '4px 0' }}>
      {tree.map((node) => (
        <TreeNode
          key={node.fullName || node.label}
          node={node}
          activeTemplate={activeTemplate}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}
