import { useState } from 'react'
import { Button, Input, Modal, Radio, Select, Table, Typography, Alert } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { configProblems } from '../utils/routingGenerator'
import { putConfig, removeConfig } from '../utils/routingModel'

const { Text } = Typography

/** What a config sends to, in one line. */
export function configTarget(config) {
  if (config?.type === 'email') return config.to
  if (config?.urlSecret) return `Secret ${config.urlSecret.name} / ${config.urlSecret.key}`
  return config?.url
}

const blank = { name: '', type: 'webhook', where: 'url', to: '', url: '', secretName: '', secretKey: '' }

// The config comes from parseRouting, so its fields are text.
function toForm(name, config) {
  return {
    ...blank,
    name,
    type: config.type === 'email' ? 'email' : 'webhook',
    where: config.urlSecret ? 'secret' : 'url',
    to: config.to || '',
    url: config.url || '',
    secretName: config.urlSecret?.name || '',
    secretKey: config.urlSecret?.key || '',
  }
}

function fromForm(form) {
  if (form.type === 'email') return { type: 'email', to: form.to.trim() }
  return form.where === 'secret'
    ? { type: 'webhook', urlSecret: { name: form.secretName.trim(), key: form.secretKey.trim() } }
    : { type: 'webhook', url: form.url.trim() }
}

/**
 * The deployment's notification configs (#93): who a cell can notify. Kept in
 * this deployment's routing.yaml, not shared with others. One a cell still
 * uses cannot be removed — the cells are listed instead.
 */
export default function NotificationConfigs({ routing, onChange, readOnly, describeMatch }) {
  const [editing, setEditing] = useState(null) // { was, form }

  const configs = Object.entries(routing.configs || {})
  const form = editing?.form
  const setForm = patch => setEditing(e => ({ ...e, form: { ...e.form, ...patch } }))

  const name = form?.name.trim()
  const taken = form && name !== editing.was && Object.hasOwn(routing.configs, name)
  const problems = form ? [
    ...(taken ? [`${name} is already a config`] : []),
    ...configProblems(name, fromForm(form)).map(p => p.replace(/^configs\.[^:]*: /, '')),
  ] : []
  // Every field filled before the problems are shown: an empty form is not wrong yet.
  const filled = form && name && (form.type === 'email' ? form.to.trim()
    : form.where === 'url' ? form.url.trim() : form.secretName.trim() && form.secretKey.trim())

  function save() {
    onChange(putConfig(routing, name, fromForm(form), { was: editing.was ?? name }))
    setEditing(null)
  }

  function remove(configName) {
    const result = removeConfig(routing, configName)
    if (result.usedBy) {
      Modal.error({
        title: `${configName} is still notified by ${result.usedBy.length} cell${result.usedBy.length > 1 ? 's' : ''}`,
        content: (
          <>
            <ul style={{ paddingLeft: 18, marginTop: 8 }}>
              {result.usedBy.map((m, i) => <li key={i}>{describeMatch(m)}</li>)}
            </ul>
            <Text type="secondary">Take it out of those cells first.</Text>
          </>
        ),
      })
      return
    }
    onChange(result.routing)
  }

  return (
    <div data-testid="notification-configs">
      <Table
        size="small"
        pagination={false}
        rowKey="name"
        dataSource={configs.map(([n, c]) => ({ name: n, config: c }))}
        locale={{ emptyText: 'No one to notify yet — add a config' }}
        columns={[
          { title: 'Name', dataIndex: 'name', width: 180 },
          { title: 'Type', render: (_, r) => r.config?.type, width: 90 },
          { title: 'Sends to', render: (_, r) => <Text style={{ fontSize: 13 }}>{configTarget(r.config)}</Text> },
          {
            title: '', width: 80,
            render: (_, r) => (
              <span style={{ whiteSpace: 'nowrap' }}>
                <Button type="text" size="small" icon={<EditOutlined />} aria-label={`Edit ${r.name}`} disabled={readOnly}
                  onClick={() => setEditing({ was: r.name, form: toForm(r.name, r.config) })} />
                <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`Delete ${r.name}`} disabled={readOnly}
                  onClick={() => remove(r.name)} />
              </span>
            ),
          },
        ]}
      />
      <Button type="dashed" size="small" icon={<PlusOutlined />} style={{ marginTop: 8 }} disabled={readOnly}
        onClick={() => setEditing({ was: undefined, form: { ...blank } })}>
        Add config
      </Button>

      {form && (
        <Modal open title={editing.was ? `Edit ${editing.was}` : 'Add config'} okText={editing.was ? 'Save' : 'Add'}
          okButtonProps={{ disabled: !filled || problems.length > 0 }}
          onOk={save} onCancel={() => setEditing(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <Input aria-label="Config name" placeholder="name, e.g. db-email" value={form.name}
              onChange={e => setForm({ name: e.target.value })} />
            <Select aria-label="Config type" value={form.type} onChange={type => setForm({ type })}
              options={[{ value: 'webhook', label: 'webhook' }, { value: 'email', label: 'email' }]} />
            {form.type === 'email' ? (
              <Input aria-label="Email address" placeholder="db@example.com" value={form.to}
                onChange={e => setForm({ to: e.target.value })} />
            ) : (
              <>
                <Radio.Group value={form.where} onChange={e => setForm({ where: e.target.value })}
                  options={[{ value: 'url', label: 'URL' }, { value: 'secret', label: 'URL in a Secret' }]} />
                {form.where === 'url' ? (
                  <Input aria-label="Webhook URL" placeholder="http://alert-relay.monitoring.svc:8080" value={form.url}
                    onChange={e => setForm({ url: e.target.value })} />
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Input aria-label="Secret name" placeholder="Secret name" value={form.secretName}
                        onChange={e => setForm({ secretName: e.target.value })} />
                      <Input aria-label="Secret key" placeholder="key" value={form.secretKey}
                        onChange={e => setForm({ secretKey: e.target.value })} />
                    </div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Make sure the Secret exists in this deployment&apos;s namespace — AlertForge cannot see the cluster.
                    </Text>
                  </>
                )}
              </>
            )}
            {filled && problems.length > 0 && (
              <Alert type="error" showIcon data-testid="config-problems"
                message={problems.map((p, i) => <div key={i}>{p}</div>)} />
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
