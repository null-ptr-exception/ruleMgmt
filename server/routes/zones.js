import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { copyDirRecursive } from '../lib/chartDiscovery.js'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const ZONE_TYPES = ['prometheus', 'victoriametrics']

function getZonesDir(req) {
  return path.join(req.gitopsDir, process.env.ZONES_DIR || 'zones')
}

function zonePaths(req, zone) {
  const zonesDir = getZonesDir(req)
  const zoneDir = path.join(zonesDir, zone)
  return {
    zoneDir,
    zoneYaml:     path.join(zoneDir, 'zone.yaml'),
    valuesYaml:   path.join(zoneDir, 'zone-values.yaml'),
    bindingsYaml: path.join(zoneDir, 'bindings.yaml'),
  }
}

async function readYaml(file, fallback = {}) {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return yaml.load(raw) || fallback
  } catch { return fallback }
}

export default function zonesRouter() {
  const router = express.Router()

  // ── List all zones ────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    const zonesDir = getZonesDir(req)
    try {
      await fs.mkdir(zonesDir, { recursive: true })
      const entries = await fs.readdir(zonesDir, { withFileTypes: true })
      const zones = []
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const meta = await readYaml(path.join(zonesDir, e.name, 'zone.yaml'))
        zones.push({ name: e.name, type: meta.type || 'prometheus', description: meta.description || '' })
      }
      res.json(zones)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Create zone ───────────────────────────────────────────────────────────
  router.post('/', async (req, res) => {
    const zonesDir = getZonesDir(req)
    const { name, type = 'prometheus', description = '' } = req.body
    if (!name || !NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Invalid zone name. Must match ^[a-z0-9][a-z0-9_-]*$' })
    }
    if (!ZONE_TYPES.includes(type)) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${ZONE_TYPES.join(', ')}` })
    }
    const { zoneDir, zoneYaml, valuesYaml, bindingsYaml } = zonePaths(req, name)
    try {
      try {
        await fs.access(zoneDir)
        return res.status(409).json({ error: `Zone "${name}" already exists` })
      } catch { /* good */ }
      await fs.mkdir(zoneDir, { recursive: true })
      await fs.writeFile(zoneYaml, yaml.dump({ name, type, description }, { lineWidth: -1 }), 'utf-8')
      await fs.writeFile(valuesYaml, yaml.dump({}, { lineWidth: -1 }), 'utf-8')
      await fs.writeFile(bindingsYaml, yaml.dump({ bindings: [] }, { lineWidth: -1 }), 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Get zone (meta + values + bindings) ──────────────────────────────────
  router.get('/:zone', async (req, res) => {
    const { zone } = req.params
    if (!NAME_RE.test(zone)) return res.status(400).json({ error: 'Invalid zone name' })
    const { zoneYaml, valuesYaml, bindingsYaml } = zonePaths(req, zone)
    try {
      const meta     = await readYaml(zoneYaml, { name: zone, type: 'prometheus' })
      const values   = await readYaml(valuesYaml, {})
      const bindData = await readYaml(bindingsYaml, { bindings: [] })
      res.json({ meta, values, bindings: bindData.bindings || [] })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Save zone meta ────────────────────────────────────────────────────────
  router.put('/:zone/meta', async (req, res) => {
    const { zone } = req.params
    if (!NAME_RE.test(zone)) return res.status(400).json({ error: 'Invalid zone name' })
    const { zoneYaml } = zonePaths(req, zone)
    try {
      await fs.writeFile(zoneYaml, yaml.dump(req.body, { lineWidth: -1 }), 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Save zone-values.yaml (global selector values) ───────────────────────
  router.put('/:zone/values', async (req, res) => {
    const { zone } = req.params
    if (!NAME_RE.test(zone)) return res.status(400).json({ error: 'Invalid zone name' })
    const { valuesYaml } = zonePaths(req, zone)
    try {
      const content = yaml.dump(req.body.values || {}, { lineWidth: -1 })
      await fs.writeFile(valuesYaml, content, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Save bindings ─────────────────────────────────────────────────────────
  router.put('/:zone/bindings', async (req, res) => {
    const { zone } = req.params
    if (!NAME_RE.test(zone)) return res.status(400).json({ error: 'Invalid zone name' })
    const { bindingsYaml } = zonePaths(req, zone)
    try {
      const content = yaml.dump({ bindings: req.body.bindings || [] }, { lineWidth: -1 })
      await fs.writeFile(bindingsYaml, content, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Delete zone ───────────────────────────────────────────────────────────
  router.delete('/:zone', async (req, res) => {
    const { zone } = req.params
    if (!NAME_RE.test(zone)) return res.status(400).json({ error: 'Invalid zone name' })
    const { zoneDir } = zonePaths(req, zone)
    try {
      await fs.rm(zoneDir, { recursive: true, force: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
