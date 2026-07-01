import { useState, useEffect, useCallback } from 'react'
import { Tree, Tag, Dropdown, Modal, message } from 'antd'
import { FolderOutlined } from '@ant-design/icons'
import { getFolderTree, getSyncRegistry, unlinkSync, deleteDeployment } from '../utils/chartApi'
import SyncToModal from './SyncToModal'
import SyncFromModal from './SyncFromModal'
import DeleteSourceModal from './DeleteSourceModal'

function getSyncStatus(registry, nodePath) {
  const sourceEntry = registry.syncs.find(s => s.source === nodePath)
  if (sourceEntry && sourceEntry.targets.length > 0) {
    return { role: 'source', targets: sourceEntry.targets }
  }
  const targetEntry = registry.syncs.find(s => s.targets.includes(nodePath))
  if (targetEntry) {
    return { role: 'target', source: targetEntry.source }
  }
  return { role: null }
}

function toTreeNode(node, registry, handlers) {
  const status = node.isDeployment ? getSyncStatus(registry, node.path) : { role: null }

  const badge = status.role === 'source'
    ? <Tag color="purple" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>source</Tag>
    : status.role === 'target'
      ? <Tag color="orange" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>synced</Tag>
      : null

  const titleInner = (
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
      {badge}
    </span>
  )

  let titleContent = titleInner
  if (node.isDeployment) {
    const menuItems = []
    if (status.role !== 'target') {
      menuItems.push({ key: 'sync-to', label: 'Sync to...' })
    }
    if (status.role !== 'source') {
      menuItems.push({ key: 'sync-from', label: 'Sync from...' })
    }
    if (status.role === 'target') {
      menuItems.push({ key: 'unlink', label: 'Unlink sync' })
    }
    menuItems.push({ type: 'divider' })
    menuItems.push({ key: 'delete', label: 'Delete', danger: true })

    const treeNode = { key: node.path, name: node.name, path: node.path, chart: node.chart }
    const onMenuClick = ({ key, domEvent }) => {
      domEvent?.stopPropagation()
      if (key === 'sync-to') handlers.onSyncTo(treeNode)
      else if (key === 'sync-from') handlers.onSyncFrom(treeNode)
      else if (key === 'unlink') handlers.onUnlink(treeNode)
      else if (key === 'delete') handlers.onDelete(treeNode, status)
    }

    titleContent = (
      <Dropdown menu={{ items: menuItems, onClick: onMenuClick }} trigger={['contextMenu']}>
        {titleInner}
      </Dropdown>
    )
  }

  return {
    key: node.path,
    title: titleContent,
    icon: <FolderOutlined />,
    isLeaf: node.isLeaf,
    isDeployment: node.isDeployment,
    chart: node.chart,
    name: node.name,
    path: node.path,
  }
}

export default function DeploymentTree({ selectedFolder, onSelect, refreshKey }) {
  const [treeData, setTreeData] = useState([])
  const [expandedKeys, setExpandedKeys] = useState([])
  const [syncRegistry, setSyncRegistry] = useState({ syncs: [] })
  const [syncToNode, setSyncToNode] = useState(null)
  const [syncFromNode, setSyncFromNode] = useState(null)
  const [deleteSourceInfo, setDeleteSourceInfo] = useState(null)

  const loadChildren = useCallback(async (parentPath = '') => {
    return getFolderTree(parentPath)
  }, [])

  function buildTreeNodes(rawChildren, registry) {
    return rawChildren.map(n => toTreeNode(n, registry, {
      onSyncTo: setSyncToNode,
      onSyncFrom: setSyncFromNode,
      onUnlink: handleUnlink,
      onDelete: handleDeleteClick,
    }))
  }

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

  // Re-fetches the registry plus the root and every currently expanded
  // node's children, so badges/menus reflect the latest sync state after a
  // mutation. Reads expandedKeys fresh each call (not memoized) to avoid a
  // stale-closure bug where a handler frozen at an earlier render refreshes
  // against an outdated expansion set.
  async function refreshAll() {
    const registry = await getSyncRegistry()
    setSyncRegistry(registry)

    const rootChildren = await loadChildren('')
    let newTreeData = buildTreeNodes(rootChildren, registry)
    for (const key of expandedKeys) {
      const children = await loadChildren(key)
      newTreeData = insertChildren(newTreeData, key, buildTreeNodes(children, registry))
    }
    setTreeData(newTreeData)
  }

  // Load root on mount and when refreshKey changes
  useEffect(() => {
    refreshAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // When selectedFolder is set (e.g. from session restore), expand its ancestors
  useEffect(() => {
    if (!selectedFolder) return
    const parts = selectedFolder.split('/')
    const paths = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
    async function expandPath() {
      const registry = await getSyncRegistry()
      setSyncRegistry(registry)
      const rootChildren = await loadChildren('')
      let currentData = buildTreeNodes(rootChildren, registry)
      const keys = []
      for (let i = 0; i < paths.length - 1; i++) {
        keys.push(paths[i])
        const children = await loadChildren(paths[i])
        currentData = insertChildren(currentData, paths[i], buildTreeNodes(children, registry))
      }
      setTreeData(currentData)
      setExpandedKeys(keys)
    }
    expandPath()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolder, refreshKey])

  async function onLoadData(node) {
    if (node.children) return
    const children = await loadChildren(node.key)
    setTreeData(prev => insertChildren(prev, node.key, buildTreeNodes(children, syncRegistry)))
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

  async function handleUnlink(node) {
    const result = await unlinkSync(node.path)
    if (result.ok) {
      message.success(`Unlinked ${node.name}`)
      refreshAll()
    } else {
      message.error(result.error || 'Unlink failed')
    }
  }

  function handleDeleteClick(node, status) {
    if (status.role === 'source') {
      setDeleteSourceInfo({ source: node, targets: status.targets })
      return
    }
    Modal.confirm({
      title: `Delete ${node.name}?`,
      content: 'This cannot be undone.',
      okButtonProps: { danger: true },
      onOk: async () => {
        const result = await deleteDeployment(node.chart, node.name, node.path)
        if (result.ok) {
          message.success(`Deleted ${node.name}`)
          refreshAll()
        } else {
          message.error('Delete failed')
        }
      },
    })
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

      <SyncToModal
        open={!!syncToNode}
        source={syncToNode}
        onClose={() => setSyncToNode(null)}
        onSuccess={refreshAll}
      />
      <SyncFromModal
        open={!!syncFromNode}
        target={syncFromNode}
        onClose={() => setSyncFromNode(null)}
        onSuccess={refreshAll}
      />
      <DeleteSourceModal
        open={!!deleteSourceInfo}
        source={deleteSourceInfo?.source}
        targets={deleteSourceInfo?.targets || []}
        onClose={() => setDeleteSourceInfo(null)}
        onSuccess={refreshAll}
      />
    </div>
  )
}
