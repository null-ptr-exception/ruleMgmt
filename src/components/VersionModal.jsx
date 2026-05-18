import { useState } from 'react'
import { Modal, Input, Typography } from 'antd'
import { isValidVersion } from '../utils/templateUtils'

const { Text } = Typography

export default function VersionModal({ defaultName, defaultVersion, onSave, onCancel }) {
  const hasName = defaultName !== undefined
  const [name, setName]       = useState(defaultName || '')
  const [version, setVersion] = useState(defaultVersion || 'v1.0.0')
  const valid = isValidVersion(version) && (!hasName || name.trim())

  const doSave = () => hasName ? onSave(name.trim(), version) : onSave(version)

  return (
    <Modal
      title="Save as Version"
      open
      onOk={doSave}
      onCancel={onCancel}
      okText="Save"
      okButtonProps={{ disabled: !valid }}
    >
      {hasName && (
        <div style={{ marginBottom: 16 }}>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>Instance Name</Text>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. platform-infra"
            autoFocus
          />
          {!name.trim() && <Text type="danger" style={{ fontSize: 12 }}>Name is required</Text>}
        </div>
      )}
      <div>
        <Text strong style={{ display: 'block', marginBottom: 4 }}>Version (e.g. v1.0.0)</Text>
        <Input
          value={version}
          onChange={e => setVersion(e.target.value)}
          placeholder="v1.0.0"
          autoFocus={!hasName}
          onPressEnter={() => valid && doSave()}
        />
        {!valid && version && !isValidVersion(version) && (
          <Text type="danger" style={{ fontSize: 12 }}>Must be in format v{'major'}.{'minor'}.{'patch'}</Text>
        )}
      </div>
    </Modal>
  )
}
