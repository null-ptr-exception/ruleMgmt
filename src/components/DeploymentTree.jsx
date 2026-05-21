import { useMemo } from 'react'
import { Tree, Tag } from 'antd'
import { FolderOutlined } from '@ant-design/icons'

function buildTreeData(nodes) {
  return nodes.map(node => {
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
      children: node.children?.length ? buildTreeData(node.children) : undefined,
      isLeaf: !node.children?.length,
    }
  })
}

function findExpandKeys(targetPath) {
  const parts = targetPath.split('/')
  const keys = []
  for (let i = 1; i < parts.length; i++) {
    keys.push(parts.slice(0, i).join('/'))
  }
  return keys
}

export default function DeploymentTree({ folderTree, selectedFolder, onSelect }) {
  const treeData = useMemo(() => buildTreeData(folderTree), [folderTree])

  const defaultExpandedKeys = useMemo(() => {
    if (!selectedFolder) return []
    return findExpandKeys(selectedFolder)
  }, [folderTree, selectedFolder])

  const nodeMap = useMemo(() => {
    const map = {}
    function walk(nodes) {
      for (const n of nodes) {
        if (n.isDeployment) map[n.path] = n
        if (n.children) walk(n.children)
      }
    }
    walk(folderTree)
    return map
  }, [folderTree])

  function handleSelect(selectedKeys) {
    if (selectedKeys.length === 0) return
    const key = selectedKeys[0]
    const node = nodeMap[key]
    if (node) {
      onSelect({ path: node.path, chart: node.chart })
    }
  }

  return (
    <div style={{ padding: '4px 8px' }}>
      <Tree
        showIcon
        treeData={treeData}
        selectedKeys={selectedFolder ? [selectedFolder] : []}
        defaultExpandedKeys={defaultExpandedKeys}
        onSelect={handleSelect}
        style={{ fontSize: 13 }}
      />
    </div>
  )
}
