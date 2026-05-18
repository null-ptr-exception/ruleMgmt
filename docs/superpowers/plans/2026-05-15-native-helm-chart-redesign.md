# Native Helm Chart Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom template metadata system (`_meta` in values.yaml, custom `vars` arrays) with standard Helm chart structure (`values.schema.json`, proper `Chart.yaml`, native `values.yaml` defaults).

**Architecture:** The V2 API routes (`server/routes/charts.js`, `templates.js`, `deployments.js`, `render.js`) are rewritten to read/write `values.schema.json` instead of `_meta`. The frontend TemplateDevEditor gets fixed fields (name, description, expr) + a schema-aware variables panel + template file tabs. AlertUserView drops the template tree and drives the table directly from JSON Schema. A new sample chart demonstrates the format.

**Tech Stack:** Express.js backend, React 18 + Ant Design frontend, Helm CLI for rendering, JSON Schema for variable definitions.

---

## File Structure

### Server (modify existing)
- `server/routes/charts.js` — Add `values.schema.json` creation on chart create, read schema in list
- `server/routes/templates.js` — Replace `_meta` read/write with `values.schema.json` read/write; add chart-level schema endpoint
- `server/routes/deployments.js` — Count instances from `instances` array instead of multi-key sum
- `server/routes/render.js` — No changes needed (already runs `helm template`)

### Frontend (modify existing)
- `src/utils/chartApi.js` — Add `getChartSchema()`, `saveChartSchema()`, `saveChartValues()` API functions
- `src/components/VariablesPanel.jsx` — Rewrite to read/write JSON Schema format; add raw JSON toggle
- `src/components/AlertTable.jsx` — Drive columns from JSON Schema `properties` instead of custom `vars` array
- `src/pages/TemplateDevEditor.jsx` — Add fixed fields form (name, desc, expr), default values tab, template file dropdown
- `src/pages/AlertUserView.jsx` — Remove template tree; load schema for table columns; add preview button

### Frontend (create new)
- `src/utils/schemaUtils.js` — Helpers to convert JSON Schema ↔ form-friendly structures

### Sample data (create new)
- `sample/charts/tablespace-usage/` — Chart.yaml, values.yaml, values.schema.json, templates/prometheus-rule.yaml

---

### Task 1: Schema Utility Helpers

**Files:**
- Create: `src/utils/schemaUtils.js`
- Create: `src/utils/__tests__/schemaUtils.test.js`

- [ ] **Step 1: Write tests for schema ↔ vars conversion**

```js
// src/utils/__tests__/schemaUtils.test.js
import { describe, it, expect } from 'vitest'
import { schemaToVars, varsToSchema } from '../schemaUtils.js'

describe('schemaToVars', () => {
  it('converts JSON Schema properties to vars array', () => {
    const schema = {
      type: 'object',
      properties: {
        instances: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              db_name: { type: 'string', description: 'Database name' },
              threshold: { type: 'number', description: 'Alert threshold', default: 80 }
            },
            required: ['db_name']
          }
        }
      }
    }
    const vars = schemaToVars(schema)
    expect(vars).toEqual([
      { name: 'db_name', type: 'string', description: 'Database name', required: true },
      { name: 'threshold', type: 'number', description: 'Alert threshold', default: 80, required: false }
    ])
  })

  it('handles enum as list type', () => {
    const schema = {
      type: 'object',
      properties: {
        instances: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['warning', 'critical'], description: 'Level' }
            }
          }
        }
      }
    }
    const vars = schemaToVars(schema)
    expect(vars).toEqual([
      { name: 'severity', type: 'string', description: 'Level', required: false, enum: ['warning', 'critical'] }
    ])
  })

  it('returns empty array for empty schema', () => {
    expect(schemaToVars({})).toEqual([])
    expect(schemaToVars(null)).toEqual([])
  })
})

describe('varsToSchema', () => {
  it('converts vars array to JSON Schema', () => {
    const vars = [
      { name: 'db_name', type: 'string', description: 'Database name', required: true },
      { name: 'threshold', type: 'number', description: 'Alert threshold', default: 80, required: false }
    ]
    const schema = varsToSchema(vars)
    expect(schema).toEqual({
      $schema: 'https://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        instances: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              db_name: { type: 'string', description: 'Database name' },
              threshold: { type: 'number', description: 'Alert threshold', default: 80 }
            },
            required: ['db_name']
          }
        }
      }
    })
  })

  it('includes enum in schema', () => {
    const vars = [
      { name: 'severity', type: 'string', description: 'Level', enum: ['warning', 'critical'] }
    ]
    const schema = varsToSchema(vars)
    const props = schema.properties.instances.items.properties
    expect(props.severity).toEqual({ type: 'string', description: 'Level', enum: ['warning', 'critical'] })
  })

  it('returns empty schema for empty vars', () => {
    const schema = varsToSchema([])
    expect(schema.properties.instances.items.properties).toEqual({})
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/__tests__/schemaUtils.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Error' /tmp/test-output.log`
Expected: FAIL — module not found

- [ ] **Step 3: Implement schemaUtils.js**

