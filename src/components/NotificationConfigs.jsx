import { useState } from 'react'
import { Button, Collapse, Input, Modal, Radio, Select, Table, Tag, Typography, Alert } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { configProblems, configWarnings } from '../utils/routingGenerator'
import { putConfig, removeConfig, sameConfig } from '../utils/routingModel'
import { blankForm as blank, toForm, fromForm, formProblems, dialogProblem } from '../utils/configForm'

const { Text } = Typography

const PLATFORM = 'platform default'
const CHOICES = [{ value: 'default', label: PLATFORM }, { value: 'yes', label: 'yes' }, { value: 'no', label: 'no' }]

// What a shared config (#123) cannot have, since each needs a Secret, which
// is read from each deployment's own namespace.
const NO_SECRETS_EMAIL = 'A shared e-mail config has no SMTP password: it would come from a Secret, which a shared config cannot read. A server of its own is handed the platform\'s login.'
const NO_SECRETS_WEBHOOK = 'A shared webhook cannot authenticate or read a CA: both come from a Secret, which a shared config cannot read. Keep such a webhook in each deployment\'s own routing.'

const SECRET_REMINDER = 'Make sure the Secret exists in this deployment\'s namespace — AlertForge cannot see the cluster.'

/** A Secret's name and key, side by side. */
function SecretFields({ label, name, keyValue, onName, onKey }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <Input aria-label={`${label} Secret name`} placeholder="Secret name" value={name} onChange={e => onName(e.target.value)} />
      <Input aria-label={`${label} Secret key`} placeholder="key" value={keyValue} onChange={e => onKey(e.target.value)} />
    </div>
  )
}

// A caption over a field or a group of them; each input names itself.
function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>
      {children}
    </div>
  )
}

