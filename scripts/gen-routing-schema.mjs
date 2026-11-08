#!/usr/bin/env node
// Writes schema/routing.schema.json from the zod schema (#167), for editor
// hints on a hand-written routing.yaml. A unit test fails when they differ.
import { writeFileSync } from 'node:fs'
import { z } from 'zod'
import { routingSchema } from '../src/utils/routingSchema.js'

const out = new URL('../schema/routing.schema.json', import.meta.url)
writeFileSync(out, `${JSON.stringify(z.toJSONSchema(routingSchema), null, 2)}\n`)
console.log(`wrote ${out.pathname}`)
