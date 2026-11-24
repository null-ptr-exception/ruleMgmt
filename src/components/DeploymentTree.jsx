import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Tree, Tag, Dropdown, Modal, Tooltip, message } from 'antd'
import { FolderOutlined, MoreOutlined, WarningOutlined } from '@ant-design/icons'
import { isReservedName, RESERVED_HINT, COMMON_DIR } from '../utils/reservedNames'
import { getFolderTree, getSyncRegistry, unlinkSync, deleteDeployment } from '../utils/chartApi'
import SyncToModal from './SyncToModal'
import SyncFromModal from './SyncFromModal'
import DeleteSourceModal from './DeleteSourceModal'
import CommonModal from './CommonModal'
import { stackNote } from '../utils/stackNote'

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

// A node's actions: a visible "..." button and the right-click menu, the
// same items. Right-click alone would leave keyboard and touch users out.
// `label` names the button: a deployment's by its name; a folder's by what
// it is, inside its tree item — a folder named like a page's button
// ("…-save-test") must not be found as that button.
function withMenu(titleInner, label, items, onPick) {
  const onClick = ({ key, domEvent }) => { domEvent?.stopPropagation(); onPick(key) }
  return (
    <Dropdown menu={{ items, onClick }} trigger={['contextMenu']}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {titleInner}
        <Dropdown menu={{ items, onClick }} trigger={['click']}>
          <button
            type="button"
            aria-label={label}
            onClick={e => e.stopPropagation()}
            style={{
              border: 'none',
              background: 'transparent',
              padding: '0 2px',
              cursor: 'pointer',
              color: '#9ca3af',
              lineHeight: 1,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <MoreOutlined />
          </button>
        </Dropdown>
      </span>
    </Dropdown>
  )
}

function toTreeNode(node, registry, handlers) {
  const status = node.isDeployment ? getSyncStatus(registry, node.path) : { role: null }

  const badge = status.role === 'source'
    ? <Tag color="purple" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>source</Tag>
    : status.role === 'target'
      ? <Tag color="orange" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>synced</Tag>
      : null

  // A deployment on another _common than its folder's (#103): a sync target
  // follows its source's; one unlinked, or moved, keeps what it has.
  const follows = node.isDeployment ? stackNote(node.inheritsFrom, node.folderCommon, status.role === 'target' ? 'source' : null) : null

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
      {node.isCommon && (
        <Tooltip title={`What the deployments of ${node.chart} under this folder inherit`}>
          <Tag color="geekblue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>inherited by the folder</Tag>
        </Tooltip>
      )}
      {node.isCommon && node.problems?.length > 0 && (
        <Tooltip title={node.problems.join('\n')}>
          <WarningOutlined aria-label="broken _common" style={{ color: '#dc2626' }} />
        </Tooltip>
      )}
      {badge}
      {follows && (
        <Tooltip title={status.role === 'target'
          ? `A sync target renders its source's files, the ${COMMON_DIR} it inherits from included`
          : `Its Chart.yaml depends on another ${COMMON_DIR} than its folder's (left from a sync, or moved): it inherits that one`}>
          <Tag data-testid="follows-source-common" color="geekblue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>{follows}</Tag>
        </Tooltip>
      )}
      {node.isDeployment && (node.nestedIn || node.inCommon) && (
        // An existing deployment where no new one can be made: flagged,
        // still usable. Every list and the migration still find it.
        <Tooltip title={node.nestedIn
          ? `Inside the deployment ${node.nestedIn}: a deployment cannot hold another — move it to a folder of its own`
          : `Inside a ${COMMON_DIR} folder, which holds what the deployments beside it inherit — move it out`}>
          <WarningOutlined aria-label="misplaced deployment" style={{ color: '#d97706' }} />
        </Tooltip>
      )}
      {node.noValues && (
        <Tooltip title={`A Chart.yaml for ${node.chart} with no values.yaml: Helm deploys the Template's example rows. Add a values.yaml, or remove the folder`}>
          <WarningOutlined aria-label="no values of its own" style={{ color: '#d97706' }} />
        </Tooltip>
      )}
      {node.unreadable && (
        <Tooltip title={`This folder cannot be read (${node.unreadable}): the deployments in it are not listed, checked or migrated`}>
          <WarningOutlined aria-label="cannot be read" style={{ color: '#dc2626' }} />
        </Tooltip>
      )}
      {isReservedName(node.name) && node.name !== COMMON_DIR && (
        // An existing folder with a reserved name (#99): flagged, still
        // usable. An icon, not a Tag: a Tag in a node marks a deployment.
        <Tooltip title={`${RESERVED_HINT} — rename this folder`}>
          <WarningOutlined aria-label="reserved name" style={{ color: '#d97706' }} />
        </Tooltip>
      )}
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
    titleContent = withMenu(titleInner, `Actions for ${node.name}`, menuItems, key => {
      if (key === 'sync-to') handlers.onSyncTo(treeNode)
      else if (key === 'sync-from') handlers.onSyncFrom(treeNode)
      else if (key === 'unlink') handlers.onUnlink(treeNode)
      else if (key === 'delete') handlers.onDelete(treeNode, status)
    })
  } else if (node.isCommon) {
    // A folder's _common (#101): opened like a deployment, removed from here.
    titleContent = withMenu(titleInner, `${COMMON_DIR} actions`, [{ key: 'delete-common', label: `Remove this ${COMMON_DIR}...`, danger: true }],
      () => handlers.onDeleteCommon(node.path))
  } else if (node.name !== COMMON_DIR) {
    titleContent = withMenu(titleInner, 'Folder actions', [{ key: 'add-common', label: `Add ${COMMON_DIR}...` }],
      () => handlers.onAddCommon(node.path))
  }

  return {
    key: node.path,
    title: titleContent,
    icon: <FolderOutlined />,
    isLeaf: node.isLeaf,
    isDeployment: node.isDeployment,
    isCommon: node.isCommon,
    chart: node.chart,
    name: node.name,
    path: node.path,
  }
}

// In Overview the deployments of the selected chart can be checked to view
// several at once (#91). Applied at render rather than when the nodes are
// built: the nodes outlive changes of chart, and only a deployment is ever
// checkable — the tree loads level by level, so a folder could not stand for
// its children anyway.
function withChecks(nodes, chart) {
  return nodes.map(n => {
    const children = n.children && withChecks(n.children, chart)
    if (!n.isDeployment) return { ...n, checkable: false, ...(children ? { children } : {}) }
    if (n.chart === chart) return n
    return {
      ...n,
      disableCheckbox: true,
      title: <Tooltip title={`Only deployments of one chart can be viewed together (current: ${chart})`}>{n.title}</Tooltip>,
    }
  })
}

export default function DeploymentTree({ selectedFolder, onSelect, refreshKey, onSyncChange, checkable = false, checkedKeys = [], checkChart = null, onCheck, onRemoved, onCommonChange, confirmLeave }) {
  const [treeData, setTreeData] = useState([])
  const [expandedKeys, setExpandedKeys] = useState([])
  // Tree node titles embed handlers (e.g. handleUnlink -> refreshAll) that get
  // frozen at whichever render first created that specific node — which can
  // be long before the node is expanded further. A ref keeps refreshAll
  // reading the *current* expansion set regardless of which render's
  // closure ends up calling it.
  const expandedKeysRef = useRef([])
  // Same stale-closure hazard as expandedKeysRef: delete handlers embedded
  // in tree node titles must see the selection at delete time, not at the
  // render that created the node.
  const selectedFolderRef = useRef(selectedFolder)
  selectedFolderRef.current = selectedFolder
  // Same again for the parent's callback: a deleted or unlinked deployment
  // leaves the checked set.
  const onRemovedRef = useRef(onRemoved)
  onRemovedRef.current = onRemoved
  // Asked before a _common is made or removed: it reloads the page open.
  const confirmLeaveRef = useRef(confirmLeave)
  confirmLeaveRef.current = confirmLeave
  const [syncRegistry, setSyncRegistry] = useState({ syncs: [] })
  const [syncToNode, setSyncToNode] = useState(null)
  const [syncFromNode, setSyncFromNode] = useState(null)
  const [deleteSourceInfo, setDeleteSourceInfo] = useState(null)
  const [commonAction, setCommonAction] = useState(null)

  const loadChildren = useCallback(async (parentPath = '') => {
    return getFolderTree(parentPath)
  }, [])

  const leaveOk = async () => (confirmLeaveRef.current ? (await confirmLeaveRef.current()) !== false : true)

  function buildTreeNodes(rawChildren, registry) {
    return rawChildren.map(n => toTreeNode(n, registry, {
      onSyncTo: setSyncToNode,
      onSyncFrom: setSyncFromNode,
      onUnlink: handleUnlink,
      onDelete: handleDeleteClick,
      onAddCommon: async folder => { if (await leaveOk()) setCommonAction({ mode: 'create', folder }) },
      onDeleteCommon: async commonPath => { if (await leaveOk()) setCommonAction({ mode: 'delete', commonPath }) },
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
  // mutation. Reads expandedKeysRef.current (not the expandedKeys closure)
  // so it always sees the latest expansion set, no matter which render's
  // closure ends up calling it. `ensureKeys` adds paths that must end up
  // expanded (a selected folder's ancestors) on top of — never instead of —
  // what the user already has open.
  async function refreshAll(ensureKeys = []) {
    const [registry, rootChildren] = await Promise.all([getSyncRegistry(), loadChildren('')])
    setSyncRegistry(registry)

    let newTreeData = buildTreeNodes(rootChildren, registry)
    // Parents must be inserted before their descendants, but expandedKeys
    // can't be trusted to be in that order: antd keeps descendant keys when
    // an ancestor is collapsed, and re-expanding appends the ancestor after
    // them. insertChildren against a not-yet-populated parent is a silent
    // no-op, which is how expanded nodes ended up empty after a sync.
    const keys = [...new Set([...expandedKeysRef.current, ...ensureKeys])]
      .sort((a, b) => a.split('/').length - b.split('/').length)
    const childLists = await Promise.all(keys.map(key => loadChildren(key)))
    keys.forEach((key, i) => {
      newTreeData = insertChildren(newTreeData, key, buildTreeNodes(childLists[i], registry))
    })
    setTreeData(newTreeData)
    updateExpandedKeys(keys)
    onSyncChange?.()
  }

  function updateExpandedKeys(keys) {
    expandedKeysRef.current = keys
    setExpandedKeys(keys)
  }

  // The refreshKey the tree was last fetched for (#145).
  const handledRefreshKey = useRef(refreshKey)

  // Load root on mount and when refreshKey changes. When a folder is
  // selected, the effect below already does a full refresh that also
  // expands its ancestors — skip the duplicate here so two concurrent
  // refreshes can't race (the loser would clobber the winner's tree with a
  // staler expansion set).
  useEffect(() => {
    if (selectedFolder) return
    handledRefreshKey.current = refreshKey
    refreshAll()
  }, [refreshKey, selectedFolder])

  // When selectedFolder is set (session restore, tree click, or a freshly
  // created deployment), make sure its ancestors are expanded. This used to
  // rebuild the tree down to just that ancestor chain, which wiped the
  // loaded children of every other expanded branch on each selection — and
  // antd's internal loadedKeys then blocked loadData from refetching them,
  // so those branches re-expanded empty until a full reload.
  //
  // A click on the tree (#145) changes only selectedFolder, and its node is
  // already there under expanded, loaded parents: nothing to fetch. The tree
  // is fetched again when refreshKey changes (a deployment created; sync and
  // delete refresh the tree themselves), or when
  // the node or a parent is not in the tree yet (a session restored on an
  // empty tree, a deployment just created in a new folder).
  useEffect(() => {
    if (!selectedFolder) return
    const parts = selectedFolder.split('/')
    const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
    const refreshed = handledRefreshKey.current !== refreshKey
    handledRefreshKey.current = refreshKey
    const shown = !!findNode(treeData, selectedFolder) && ancestors.every(key =>
      expandedKeysRef.current.includes(key) && Array.isArray(findNode(treeData, key)?.children))
    if (!refreshed && shown) return
    refreshAll(ancestors)
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
    } else if (node?.isCommon) {
      onSelect({ path: node.key, chart: node.chart, isCommon: true })
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
      onRemovedRef.current?.([node.path])
      refreshAll()
    } else {
      message.error(result.error || 'Unlink failed')
    }
  }

  // If a deployment that just got deleted is (or contains) the current
  // selection, the editor pane would keep showing content that no longer
  // exists on disk — drop the selection so the parent resets.
  function clearSelectionIfDeleted(deletedPaths) {
    const sel = selectedFolderRef.current
    if (!sel) return
    if (deletedPaths.some(p => sel === p || sel.startsWith(p + '/'))) {
      onSelect(null)
    }
  }

  // The parent returns true when it has moved the selection itself (to
  // another checked deployment, #91).
  function removeDeleted(deletedPaths) {
    if (onRemovedRef.current?.(deletedPaths, { deleted: true })) return
    clearSelectionIfDeleted(deletedPaths)
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
          removeDeleted([node.path])
          refreshAll()
        } else {
          message.error(`Failed to delete ${node.name}: ${result.error}`)
        }
      },
    })
  }

  const shownTree = useMemo(() => (checkable ? withChecks(treeData, checkChart) : treeData), [treeData, checkable, checkChart])

  return (
    <div style={{ padding: '4px 8px' }}>
      <Tree
        showIcon
        treeData={shownTree}
        checkable={checkable}
        checkStrictly
        checkedKeys={checkable ? checkedKeys : []}
        onCheck={keys => onCheck?.(keys.checked)}
        selectedKeys={selectedFolder ? [selectedFolder] : []}
        expandedKeys={expandedKeys}
        onExpand={updateExpandedKeys}
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
      <CommonModal
        open={!!commonAction}
        mode={commonAction?.mode}
        folder={commonAction?.folder}
        commonPath={commonAction?.commonPath}
        onClose={() => setCommonAction(null)}
        onDone={result => {
          const parent = result.common.split('/').slice(0, -1).join('/')
          setCommonAction(null)
          if (result.action === 'delete') removeDeleted([result.common])
          refreshAll(result.action === 'create' ? [result.folder, parent] : [])
          onCommonChange?.(result)
        }}
      />
      <DeleteSourceModal
        open={!!deleteSourceInfo}
        source={deleteSourceInfo?.source}
        targets={deleteSourceInfo?.targets || []}
        onClose={() => setDeleteSourceInfo(null)}
        onSuccess={(deletedPaths = []) => {
          removeDeleted(deletedPaths)
          refreshAll()
        }}
      />
    </div>
  )
}
