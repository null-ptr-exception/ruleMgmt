import { useState, useEffect, useCallback } from 'react'
import { Tree, Tag } from 'antd'
import { FolderOutlined } from '@ant-design/icons'
import { getFolderTree } from '../utils/chartApi'

function toTreeNode(node) {
  const titleContent = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span>{node.name}</span>
      {node.isDeployment && (
        <Tag
          color="blue"
          style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}
        >
          {node.chart}
        </Tag>
      )}
    </span>
  )

  return {
    key: node.path,
    title: titleContent,
    icon: <FolderOutlined />,
    isLeaf: node.isLeaf,
    isDeployment: node.isDeployment,
    chart: node.chart,
  }
}

export default function DeploymentTree({ selectedFolder, onSelect, refreshKey }) {
  const [treeData, setTreeData] = useState([])
  const [expandedKeys, setExpandedKeys] = useState([])

  const loadChildren = useCallback(async (parentPath = '') => {
    const children = await getFolderTree(parentPath)
    return children.map(toTreeNode)
  }, [])

  // Load root on mount and when refreshKey changes
  useEffect(() => {
    loadChildren().then(setTreeData)
  }, [loadChildren, refreshKey])

  // When selectedFolder is set (e.g. from session restore), expand its ancestors
  useEffect(() => {
    if (!selectedFolder) return
    const parts = selectedFolder.split('/')
    const paths = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
    // Load each ancestor level to build the path
    async function expandPath() {
      let currentData = await loadChildren()
      const keys = []
      for (let i = 0; i < paths.length - 1; i++) {
        keys.push(paths[i])
        const children = await loadChildren(paths[i])
        currentData = insertChildren(currentData, paths[i], children)
      }
      setTreeData(currentData)
      setExpandedKeys(keys)
    }
    expandPath()
  }, [selectedFolder, loadChildren, refreshKey])

  function insertChildren(nodes, parentKey, children) {
    return nodes.map(node => {
      if (node.key === parentKey) {
        return { ...node, children }
      }
      if (node.children) {
        return { ...node, children: insertChildren(node.children, parentKey, children) }
      }
      return node
    })
  }

  async function onLoadData(node) {
    if (node.children) return
    const children = await loadChildren(node.key)
    setTreeData(prev => insertChildren(prev, node.key, children))
  }

  function handleSelect(selectedKeys) {
    if (selectedKeys.length === 0) return
    const key = selectedKeys[0]
    const node = findNode(treeData, key)
    if (node?.isDeployment) {
      onSelect({ path: node.key, chart: node.chart })
    }
  }

  function findNode(nodes, key) {
    for (const n of nodes) {
      if (n.key === key) return n
      if (n.children) {
        const found = findNode(n.children, key)
        if (found) return found
      }
    }
    return null
  }

  return (
    <div style={{ padding: '4px 8px' }}>
      <Tree
        showIcon
        treeData={treeData}
        selectedKeys={selectedFolder ? [selectedFolder] : []}
        expandedKeys={expandedKeys}
        onExpand={setExpandedKeys}
        onSelect={handleSelect}
        loadData={onLoadData}
        style={{ fontSize: 13 }}
      />
    </div>
  )
}
