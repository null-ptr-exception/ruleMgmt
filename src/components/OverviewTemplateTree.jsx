import { useState } from 'react'
import { Input } from 'antd'
import { RightOutlined } from '@ant-design/icons'
import { buildTree } from '../utils/treeGrouping'

function getLeaves(node) {
  if (!node.children) return [node.fullName]
  return node.children.flatMap(getLeaves)
}

function TreeNode({ node, checked, onToggle, searchActive }) {
  const [expanded, setExpanded] = useState(true)

  if (node.children) {
    const leaves = getLeaves(node)
    const allChecked = leaves.every(l => checked.has(l))
    const someChecked = leaves.some(l => checked.has(l))

    return (
      <div>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}
        >
          <input
            type="checkbox"
            checked={allChecked}
            ref={el => { if (el) el.indeterminate = someChecked && !allChecked }}
            onChange={() => onToggle(leaves, !allChecked)}
            style={{ width: 13, height: 13, flexShrink: 0, cursor: 'pointer' }}
          />
          <span
            style={{ flex: 1, fontWeight: 500, color: '#595959' }}
            onClick={() => setExpanded(e => !e)}
          >
            {node.label}
          </span>
          <span style={{ fontSize: 10, color: '#9ca3af', background: '#f3f4f6', border: '0.5px solid #e5e7eb', borderRadius: 8, padding: '0 4px' }}>
            {leaves.length}
          </span>
          {!searchActive && (
            <RightOutlined
              style={{ fontSize: 9, color: '#9ca3af', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
              onClick={() => setExpanded(e => !e)}
            />
          )}
        </div>
        {(expanded || searchActive) && (
          <div style={{ paddingLeft: 12 }}>
            {node.children.map(child => (
              <TreeNode key={child.fullName || child.label} node={child} checked={checked} onToggle={onToggle} searchActive={searchActive} />
            ))}
          </div>
        )}
      </div>
    )
  }

  const isChecked = checked.has(node.fullName)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px 3px 22px', cursor: 'pointer', fontSize: 12 }}>
      <input
        type="checkbox"
        checked={isChecked}
        onChange={() => onToggle([node.fullName], !isChecked)}
        style={{ width: 13, height: 13, flexShrink: 0, cursor: 'pointer' }}
      />
      <span style={{ color: isChecked ? '#1677ff' : '#262626' }}>{node.label}</span>
    </div>
  )
}

export default function OverviewTemplateTree({ templates = [], checked, onCheckedChange }) {
  const [search, setSearch] = useState('')

  const names = templates.map(t => typeof t === 'string' ? t : t.name)

  const filtered = search
    ? names.filter(n => n.toLowerCase().includes(search.toLowerCase()))
    : names

  const tree = buildTree(filtered)
  const checkedSet = new Set(checked)

  function handleToggle(leaves, value) {
    const next = new Set(checkedSet)
    leaves.forEach(l => value ? next.add(l) : next.delete(l))
    onCheckedChange([...next])
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, borderBottom: '1px solid #f0f0f0' }}>
        <Input
          size="small"
          placeholder="Search alert types..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {tree.length === 0 && (
          <div style={{ padding: '12px 10px', fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
            No alert types found
          </div>
        )}
        {tree.map(node => (
          <TreeNode
            key={node.fullName || node.label}
            node={node}
            checked={checkedSet}
            onToggle={handleToggle}
            searchActive={!!search}
          />
        ))}
      </div>
    </div>
  )
}