```js
// src/utils/schemaUtils.js

export function schemaToVars(schema) {
  if (!schema?.properties?.instances?.items?.properties) return []
  const items = schema.properties.instances.items
  const props = items.properties
  const required = new Set(items.required || [])
  return Object.entries(props).map(([name, prop]) => {
    const v = { name, type: prop.type || 'string', description: prop.description || '', required: required.has(name) }
    if (prop.default !== undefined) v.default = prop.default
    if (prop.enum) v.enum = prop.enum
    return v
  })
}

export function varsToSchema(vars) {
  const properties = {}
  const required = []
  for (const v of vars) {
    const prop = { type: v.type || 'string' }
    if (v.description) prop.description = v.description
    if (v.default !== undefined) prop.default = v.default
    if (v.enum) prop.enum = v.enum
    properties[v.name] = prop
    if (v.required) required.push(v.name)
  }
  return {
    $schema: 'https://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      instances: {
        type: 'array',
        items: {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {})
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/__tests__/schemaUtils.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL' /tmp/test-output.log`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/schemaUtils.js src/utils/__tests__/schemaUtils.test.js
git commit -m "feat: add schemaUtils for JSON Schema <-> vars conversion"
```

---

### Task 2: Server — Chart Routes with values.schema.json

**Files:**
- Modify: `server/routes/charts.js`

- [ ] **Step 1: Update chart creation to write values.schema.json and instances-based values.yaml**

Replace the full content of `server/routes/charts.js` with:

```js
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function chartsRouter(gitopsDir) {
  const router = express.Router()
  const chartsDir = path.join(gitopsDir, 'charts')

  router.get('/', async (req, res) => {
    try {
      await fs.mkdir(chartsDir, { recursive: true })
      const entries = await fs.readdir(chartsDir, { withFileTypes: true })
      const charts = []
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const tmplDir = path.join(chartsDir, e.name, 'templates')
        let templateCount = 0
        try {
          const files = await fs.readdir(tmplDir)
          templateCount = files.filter(f => f.endsWith('.yaml')).length
        } catch { /* no templates dir */ }
        charts.push({ name: e.name, templateCount })
      }
      res.json(charts)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/', async (req, res) => {
    const { name } = req.body
    if (!name || !NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Invalid chart name. Must match ^[a-z0-9][a-z0-9_-]*$' })
    }
    const chartDir = path.join(chartsDir, name)
    try {
      await fs.mkdir(path.join(chartDir, 'templates'), { recursive: true })
      await fs.writeFile(
        path.join(chartDir, 'Chart.yaml'),
        yaml.dump({ apiVersion: 'v2', name, version: '0.1.0', type: 'application' }),
        'utf-8'
      )
      await fs.writeFile(
        path.join(chartDir, 'values.yaml'),
        yaml.dump({ instances: [] }),
        'utf-8'
      )
      const emptySchema = {
        $schema: 'https://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          instances: {
            type: 'array',
            items: { type: 'object', properties: {} }
          }
        }
      }
      await fs.writeFile(
        path.join(chartDir, 'values.schema.json'),
        JSON.stringify(emptySchema, null, 2),
        'utf-8'
      )
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.delete('/:name', async (req, res) => {
    if (!NAME_RE.test(req.params.name)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    const chartDir = path.join(chartsDir, req.params.name)
    try {
      await fs.rm(chartDir, { recursive: true, force: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
```

- [ ] **Step 2: Verify build**

Run: `npx vite build > /tmp/vite-build.log 2>&1; tail -3 /tmp/vite-build.log`
Expected: `✓ built in ...`

- [ ] **Step 3: Commit**

```bash
git add server/routes/charts.js
git commit -m "feat: chart creation writes values.schema.json + instances-based values.yaml"
```

---

### Task 3: Server — Template Routes with Schema Support

**Files:**
- Modify: `server/routes/templates.js`

- [ ] **Step 1: Rewrite templates.js to use values.schema.json instead of _meta**

Replace the full content of `server/routes/templates.js` with:

```js
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function templatesRouter(gitopsDir) {
  const router = express.Router()
  const chartsDir = path.join(gitopsDir, 'charts')

  router.use('/:chart', (req, res, next) => {
    if (!NAME_RE.test(req.params.chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    next()
  })

  function chartPaths(chart) {
    const chartDir = path.join(chartsDir, chart)
    return {
      chartDir,
      tmplDir: path.join(chartDir, 'templates'),
      valuesFile: path.join(chartDir, 'values.yaml'),
      schemaFile: path.join(chartDir, 'values.schema.json'),
      chartYamlFile: path.join(chartDir, 'Chart.yaml'),
    }
  }

  async function readSchema(schemaFile) {
    try {
      const raw = await fs.readFile(schemaFile, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  // Get chart-level info: schema + values + Chart.yaml metadata
  router.get('/:chart', async (req, res) => {
    const { tmplDir, valuesFile, schemaFile, chartYamlFile } = chartPaths(req.params.chart)
    try {
      let templateFiles = []
      try {
        const files = await fs.readdir(tmplDir)
        templateFiles = files.filter(f => f.endsWith('.yaml')).map(f => f.replace(/\.yaml$/, ''))
      } catch { /* no templates dir */ }

      const schema = await readSchema(schemaFile)

      let values = { instances: [] }
      try {
        const raw = await fs.readFile(valuesFile, 'utf-8')
        values = yaml.load(raw) || { instances: [] }
      } catch { /* use default */ }

      let chartMeta = {}
      try {
        const raw = await fs.readFile(chartYamlFile, 'utf-8')
        chartMeta = yaml.load(raw) || {}
      } catch { /* use default */ }

      res.json({ templateFiles, schema, values, chartMeta })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Get a single template file's content
  router.get('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    try {
      const content = await fs.readFile(tmplFile, 'utf-8')
      res.json({ content })
    } catch {
      res.status(404).json({ error: 'Template not found' })
    }
  })

  // Save a template file's content
  router.post('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    const { content } = req.body
    try {
      await fs.mkdir(tmplDir, { recursive: true })
      await fs.writeFile(tmplFile, content, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Save chart-level schema
  router.post('/:chart/schema', async (req, res) => {
    const { schemaFile } = chartPaths(req.params.chart)
    const { schema } = req.body
    try {
      await fs.writeFile(schemaFile, JSON.stringify(schema, null, 2), 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Save chart-level default values
  router.post('/:chart/values', async (req, res) => {
    const { valuesFile } = chartPaths(req.params.chart)
    const { values } = req.body
    try {
      const content = typeof values === 'string' ? values : yaml.dump(values, { lineWidth: -1 })
      await fs.writeFile(valuesFile, content, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Save Chart.yaml metadata (name, description, version)
  router.post('/:chart/chart-meta', async (req, res) => {
    const { chartYamlFile } = chartPaths(req.params.chart)
    const { chartMeta } = req.body
    try {
      await fs.writeFile(chartYamlFile, yaml.dump(chartMeta, { lineWidth: -1 }), 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Delete a template file
  router.delete('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    try {
      await fs.rm(tmplFile, { force: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Rename a template file
  router.post('/:chart/:template/rename', async (req, res) => {
    const { tmplDir } = chartPaths(req.params.chart)
    const { newName } = req.body
    if (!newName || !NAME_RE.test(newName)) {
      return res.status(400).json({ error: 'Invalid newName' })
    }
    const oldFile = path.join(tmplDir, `${req.params.template}.yaml`)
    const newFile = path.join(tmplDir, `${newName}.yaml`)
    try {
      await fs.rename(oldFile, newFile)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
```

- [ ] **Step 2: Verify build**

Run: `npx vite build > /tmp/vite-build.log 2>&1; tail -3 /tmp/vite-build.log`
Expected: `✓ built in ...`

- [ ] **Step 3: Commit**

```bash
git add server/routes/templates.js
git commit -m "feat: template routes use values.schema.json instead of _meta"
```

---

### Task 4: Server — Deployment Routes for Instances Array

**Files:**
- Modify: `server/routes/deployments.js`

- [ ] **Step 1: Update alert count to read from instances array**

In `server/routes/deployments.js`, replace the alert count logic in the list endpoint. Change lines 30-36:

```js
        // old: count all array values across keys
        for (const [key, value] of Object.entries(parsed)) {
            if (key === '_meta') continue
            if (Array.isArray(value)) alertCount += value.length
          }
```

to:

```js
        const instances = parsed.instances
        if (Array.isArray(instances)) alertCount = instances.length
```

- [ ] **Step 2: Verify build**

Run: `npx vite build > /tmp/vite-build.log 2>&1; tail -3 /tmp/vite-build.log`
Expected: `✓ built in ...`

- [ ] **Step 3: Commit**

```bash
git add server/routes/deployments.js
git commit -m "feat: deployment alert count reads instances array"
```

---

### Task 5: Frontend — chartApi.js Schema Endpoints

**Files:**
- Modify: `src/utils/chartApi.js`

- [ ] **Step 1: Add schema, values, and chart-meta API functions**

Append to `src/utils/chartApi.js` before the Deployments section:

```js
export async function getChartInfo(chart) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}`)
  if (!res.ok) return {}
  return res.json()
}

export async function getChartTemplateFile(chart, template) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/${encodeURIComponent(template)}`)
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartTemplateFile(chart, template, content) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/${encodeURIComponent(template)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartSchema(chart, schema) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartValues(chart, values) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/values`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function saveChartMeta(chart, chartMeta) {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(chart)}/chart-meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chartMeta })
  })
  if (!res.ok) return {}
  return res.json()
}
```

Also remove the old `listChartTemplates`, `getChartTemplate`, and `saveChartTemplate` functions (lines 31-59) since they are replaced by the new functions above.

- [ ] **Step 2: Verify build**

Run: `npx vite build > /tmp/vite-build.log 2>&1; tail -3 /tmp/vite-build.log`
Expected: `✓ built in ...`

- [ ] **Step 3: Commit**

```bash
git add src/utils/chartApi.js
git commit -m "feat: chartApi adds schema, values, chart-meta endpoints"
```

---

### Task 6: Frontend — VariablesPanel with JSON Schema + Raw Toggle

**Files:**
- Modify: `src/components/VariablesPanel.jsx`

- [ ] **Step 1: Rewrite VariablesPanel to use JSON Schema format with raw toggle**

Replace the full content of `src/components/VariablesPanel.jsx` with:

```jsx
import { useState, useRef, useEffect } from 'react'
import { Button, Input, Select, Checkbox, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

const { Text } = Typography

const TYPE_OPTIONS = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'integer', label: 'integer' },
  { value: 'boolean', label: 'boolean' },
]

export default function VariablesPanel({ vars, onChange, schema, onSchemaChange }) {
  const [rawMode, setRawMode] = useState(false)
  const [rawText, setRawText] = useState('')
  const rawRef = useRef(null)

  useEffect(() => {
    if (rawMode && schema) {
      setRawText(JSON.stringify(schema, null, 2))
    }
  }, [rawMode, schema])

  function handleRawSave() {
    try {
      const parsed = JSON.parse(rawText)
      onSchemaChange(parsed)
    } catch { /* invalid JSON, ignore */ }
  }

  function updateVar(index, field, value) {
    const updated = vars.map((v, i) => i === index ? { ...v, [field]: value } : v)
    onChange(updated)
  }

  function addVar() {
    onChange([...vars, { name: '', type: 'string', description: '', required: false }])
  }

  function removeVar(index) {
    onChange(vars.filter((_, i) => i !== index))
  }

  if (rawMode) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderLeft: '1px solid #f0f0f0' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8c8c8c' }}>
            values.schema.json
          </Text>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="small" type="primary" onClick={handleRawSave}>Apply</Button>
            <Button size="small" onClick={() => setRawMode(false)}>Visual</Button>
          </div>
        </div>
        <textarea
          ref={rawRef}
          value={rawText}
          onChange={e => setRawText(e.target.value)}
          style={{
            flex: 1, fontFamily: 'monospace', fontSize: 12, padding: 12,
            border: 'none', outline: 'none', resize: 'none', background: '#fafafa'
          }}
        />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderLeft: '1px solid #f0f0f0' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8c8c8c' }}>
          Variables
        </Text>
        <Button size="small" onClick={() => setRawMode(true)}>Raw</Button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {vars.map((v, i) => (
          <div key={i} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Input size="small" placeholder="name" value={v.name}
                onChange={e => updateVar(i, 'name', e.target.value)} style={{ flex: 1, fontWeight: 600 }} />
              <Select size="small" value={v.type} options={TYPE_OPTIONS} style={{ width: 90 }}
                onChange={val => updateVar(i, 'type', val)} />
              <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeVar(i)} />
            </div>
            <Input size="small" placeholder="description" value={v.description || ''}
              onChange={e => updateVar(i, 'description', e.target.value)} style={{ marginBottom: 6 }} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Input size="small" placeholder="default" value={v.default ?? ''}
                onChange={e => updateVar(i, 'default', e.target.value)} style={{ flex: 1 }} />
              <Checkbox checked={!!v.required} onChange={e => updateVar(i, 'required', e.target.checked)}>
                <Text style={{ fontSize: 11 }}>Required</Text>
              </Checkbox>
            </div>
            {v.type === 'string' && (
              <Input size="small" placeholder="enum values (comma-separated)" value={(v.enum || []).join(', ')}
                onChange={e => {
                  const val = e.target.value
                  const enumVals = val ? val.split(',').map(s => s.trim()).filter(Boolean) : undefined
                  updateVar(i, 'enum', enumVals?.length ? enumVals : undefined)
                }}
                style={{ marginTop: 6 }} />
            )}
          </div>
        ))}
        <Button type="dashed" block icon={<PlusOutlined />} onClick={addVar}>Add variable</Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npx vite build > /tmp/vite-build.log 2>&1; tail -3 /tmp/vite-build.log`
Expected: `✓ built in ...`

- [ ] **Step 3: Commit**

```bash
git add src/components/VariablesPanel.jsx
git commit -m "feat: VariablesPanel reads/writes JSON Schema with raw toggle"
```

---

### Task 7: Frontend — TemplateDevEditor Redesign

**Files:**
- Modify: `src/pages/TemplateDevEditor.jsx`

- [ ] **Step 1: Rewrite TemplateDevEditor with fixed fields, template file tabs, and schema-based vars**

Replace the full content of `src/pages/TemplateDevEditor.jsx`. The new editor has:
- Top bar: chart name (from Chart.yaml), description input, save/delete buttons
- Left side: CodeMirror for the active template file, with a dropdown to switch files and an add button
- Right side: VariablesPanel (edits values.schema.json via schemaToVars/varsToSchema)
- Fixed fields section above CodeMirror: alert name pattern, description template, expr template
- These fixed fields auto-generate the Helm template when changed

```jsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { Layout, Button, Input, Select, Empty, Typography, Tabs } from 'antd'
import { SaveOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import ChartSelector from '../components/ChartSelector'
import VariablesPanel from '../components/VariablesPanel'
import { schemaToVars, varsToSchema } from '../utils/schemaUtils'
import {
  listCharts, createChart, deleteChart,
  getChartInfo, saveChartTemplateFile, saveChartSchema, saveChartMeta,
  deleteChartTemplate
} from '../utils/chartApi'

const { Sider, Content } = Layout
const { Text, Title } = Typography

function generateHelmTemplate(alertName, description, expr, vars) {
  const varNames = vars.map(v => v.name)
  const hasVars = varNames.length > 0

  let rulesBlock = ''
  if (hasVars) {
    const labelLines = varNames
      .filter(v => !['severity', 'for'].includes(v))
      .map(v => `            ${v}: {{ $inst.${v} | quote }}`)
      .join('\n')

    rulesBlock = `        {{- range .Values.instances }}
        {{- $inst := . }}
        - alert: ${alertName || '{{ $inst.name }}'}
          expr: ${expr || 'up == 0'}
          for: {{ $inst.for | default "5m" }}
          labels:
            severity: {{ $inst.severity | default "warning" }}
${labelLines ? labelLines + '\n' : ''}          annotations:
            description: ${description || '{{ $inst.name }} alert fired'}
            summary: ${alertName || '{{ $inst.name }}'}
        {{- end }}`
  } else {
    rulesBlock = `        - alert: ${alertName || 'ExampleAlert'}
          expr: ${expr || 'up == 0'}
          for: 5m
          labels:
            severity: warning
          annotations:
            description: ${description || 'Alert fired'}
            summary: ${alertName || 'ExampleAlert'}`
  }

  return `apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ .Release.Name }}-rules
  labels:
    app.kubernetes.io/managed-by: Helm
spec:
  groups:
    - name: {{ .Release.Name }}
      rules:
${rulesBlock}
`
}

export default function TemplateDevEditor() {
  const [charts, setCharts] = useState([])
  const [activeChart, setActiveChart] = useState(null)
  const [chartMeta, setChartMeta] = useState({})
  const [templateFiles, setTemplateFiles] = useState([])
  const [activeFile, setActiveFile] = useState(null)
  const [fileContent, setFileContent] = useState('')
  const [schema, setSchema] = useState(null)
  const [vars, setVars] = useState([])
  const [dirty, setDirty] = useState(false)
  const [alertName, setAlertName] = useState('')
  const [description, setDescription] = useState('')
  const [expr, setExpr] = useState('')
  const editorRef = useRef(null)
  const viewRef = useRef(null)

  const loadCharts = useCallback(async () => {
    const c = await listCharts()
    setCharts(c)
  }, [])

  useEffect(() => { loadCharts() }, [loadCharts])

  const loadChart = useCallback(async (chart) => {
    const info = await getChartInfo(chart)
    setChartMeta(info.chartMeta || {})
    setTemplateFiles(info.templateFiles || [])
    setSchema(info.schema)
    setVars(schemaToVars(info.schema))
    setDirty(false)
    if (info.templateFiles?.length > 0) {
      setActiveFile(info.templateFiles[0])
    } else {
      setActiveFile(null)
      setFileContent('')
    }
  }, [])

  useEffect(() => {
    if (activeChart) loadChart(activeChart)
  }, [activeChart, loadChart])

  useEffect(() => {
    if (!activeChart || !activeFile) return
    (async () => {
      const { getChartTemplateFile } = await import('../utils/chartApi')
      const data = await getChartTemplateFile(activeChart, activeFile)
      setFileContent(data.content || '')
      if (viewRef.current && editorRef.current) {
        const { EditorView } = await import('codemirror')
        viewRef.current.dispatch({
          changes: { from: 0, to: viewRef.current.state.doc.length, insert: data.content || '' }
        })
      }
    })()
  }, [activeChart, activeFile])

  useEffect(() => {
    if (!editorRef.current) return
    let mounted = true
    ;(async () => {
      const { EditorView, keymap, lineNumbers, highlightActiveLine } = await import('@codemirror/view')
      const { EditorState } = await import('@codemirror/state')
      const { defaultKeymap, history, historyKeymap } = await import('@codemirror/commands')
      const { StreamLanguage } = await import('@codemirror/language')
      const { yaml: yamlMode } = await import('@codemirror/legacy-modes/mode/yaml')
      if (!mounted || !editorRef.current) return
      const state = EditorState.create({
        doc: fileContent,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          StreamLanguage.define(yamlMode),
          EditorView.updateListener.of(update => {
            if (update.docChanged) {
              setFileContent(update.state.doc.toString())
              setDirty(true)
            }
          }),
        ],
      })
      if (editorRef.current.children.length) editorRef.current.innerHTML = ''
      viewRef.current = new EditorView({ state, parent: editorRef.current })
    })()
    return () => { mounted = false; viewRef.current?.destroy() }
  }, [activeChart, activeFile])

  async function handleSave() {
    if (!activeChart) return
    const newSchema = varsToSchema(vars)
    await saveChartSchema(activeChart, newSchema)
    await saveChartMeta(activeChart, chartMeta)
    if (activeFile) {
      await saveChartTemplateFile(activeChart, activeFile, fileContent)
    }
    setSchema(newSchema)
    setDirty(false)
  }

  async function handleCreateChart(name) {
    await createChart(name)
    await loadCharts()
    setActiveChart(name)
  }

  async function handleDelete() {
    if (!activeChart) return
    await deleteChart(activeChart)
    setActiveChart(null)
    await loadCharts()
  }

  async function handleAddFile() {
    const name = prompt('Template file name (without .yaml):')
    if (!name || !activeChart) return
    const content = generateHelmTemplate(alertName, description, expr, vars)
    await saveChartTemplateFile(activeChart, name, content)
    setTemplateFiles([...templateFiles, name])
    setActiveFile(name)
  }

  function handleGenerateTemplate() {
    const content = generateHelmTemplate(alertName, description, expr, vars)
    setFileContent(content)
    setDirty(true)
    if (viewRef.current) {
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: content }
      })
    }
  }

  function handleVarsChange(newVars) {
    setVars(newVars)
    setDirty(true)
  }

  function handleSchemaChange(newSchema) {
    setSchema(newSchema)
    setVars(schemaToVars(newSchema))
    setDirty(true)
  }

  return (
    <Layout style={{ height: '100%' }}>
      <Sider width={260} theme="light" style={{ borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ChartSelector charts={charts} activeChart={activeChart} onSelect={setActiveChart} onCreate={handleCreateChart} />
      </Sider>
      <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {activeChart ? (
          <>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Title level={5} style={{ margin: 0 }}>{chartMeta.name || activeChart}</Title>
              <Input size="small" placeholder="Description" value={chartMeta.description || ''}
                onChange={e => { setChartMeta({ ...chartMeta, description: e.target.value }); setDirty(true) }}
                style={{ flex: 1, maxWidth: 400 }} />
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
                <Button danger icon={<DeleteOutlined />} onClick={handleDelete}>Delete</Button>
              </div>
            </div>

            <div style={{ padding: '10px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', gap: 12, alignItems: 'flex-end', background: '#fafafa' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Alert name pattern</Text>
                <Input size="small" placeholder='e.g. tablespace-{{ $severity }}-{{ $inst.db_name }}' value={alertName}
                  onChange={e => setAlertName(e.target.value)} style={{ width: 300, fontFamily: 'monospace', fontSize: 12 }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Expr template</Text>
                <Input size="small" placeholder='e.g. tablespace_usage{db="{{ $inst.db_name }}"} > {{ $inst.threshold }}' value={expr}
                  onChange={e => setExpr(e.target.value)} style={{ width: 400, fontFamily: 'monospace', fontSize: 12 }} />
              </div>
              <Button size="small" onClick={handleGenerateTemplate}>Generate template</Button>
            </div>

            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '8px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 8, background: '#fafafa' }}>
                  <Text style={{ fontSize: 11, fontWeight: 600, color: '#8c8c8c', textTransform: 'uppercase' }}>Template file:</Text>
                  {templateFiles.length > 0 ? (
                    <Select size="small" value={activeFile} onChange={setActiveFile} style={{ width: 200 }}
                      options={templateFiles.map(f => ({ value: f, label: `${f}.yaml` }))} />
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>No template files</Text>
                  )}
                  <Button size="small" icon={<PlusOutlined />} onClick={handleAddFile}>Add file</Button>
                </div>
                <div ref={editorRef} style={{ flex: 1, overflow: 'auto' }}>
                  <style>{`#template-dev-cm .cm-editor { height: 100%; }`}</style>
                </div>
              </div>
              <div style={{ width: 320, flexShrink: 0 }}>
                <VariablesPanel vars={vars} onChange={handleVarsChange} schema={schema} onSchemaChange={handleSchemaChange} />
              </div>
            </div>

            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fafafa' }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
              {dirty && <Text type="warning" style={{ fontSize: 12 }}>Unsaved changes</Text>}
            </div>
          </>
        ) : (
          <Empty style={{ margin: 'auto' }} description="Select a chart from the sidebar or create a new one." />
        )}
      </Content>
    </Layout>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npx vite build > /tmp/vite-build.log 2>&1; tail -3 /tmp/vite-build.log`
Expected: `✓ built in ...`

- [ ] **Step 3: Commit**

```bash
git add src/pages/TemplateDevEditor.jsx
git commit -m "feat: TemplateDevEditor with fixed fields, template tabs, schema-based vars"
```

---

### Task 8: Frontend — AlertTable Driven by JSON Schema

**Files:**
- Modify: `src/components/AlertTable.jsx`

- [ ] **Step 1: Update AlertTable to accept JSON Schema vars format**

Replace the full content of `src/components/AlertTable.jsx` with:

```jsx
import { useCallback } from 'react'
import { Table, Button, Input, InputNumber, Select, Checkbox } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

export default function AlertTable({ vars = [], rows = [], onUpdate, onDelete, onAdd }) {
  const handleCellChange = useCallback((rowIdx, varName, value) => {
    const updated = rows.map((r, i) =>
      i === rowIdx ? { ...r, [varName]: value } : r
    )
    onUpdate(updated)
  }, [rows, onUpdate])

  const handleAdd = useCallback(() => {
    const newRow = {}
    vars.forEach(v => {
      if (v.default !== undefined) newRow[v.name] = v.default
      else if (v.type === 'boolean') newRow[v.name] = false
      else if (v.type === 'number' || v.type === 'integer') newRow[v.name] = 0
      else newRow[v.name] = ''
    })
    onAdd(newRow)
  }, [vars, onAdd])

  const renderInput = (v, row, rowIdx) => {
    const val = row[v.name]
    if (v.type === 'boolean') {
      return (
        <Checkbox
          checked={!!val}
          onChange={e => handleCellChange(rowIdx, v.name, e.target.checked)}
        />
      )
    }
    if (v.type === 'number' || v.type === 'integer') {
      return (
        <InputNumber
          size="small"
          step={v.type === 'integer' ? 1 : 'any'}
          value={val ?? ''}
          onChange={value => handleCellChange(rowIdx, v.name, value)}
          style={{ width: '100%' }}
        />
      )
    }
    if (v.enum) {
      return (
        <Select
          size="small"
          value={val ?? ''}
          onChange={value => handleCellChange(rowIdx, v.name, value)}
          style={{ width: '100%' }}
          options={v.enum.map(opt => ({ value: opt, label: opt }))}
        />
      )
    }
    return (
      <Input
        size="small"
        value={val ?? ''}
        onChange={e => handleCellChange(rowIdx, v.name, e.target.value)}
      />
    )
  }

  const columns = [
    ...vars.map(v => ({
      title: v.name,
      dataIndex: v.name,
      key: v.name,
      render: (_, row, rowIdx) => renderInput(v, row, rowIdx),
    })),
    {
      title: '',
      key: 'actions',
      width: 50,
      render: (_, __, rowIdx) => (
        <Button type="text" danger size="small" icon={<DeleteOutlined />}
          onClick={() => onDelete(rowIdx)} />
      )
    }
  ]

  return (
    <div>
      <Table
        dataSource={rows.map((r, i) => ({ ...r, key: i }))}
        columns={columns}
        pagination={false}
        size="small"
        bordered
      />
      <Button type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 8 }}
        onClick={handleAdd}>
        Add instance
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npx vite build > /tmp/vite-build.log 2>&1; tail -3 /tmp/vite-build.log`
Expected: `✓ built in ...`

- [ ] **Step 3: Commit**

```bash
git add src/components/AlertTable.jsx
git commit -m "feat: AlertTable driven by JSON Schema vars with enum support"
```

---

### Task 9: Frontend — AlertUserView Without Template Tree

**Files:**
- Modify: `src/pages/AlertUserView.jsx`

- [ ] **Step 1: Rewrite AlertUserView to remove template tree, read schema, add preview**

Replace the full content of `src/pages/AlertUserView.jsx` with:

```jsx
import { useState, useEffect, useCallback } from 'react'
import { Layout, Button, Modal, Typography, Empty } from 'antd'
import { SaveOutlined, EyeOutlined } from '@ant-design/icons'
import ChartSelector from '../components/ChartSelector'
import DeploymentSelector from '../components/DeploymentSelector'
import AlertTable from '../components/AlertTable'
import { schemaToVars } from '../utils/schemaUtils'
import {
  listCharts, createChart,
  getChartInfo,
  listDeployments, getDeployment, saveDeployment, cloneDeployment,
  renderDeployment
} from '../utils/chartApi'

const { Sider, Content } = Layout
const { Title, Text } = Typography

export default function AlertUserView() {
  const [charts, setCharts] = useState([])
  const [activeChart, setActiveChart] = useState(null)
  const [deployments, setDeployments] = useState([])
  const [activeDeployment, setActiveDeployment] = useState(null)
  const [vars, setVars] = useState([])
  const [rows, setRows] = useState([])
  const [dirty, setDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewYaml, setPreviewYaml] = useState('')
  const [chartDescription, setChartDescription] = useState('')

  useEffect(() => {
    listCharts().then(c => {
      setCharts(c)
      if (c.length > 0) setActiveChart(c[0].name)
    })
  }, [])

  useEffect(() => {
    if (!activeChart) return
    setActiveDeployment(null)
    setRows([])
    setDirty(false)
    Promise.all([
      getChartInfo(activeChart),
      listDeployments(activeChart)
    ]).then(([info, deps]) => {
      setVars(schemaToVars(info.schema))
      setChartDescription(info.chartMeta?.description || '')
      setDeployments(deps)
    })
  }, [activeChart])

  useEffect(() => {
    if (!activeChart || !activeDeployment) return
    getDeployment(activeChart, activeDeployment).then(data => {
      const parsed = data.parsed || {}
      setRows(parsed.instances || [])
      setDirty(false)
    })
  }, [activeChart, activeDeployment])

  async function handleSave() {
    if (!activeChart || !activeDeployment) return
    await saveDeployment(activeChart, activeDeployment, { instances: rows })
    setDirty(false)
    setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
    const deps = await listDeployments(activeChart)
    setDeployments(deps)
  }

  async function handlePreview() {
    if (!activeChart || !activeDeployment) return
    if (dirty) await handleSave()
    const result = await renderDeployment(activeChart, activeDeployment)
    setPreviewYaml(result.ok ? result.output : `Error: ${result.error}`)
    setPreviewOpen(true)
  }

  async function handleCreateDeployment(name) {
    if (!activeChart) return
    await saveDeployment(activeChart, name, { instances: [] })
    const deps = await listDeployments(activeChart)
    setDeployments(deps)
    setActiveDeployment(name)
  }

  async function handleClone(source, newName) {
    if (!activeChart) return
    await cloneDeployment(activeChart, source, newName)
    const deps = await listDeployments(activeChart)
    setDeployments(deps)
    setActiveDeployment(newName)
  }

  return (
    <Layout style={{ height: '100%' }}>
      <Sider width={280} theme="light" style={{ borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ChartSelector charts={charts} activeChart={activeChart} onSelect={setActiveChart} onCreate={createChart} />
        <div style={{ borderTop: '1px solid #f0f0f0' }}>
          <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9ca3af' }}>
            Deployments
          </div>
          <DeploymentSelector
            deployments={deployments}
            activeDeployment={activeDeployment}
            onSelect={setActiveDeployment}
            onCreate={handleCreateDeployment}
            onClone={handleClone}
          />
        </div>
      </Sider>
      <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f8fafc' }}>
        {activeChart && activeDeployment ? (
          <>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', background: '#fff' }}>
              <Title level={4} style={{ margin: 0 }}>{activeChart} / {activeDeployment}</Title>
              {chartDescription && <Text type="secondary" style={{ fontSize: 13 }}>{chartDescription}</Text>}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
              <AlertTable
                vars={vars}
                rows={rows}
                onUpdate={updated => { setRows(updated); setDirty(true) }}
                onDelete={idx => { setRows(rows.filter((_, i) => i !== idx)); setDirty(true) }}
                onAdd={newRow => { setRows([...rows, newRow]); setDirty(true) }}
              />
            </div>
            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fff' }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
              <Button icon={<EyeOutlined />} onClick={handlePreview}>Preview</Button>
              {saveStatus && <Text type="secondary" style={{ fontSize: 12 }}>{saveStatus}</Text>}
            </div>
            <Modal title="Rendered PrometheusRule" open={previewOpen} onCancel={() => setPreviewOpen(false)}
              footer={null} width={800}>
              <pre style={{
                background: '#0f172a', color: '#7dd3fc', padding: 16, borderRadius: 8,
                fontSize: 12, fontFamily: 'monospace', maxHeight: 500, overflow: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all'
              }}>
                {previewYaml || 'No output'}
              </pre>
            </Modal>
          </>
        ) : (
          <Empty style={{ margin: 'auto' }}
            description={activeChart ? 'Select a deployment from the sidebar' : 'Select a chart to get started'} />
        )}
      </Content>
    </Layout>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npx vite build > /tmp/vite-build.log 2>&1; tail -3 /tmp/vite-build.log`
Expected: `✓ built in ...`

- [ ] **Step 3: Commit**

```bash
git add src/pages/AlertUserView.jsx
git commit -m "feat: AlertUserView reads schema for table, removes template tree, adds preview"
```

---

### Task 10: Sample Chart — tablespace-usage

**Files:**
- Create: `sample/charts/tablespace-usage/Chart.yaml`
- Create: `sample/charts/tablespace-usage/values.yaml`
- Create: `sample/charts/tablespace-usage/values.schema.json`
- Create: `sample/charts/tablespace-usage/templates/prometheus-rule.yaml`

- [ ] **Step 1: Create the sample chart directory and files**

```bash
mkdir -p sample/charts/tablespace-usage/templates
```

Write `sample/charts/tablespace-usage/Chart.yaml`:
```yaml
apiVersion: v2
name: tablespace-usage
description: Database tablespace utilization alerts with multi-tier severity
version: 1.0.0
type: application
```

Write `sample/charts/tablespace-usage/values.yaml`:
```yaml
instances:
  - db_name: mydb
    tablespace_name: users
    info: 30
    warn: 50
    critical: 70
    severe: 95
```

Write `sample/charts/tablespace-usage/values.schema.json`:
```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "instances": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "db_name": {
            "type": "string",
            "description": "Database name"
          },
          "tablespace_name": {
            "type": "string",
            "description": "Tablespace name"
          },
          "info": {
            "type": "number",
            "description": "Info threshold (%)",
            "default": 30
          },
          "warn": {
            "type": "number",
            "description": "Warning threshold (%)",
            "default": 50
          },
          "critical": {
            "type": "number",
            "description": "Critical threshold (%)",
            "default": 70
          },
          "severe": {
            "type": "number",
            "description": "Severe threshold (%)",
            "default": 95
          }
        },
        "required": ["db_name", "tablespace_name"]
      }
    }
  }
}
```

Write `sample/charts/tablespace-usage/templates/prometheus-rule.yaml`:
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ .Release.Name }}-tablespace-usage
  labels:
    app.kubernetes.io/managed-by: Helm
spec:
  groups:
    - name: tablespace-usage
      rules:
        {{- range .Values.instances }}
        - alert: tablespace-info-{{ .db_name }}-{{ .tablespace_name }}
          expr: 'tablespace_usage_percent{db="{{ .db_name }}", tablespace="{{ .tablespace_name }}"} > {{ .info }}'
          for: 10m
          labels:
            severity: info
            db: {{ .db_name }}
            tablespace: {{ .tablespace_name }}
          annotations:
            description: 'Tablespace {{ .tablespace_name }} on {{ .db_name }} exceeds {{ .info }}%'
        - alert: tablespace-warn-{{ .db_name }}-{{ .tablespace_name }}
          expr: 'tablespace_usage_percent{db="{{ .db_name }}", tablespace="{{ .tablespace_name }}"} > {{ .warn }}'
          for: 5m
          labels:
            severity: warning
            db: {{ .db_name }}
            tablespace: {{ .tablespace_name }}
          annotations:
            description: 'Tablespace {{ .tablespace_name }} on {{ .db_name }} exceeds {{ .warn }}%'
        - alert: tablespace-critical-{{ .db_name }}-{{ .tablespace_name }}
          expr: 'tablespace_usage_percent{db="{{ .db_name }}", tablespace="{{ .tablespace_name }}"} > {{ .critical }}'
          for: 2m
          labels:
            severity: critical
            db: {{ .db_name }}
            tablespace: {{ .tablespace_name }}
          annotations:
            description: 'Tablespace {{ .tablespace_name }} on {{ .db_name }} exceeds {{ .critical }}%'
        - alert: tablespace-severe-{{ .db_name }}-{{ .tablespace_name }}
          expr: 'tablespace_usage_percent{db="{{ .db_name }}", tablespace="{{ .tablespace_name }}"} > {{ .severe }}'
          for: 1m
          labels:
            severity: severe
            db: {{ .db_name }}
            tablespace: {{ .tablespace_name }}
          annotations:
            description: 'Tablespace {{ .tablespace_name }} on {{ .db_name }} exceeds {{ .severe }}%'
        {{- end }}
```

- [ ] **Step 2: Commit**

```bash
git add sample/charts/
git commit -m "feat: add tablespace-usage sample chart with native Helm structure"
```

---

### Task 11: Update Makefile apply-sample for Charts

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Add chart sample copying to apply-sample target**

Add to the `apply-sample` target in `Makefile`, after the existing copy lines:

```makefile
	@echo ">> Copying sample/charts/ → gitops/charts/"
	@mkdir -p gitops/charts
	@cp -r $(SAMPLE_DIR)/charts/. gitops/charts/
```

- [ ] **Step 2: Add chart dir cleanup to clean target**

Add to the `clean` target:

```makefile
	@echo ">> Removing all content from gitops/charts/..."
	@mkdir -p gitops/charts
	@find gitops/charts -mindepth 1 -maxdepth 1 -exec rm -rf {} +
```

- [ ] **Step 3: Commit**

```bash
git add Makefile
git commit -m "chore: Makefile apply-sample and clean handle gitops/charts"
```
