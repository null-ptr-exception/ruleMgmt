#!/usr/bin/env node
// Writes schema/rules-file.schema.json, common-file.schema.json and
// outputs.schema.json from the tables the checks read (#68), for editor
// hints on a hand-written rules file. A unit test fails when they differ.
import { writeFileSync } from 'node:fs'
import { SCHEMA_FILES } from '../src/utils/rulesFileSchema.js'

for (const [name, build] of Object.entries(SCHEMA_FILES)) {
  const out = new URL(`../schema/${name}`, import.meta.url)
  writeFileSync(out, `${JSON.stringify(build(), null, 2)}\n`)
  console.log(`wrote ${out.pathname}`)
}