/** Webhook settings past the address (#160); each one left empty is Alertmanager's default. */
function WebhookSettings({ webhook, set, noSecrets }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {noSecrets && <Text type="secondary" style={{ fontSize: 12 }} data-testid="no-secrets-webhook">{NO_SECRETS_WEBHOOK}</Text>}
      <Field label="Authentication">
        <Radio.Group value={webhook.auth} disabled={noSecrets} onChange={e => set({ auth: e.target.value })}
          options={[{ value: 'none', label: 'none' }, { value: 'bearer', label: 'Bearer token' }, { value: 'basic', label: 'User and password' }]} />
      </Field>
      {webhook.auth === 'bearer' && (
        <>
          <Field label="Token, from a Secret">
            <SecretFields label="Token" name={webhook.credName} keyValue={webhook.credKey}
              onName={v => set({ credName: v })} onKey={v => set({ credKey: v })} />
          </Field>
          <Field label="Authorization type">
            <Input aria-label="Authorization type" placeholder="Bearer" value={webhook.authType} style={{ width: 200 }}
              onChange={e => set({ authType: e.target.value })} />
          </Field>
        </>
      )}
      {webhook.auth === 'basic' && (
        <>
          <Field label="User name, from a Secret">
            <SecretFields label="User" name={webhook.userName} keyValue={webhook.userKey}
              onName={v => set({ userName: v })} onKey={v => set({ userKey: v })} />
          </Field>
          <Field label="Password, from a Secret">
            <SecretFields label="Password" name={webhook.passName} keyValue={webhook.passKey}
              onName={v => set({ passName: v })} onKey={v => set({ passKey: v })} />
          </Field>
        </>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="Skip certificate check">
          <Select aria-label="Skip certificate check" value={webhook.insecureSkipVerify} onChange={v => set({ insecureSkipVerify: v })} options={CHOICES} style={{ width: 150 }} />
        </Field>
        <Field label="Send resolved">
          <Select aria-label="Send resolved" value={webhook.sendResolved} onChange={v => set({ sendResolved: v })} options={CHOICES} style={{ width: 150 }} />
        </Field>
      </div>
      {!noSecrets && (
        <Field label="CA certificate, from a Secret">
          <SecretFields label="CA" name={webhook.caName} keyValue={webhook.caKey}
            onName={v => set({ caName: v })} onKey={v => set({ caKey: v })} />
        </Field>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="Timeout (Alertmanager 0.28+)">
          <Input aria-label="Timeout" placeholder="none, e.g. 10s" value={webhook.timeout} style={{ width: 150 }}
            onChange={e => set({ timeout: e.target.value })} />
        </Field>
        <Field label="Max alerts per request">
          <Input aria-label="Max alerts" placeholder="all" value={webhook.maxAlerts} style={{ width: 150 }}
            onChange={e => set({ maxAlerts: e.target.value })} />
        </Field>
      </div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {SECRET_REMINDER} A Secret value that is empty leaves the request without authentication.
      </Text>
    </div>
  )
}

/** E-mail settings past `to` (#159); each one left empty is the platform's. */
function EmailSettings({ email, set, noSecrets }) {
  const setHeader = (i, patch) => set({ headers: email.headers.map((h, j) => (j === i ? { ...h, ...patch } : h)) })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Field label="From">
        <Input aria-label="From" placeholder={PLATFORM} value={email.from} onChange={e => set({ from: e.target.value })} />
      </Field>
      <Field label="SMTP server (host:port)">
        <Input aria-label="SMTP server" placeholder={PLATFORM} value={email.smarthost} onChange={e => set({ smarthost: e.target.value })} />
      </Field>
      {noSecrets ? (
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="no-secrets-email">{NO_SECRETS_EMAIL}</Text>
      ) : (
        <>
          <Field label="SMTP user">
            <Input aria-label="SMTP user" placeholder={PLATFORM} value={email.authUsername} onChange={e => set({ authUsername: e.target.value })} />
          </Field>
          <Field label="SMTP password, from a Secret">
            <SecretFields label="Password" name={email.passwordName} keyValue={email.passwordKey}
              onName={v => set({ passwordName: v })} onKey={v => set({ passwordKey: v })} />
          </Field>
          {/* An identity with a user and password of its own, a secret with a user of its own: else Alertmanager fills in the platform's. */}
          <Field label="SMTP identity (AUTH PLAIN) — with a user and password of its own; usually the user">
            <Input aria-label="SMTP identity" placeholder={PLATFORM} value={email.authIdentity} onChange={e => set({ authIdentity: e.target.value })} />
          </Field>
          <Field label="SMTP secret (CRAM-MD5), from a Secret — with a user of its own">
            <SecretFields label="CRAM-MD5 secret" name={email.cramSecretName} keyValue={email.cramSecretKey}
              onName={v => set({ cramSecretName: v })} onKey={v => set({ cramSecretKey: v })} />
          </Field>
        </>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="Require TLS">
          <Select aria-label="Require TLS" value={email.requireTLS} onChange={v => set({ requireTLS: v })} options={CHOICES} style={{ width: 150 }} />
        </Field>
        <Field label="Skip certificate check">
          <Select aria-label="Skip certificate check" value={email.insecureSkipVerify} onChange={v => set({ insecureSkipVerify: v })} options={CHOICES} style={{ width: 150 }} />
        </Field>
        <Field label="Send resolved">
          <Select aria-label="Send resolved" value={email.sendResolved} onChange={v => set({ sendResolved: v })} options={CHOICES} style={{ width: 150 }} />
        </Field>
      </div>
      {!noSecrets && (
        <Field label="CA certificate, from a Secret">
          <SecretFields label="CA" name={email.caName} keyValue={email.caKey}
            onName={v => set({ caName: v })} onKey={v => set({ caKey: v })} />
        </Field>
      )}
      <Text type="secondary" style={{ fontSize: 12 }}>
        Setting TLS here replaces the platform&apos;s TLS settings for this server. {SECRET_REMINDER}
      </Text>
      <Field label="Headers (Alertmanager templates allowed)">
        {email.headers.map((h, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
            <Input aria-label={`Header ${i + 1} name`} placeholder="Subject" value={h.name} style={{ width: 140 }}
              onChange={e => setHeader(i, { name: e.target.value })} />
            <Input aria-label={`Header ${i + 1} value`} placeholder="{{ .CommonLabels.alertname }}" value={h.value}
              onChange={e => setHeader(i, { value: e.target.value })} />
            <Button type="text" icon={<MinusCircleOutlined />} aria-label={`Remove header ${i + 1}`}
              onClick={() => set({ headers: email.headers.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <Button size="small" type="dashed" icon={<PlusOutlined />} style={{ alignSelf: 'flex-start' }}
          onClick={() => set({ headers: [...email.headers, { name: email.headers.length ? '' : 'Subject', value: '' }] })}>
          New header
        </Button>
      </Field>
      <Field label="Text body">
        <Input.TextArea aria-label="Text body" placeholder="none" autoSize={{ minRows: 2, maxRows: 8 }} value={email.text}
          onChange={e => set({ text: e.target.value })} />
      </Field>
      <Field label="HTML body">
        <Select aria-label="HTML body" value={email.htmlMode} onChange={v => set({ htmlMode: v })} style={{ width: 260 }}
          options={[{ value: 'default', label: 'Alertmanager default' }, { value: 'none', label: 'none (text only)' }, { value: 'custom', label: 'custom' }]} />
        {email.htmlMode === 'custom' && (
          <Input.TextArea aria-label="HTML" autoSize={{ minRows: 2, maxRows: 8 }} value={email.html} style={{ marginTop: 4 }}
            onChange={e => set({ html: e.target.value })} />
        )}
      </Field>
    </div>
  )
}

/** What a config sends to, in one line. */
export function configTarget(config) {
  if (config?.type === 'email') return config.to
  if (config?.urlSecret) return `Secret ${config.urlSecret.name} / ${config.urlSecret.key}`
  return config?.url
}

/**
 * The dialog that adds or edits one config — a deployment's own, or a shared
 * one (#123). `taken(name)` says whether a new name is already used, and
 * `nameLocked` keeps the name of one being edited;
 * `problemsOf(name, config)` is the save's own check of the config.
 */
export function ConfigDialog({ editing, onOk, onCancel, taken, problemsOf = configProblems, warningsOf = configWarnings, note, nameLocked = false, noSecrets = false }) {
  const [form, setFormState] = useState(editing.form)
  const setForm = patch => setFormState(f => ({ ...f, ...patch }))
  const setEmail = patch => setFormState(f => ({ ...f, email: { ...f.email, ...patch } }))
  const setWebhook = patch => setFormState(f => ({ ...f, webhook: { ...f.webhook, ...patch } }))

  const name = form.name.trim()
  const isTaken = name !== editing.was && taken(name)
  const problems = [
    ...(isTaken ? [`${name} is already a config`] : []),
    ...formProblems(form),
    ...problemsOf(name, fromForm(form)).map(dialogProblem),
  ]
  // Worth saying, never in the way: Add stays on.
  const warnings = problems.length ? [] : warningsOf(name, fromForm(form)).map(dialogProblem)
  // Every field filled before the problems are shown: an empty form is not wrong yet.
  const filled = name && (form.type === 'email' ? form.to.trim()
    : form.where === 'url' ? form.url.trim() : form.secretName.trim() && form.secretKey.trim())

  return (
    <Modal open title={editing.was ? `Edit ${editing.was}` : 'Add config'} okText={editing.was ? 'Save' : 'Add'}
      okButtonProps={{ disabled: !filled || problems.length > 0 }}
      onOk={() => onOk(name, fromForm(form))} onCancel={onCancel}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        {note && <Text type="secondary" style={{ fontSize: 12 }} data-testid="config-dialog-note">{note}</Text>}
        <Input aria-label="Config name" placeholder="name, e.g. db-email" value={form.name} disabled={nameLocked}
          onChange={e => setForm({ name: e.target.value })} />
        <Select aria-label="Config type" value={form.type} onChange={type => setForm({ type })}
          options={[{ value: 'webhook', label: 'webhook' }, { value: 'email', label: 'email' }]} />
        {form.type === 'email' ? (
          <>
            <Input aria-label="Email address" placeholder="db@example.com" value={form.to}
              onChange={e => setForm({ to: e.target.value })} />
            <Collapse size="small" items={[{ key: 'more', label: 'More settings', children: <EmailSettings email={form.email} set={setEmail} noSecrets={noSecrets} /> }]} />
          </>
        ) : (
          <>
            <Radio.Group value={form.where} onChange={e => setForm({ where: e.target.value })}
              options={[{ value: 'url', label: 'URL' }, { value: 'secret', label: 'URL in a Secret', disabled: noSecrets }]} />
            {form.where === 'url' ? (
              <Input aria-label="Webhook URL" placeholder="http://alert-relay.monitoring.svc:8080" value={form.url}
                onChange={e => setForm({ url: e.target.value })} />
            ) : (
              <>
                <SecretFields label="URL" name={form.secretName} keyValue={form.secretKey}
                  onName={v => setForm({ secretName: v })} onKey={v => setForm({ secretKey: v })} />
                <Text type="secondary" style={{ fontSize: 12 }}>{SECRET_REMINDER}</Text>
              </>
            )}
            <Collapse size="small" items={[{ key: 'more', label: 'More settings', children: <WebhookSettings webhook={form.webhook} set={setWebhook} noSecrets={noSecrets} /> }]} />
          </>
        )}
        {filled && problems.length > 0 && (
          <Alert type="error" showIcon data-testid="config-problems"
            message={problems.map((p, i) => <div key={i}>{p}</div>)} />
        )}
        {filled && warnings.length > 0 && (
          <Alert type="warning" showIcon data-testid="config-warnings"
            message={warnings.map((p, i) => <div key={i}>{p}</div>)} />
        )}
      </div>
    </Modal>
  )
}


/**
 * The deployment's notification configs (#93): who a cell can notify. Its
 * own are kept in its routing.yaml; one used from the repo's shared configs
 * (#123, `{ shared: true }`) is marked shared and read-only here. One a cell
 * still uses cannot be removed — the cells are listed instead.
 * `shared` is the shared configs ({ configs }), or null while unknown.
 */
export default function NotificationConfigs({ routing, onChange, readOnly, describeMatch, shared = null }) {
  const [editing, setEditing] = useState(null) // { was, form }
  const [adding, setAdding] = useState(false)
  const sharedConfigs = shared?.configs || {}
  // The shared configs could not be read, or have problems of their own.
  const sharedProblem = shared?.error || (shared?.errors?.length ? `${shared.file} has problems: ${shared.errors.join('; ')}` : null)

  const configs = Object.entries(routing.configs || {})

  function save(name, config) {
    onChange(putConfig(routing, name, config, { was: editing.was ?? name }))
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

  // A shared config in place of one of the deployment's own by its name:
  // at once when they say the same, else only once asked.
  function useShared(name) {
    setAdding(false)
    const own = Object.hasOwn(routing.configs, name) ? routing.configs[name] : undefined
    const use = () => onChange(putConfig(routing, name, { shared: true }, { was: name }))
    if (own === undefined || sameConfig(own, sharedConfigs[name])) return use()
    const show = config => <pre style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(config, null, 2)}</pre>
    Modal.confirm({
      title: `This deployment has its own ${name}`,
      width: 640,
      content: (
        <div data-testid="shared-conflict">
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <div style={{ flex: 1 }}><Text strong>This deployment&apos;s</Text>{show(own)}</div>
            <div style={{ flex: 1 }}><Text strong>Shared</Text>{show(sharedConfigs[name])}</div>
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>Every cell notifying {name} then sends to the shared one. To keep both, cancel and rename this deployment&apos;s first.</Text>
        </div>
      ),
      okText: 'Replace with the shared one',
      onOk: use,
    })
  }

  const addable = Object.keys(sharedConfigs).filter(n => !(Object.hasOwn(routing.configs, n) && routing.configs[n]?.shared === true))

  return (
    <div data-testid="notification-configs">
      {sharedProblem && <Alert type="error" showIcon data-testid="shared-read-error" style={{ marginBottom: 8 }} message={`Shared configs: ${sharedProblem}`} />}
      <Table
        size="small"
        pagination={false}
        rowKey="name"
        dataSource={configs.map(([n, c]) => ({ name: n, config: c }))}
        locale={{ emptyText: 'No one to notify yet — add a config' }}
        columns={[
          {
            title: 'Name', dataIndex: 'name', width: 220,
            render: (n, r) => (r.config?.shared === true ? <span>{n} <Tag color="blue" data-testid={`shared-tag-${n}`}>shared</Tag></span> : n),
          },
          { title: 'Type', render: (_, r) => (r.config?.shared === true ? sharedConfigs[r.name]?.type : r.config?.type), width: 90 },
          {
            title: 'Sends to',
            render: (_, r) => {
              if (r.config?.shared !== true) return <Text style={{ fontSize: 13 }}>{configTarget(r.config)}</Text>
              const s = sharedConfigs[r.name]
              return s ? <Text style={{ fontSize: 13 }}>{configTarget(s)}</Text>
                : <Text type="danger" style={{ fontSize: 13 }}>{sharedProblem ? 'the shared configs cannot be read' : shared ? 'no shared config of this name' : '…'}</Text>
            },
          },
          {
            title: '', width: 150,
            render: (_, r) => (
              <span style={{ whiteSpace: 'nowrap' }}>
                {r.config?.shared === true ? (
                  <Button type="link" size="small" disabled={readOnly || !sharedConfigs[r.name]}
                    onClick={() => onChange(putConfig(routing, r.name, sharedConfigs[r.name], { was: r.name }))}>
                    Make local copy
                  </Button>
                ) : (
                  <Button type="text" size="small" icon={<EditOutlined />} aria-label={`Edit ${r.name}`} disabled={readOnly}
                    onClick={() => setEditing({ was: r.name, form: toForm(r.name, r.config) })} />
                )}
                <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`Delete ${r.name}`} disabled={readOnly}
                  onClick={() => remove(r.name)} />
              </span>
            ),
          },
        ]}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <Button type="dashed" size="small" icon={<PlusOutlined />} disabled={readOnly}
          onClick={() => setEditing({ was: undefined, form: { ...blank } })}>
          Add config
        </Button>
        {adding ? (
          <Select size="small" autoFocus defaultOpen aria-label="Shared config" placeholder="shared config" style={{ width: 220 }}
            options={addable.map(n => ({ value: n, label: `${n} — ${configTarget(sharedConfigs[n])}` }))}
            onChange={useShared} onBlur={() => setAdding(false)} />
        ) : (
          <Button type="dashed" size="small" icon={<PlusOutlined />} disabled={readOnly || !addable.length}
            onClick={() => setAdding(true)}>
            Add from shared
          </Button>
        )}
      </div>

      {editing && (
        <ConfigDialog editing={editing} onOk={save} onCancel={() => setEditing(null)}
          taken={name => Object.hasOwn(routing.configs, name)} />
      )}
    </div>
  )
}
