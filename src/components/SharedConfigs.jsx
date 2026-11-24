import { useEffect, useState } from 'react'
import { Alert, Button, Empty, Input, Modal, Table, Typography, message } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import { ConfigDialog, configTarget } from './NotificationConfigs'
import { sharedConfigProblems } from '../utils/routingGenerator'
import { configNameProblem } from '../utils/routingSchema'
import { overlapText } from '../utils/sharedOverlap'
import { blankForm, toForm } from '../utils/configForm'
import { getSharedConfigs, saveSharedConfigs, renameSharedConfig, regenerateShared } from '../utils/chartApi'

const { Title, Text } = Typography

const NOTE = 'Shared by the whole repo: every deployment using it gets its AlertmanagerConfig made again when it changes. It cannot read a Secret — a Secret is read from each deployment\'s own namespace.'

const where = u => (u.syncedFrom ? `${u.deployment} (synced from ${u.syncedFrom})` : u.deployment)

function List({ items }) {
  return <ul style={{ paddingLeft: 18, marginTop: 8 }}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
}

/**
 * The repo's shared notification configs (#123): what each sends to, who
 * uses it, and the resources behind them. Every change is written with
 * every resource made from it, after the page lists them.
 */
export default function SharedConfigs() {
  const [state, setState] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [editing, setEditing] = useState(null)
  const [renaming, setRenaming] = useState(null) // { from, to }

  useEffect(() => {
    let stale = false
    getSharedConfigs().then(s => { if (!stale) setState(s) })
    return () => { stale = true }
  }, [reloadKey])

  const reload = () => setReloadKey(k => k + 1)

  if (!state) return <Empty style={{ margin: 'auto' }} description="Loading..." />
  if (state.error) return <Empty style={{ margin: 'auto' }} description={state.error} />

  const usage = state.usage || {}
  const usersOf = name => (Object.hasOwn(usage, name) ? usage[name] : [])
  // A file with problems, or a _shared/ of the repo's own: fixed by hand.
  const readOnly = !!state.dirProblem || state.errors.length > 0

  function refused(result) {
    Modal.error({
      title: result.error || 'Not saved',
      width: 600,
      content: result.failed
        ? <List items={result.failed.map(f => `${f.deployment}: ${f.errors.join('; ')}`)} />
        : result.unreadable ? <List items={result.unreadable.map(u => `${u.deployment}: ${u.error}`)} />
        : result.problems?.length ? <List items={result.problems} /> : null,
    })
  }

  function done(result, what) {
    if (!result.ok) return refused(result)
    message.success(`${what}: ${result.written.length} file${result.written.length > 1 ? 's' : ''} written — commit them from the Git panel`)
    if (result.syncFailed?.length) message.warning(`Not copied to ${result.syncFailed.map(f => f.target).join(', ')}`)
    if (result.warnings?.length) message.warning({ content: result.warnings.join(' '), duration: 10 })
    reload()
  }

  // Ask first when the change reaches deployments, naming them.
  function confirmFor(users, title, ok) {
    if (!users.length) return ok()
    Modal.confirm({
      title,
      width: 560,
      content: (
        <div data-testid="shared-affected">
          <Text>{users.length} deployment{users.length > 1 ? 's use' : ' uses'} it; {users.length > 1 ? 'their' : 'its'} AlertmanagerConfig is made again:</Text>
          <List items={users.map(where)} />
        </div>
      ),
      okText: 'Save',
      onOk: ok,
    })
  }

  async function save(name, config) {
    const was = editing.was
    setEditing(null)
    const configs = Object.fromEntries(Object.entries(state.configs).map(([n, c]) => (n === was ? [n, config] : [n, c])))
    if (!was) configs[name] = config
    confirmFor(was ? usersOf(was) : [], `Change ${was}?`, async () => done(await saveSharedConfigs({ configs }), was ? `${was} saved` : `${name} added`))
  }

  async function remove(name) {
    const users = usersOf(name)
    if (users.length) {
      Modal.error({ title: `${name} is still used by ${users.length} deployment${users.length > 1 ? 's' : ''}`, content: <List items={users.map(where)} /> })
      return
    }
    const { [name]: _, ...configs } = state.configs
    done(await saveSharedConfigs({ configs }), `${name} deleted`)
  }

  async function rename() {
    const { from, to } = renaming
    setRenaming(null)
    confirmFor(usersOf(from), `Rename ${from} to ${to}?`, async () => done(await renameSharedConfig(from, to), `${from} renamed to ${to}`))
  }

  async function regenerate() {
    const result = await regenerateShared()
    if (!result.ok) return refused(result)
    if (result.failed.length) {
      Modal.error({ title: 'Some could not be made again', content: <List items={result.failed.map(f => `${f.deployment}: ${f.error}`)} /> })
    } else {
      message.success(`Made again: ${result.regenerated.join(', ')} — commit them from the Git panel`)
    }
    reload()
  }

  const renameProblem = renaming && (renaming.to === renaming.from ? 'the same name'
    : Object.hasOwn(state.configs, renaming.to) ? `${renaming.to} is already a shared config`
      : renaming.to && configNameProblem(renaming.to))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100 }} data-testid="shared-configs">
      <div>
        <Title level={5} style={{ marginTop: 0 }}>Shared configs</Title>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Kept in {state.file}, used by name from any deployment&apos;s routing (Add from shared). A Secret cannot be read
          from here: a config that needs one stays in each deployment&apos;s own routing, with the Secret in its namespace.
        </Text>
      </div>
      {state.dirProblem && <Alert type="error" showIcon data-testid="shared-dir-problem" message={state.dirProblem} />}
      {state.errors.length > 0 && (
        <Alert type="error" showIcon data-testid="shared-problems" message={`${state.file} has problems — fix it by hand`}
          description={<List items={state.errors} />} />
      )}
      {state.unreadable?.length > 0 && (
        <Alert type="error" showIcon data-testid="shared-unreadable"
          message="Some routing.yaml cannot be read — no shared config can be changed until they are fixed"
          description={<List items={state.unreadable.map(u => `${u.deployment}: ${u.error}`)} />} />
      )}
      {state.warnings?.length > 0 && (
        <Alert type="warning" showIcon data-testid="shared-warnings" message="Worth knowing about these configs"
          description={<List items={state.warnings} />} />
      )}
      {(state.overlaps?.overlaps?.length > 0 || state.overlaps?.unchecked?.length > 0) && (
        <Alert type="info" showIcon data-testid="shared-overlaps"
          message="Some deployments send the same alert to one shared config"
          description={(
            <>
              {state.overlaps.overlaps.length > 0 && <List items={state.overlaps.overlaps.map(overlapText)} />}
              {state.overlaps.unchecked.length > 0 && (
                <div data-testid="shared-overlaps-unchecked">
                  Not compared — their routing has problems, so what they match is not what they say: {state.overlaps.unchecked.join(', ')}
                </div>
              )}
              <Text type="secondary" style={{ fontSize: 12 }}>
                With alertmanagerConfigMatcherStrategy: None (what the how-to sets up), each of these cells notifies the config,
                so it gets that alert once per deployment. Synced copies are not listed: their cells are their source&apos;s.
                Nothing is refused: this is only said.
              </Text>
            </>
          )} />
      )}
      {state.stale.length > 0 && (
        <Alert type="warning" showIcon data-testid="shared-stale"
          message={`Behind the shared configs: ${state.stale.join(', ')}`}
          description="Their AlertmanagerConfig is not what their routing and the shared configs make now — a commit is refused until they are made again."
          action={<Button size="small" icon={<ReloadOutlined />} onClick={regenerate}>Regenerate</Button>} />
      )}
      <Table
        size="small"
        pagination={false}
        rowKey="name"
        dataSource={Object.entries(state.configs).map(([name, config]) => ({ name, config }))}
        locale={{ emptyText: 'No shared configs yet' }}
        expandable={{
          rowExpandable: r => usersOf(r.name).length > 0,
          expandedRowRender: r => <List items={usersOf(r.name).map(where)} />,
        }}
        columns={[
          { title: 'Name', dataIndex: 'name', width: 200 },
          { title: 'Type', render: (_, r) => r.config.type, width: 90 },
          { title: 'Sends to', render: (_, r) => <Text style={{ fontSize: 13 }}>{configTarget(r.config)}</Text> },
          {
            title: 'Used by', width: 120,
            render: (_, r) => <span data-testid={`used-by-${r.name}`}>{usersOf(r.name).length} deployment{usersOf(r.name).length === 1 ? '' : 's'}</span>,
          },
          {
            title: '', width: 150,
            render: (_, r) => (
              <span style={{ whiteSpace: 'nowrap' }}>
                <Button type="text" size="small" icon={<EditOutlined />} aria-label={`Edit ${r.name}`} disabled={readOnly}
                  onClick={() => setEditing({ was: r.name, form: toForm(r.name, r.config) })} />
                <Button type="link" size="small" aria-label={`Rename ${r.name}`} disabled={readOnly}
                  onClick={() => setRenaming({ from: r.name, to: '' })}>Rename</Button>
                <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`Delete ${r.name}`} disabled={readOnly}
                  onClick={() => remove(r.name)} />
              </span>
            ),
          },
        ]}
      />
      <div>
        <Button type="dashed" size="small" icon={<PlusOutlined />} disabled={readOnly}
          onClick={() => setEditing({ was: undefined, form: { ...blankForm } })}>
          Add shared config
        </Button>
      </div>

      {editing && (
        <ConfigDialog editing={editing} onOk={save} onCancel={() => setEditing(null)} note={NOTE}
          // The name stays: renaming reaches every routing.yaml, so it is its own action.
          nameLocked={!!editing.was} taken={name => Object.hasOwn(state.configs, name)}
          problemsOf={sharedConfigProblems} noSecrets />
      )}
      {renaming && (
        <Modal open title={`Rename ${renaming.from}`} okText="Rename" onCancel={() => setRenaming(null)} onOk={rename}
          okButtonProps={{ disabled: !renaming.to || !!renameProblem }}>
          <Input aria-label="New name" value={renaming.to} onChange={e => setRenaming({ ...renaming, to: e.target.value.trim() })} />
          {renaming.to && renameProblem && <Text type="danger" style={{ fontSize: 12 }}>{renameProblem}</Text>}
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
            Every routing.yaml using it is renamed too, its cells included.
          </Text>
        </Modal>
      )}
    </div>
  )
}
