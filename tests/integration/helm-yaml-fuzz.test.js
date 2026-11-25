// readHelmYaml against Helm on generated values texts (tests/helpers/
// yamlFuzz.js): a fixed seed, so every run reads the same texts, all of them
// read by each Helm in a few runs (tests/helpers/helmValues.js).
//
// It holds, on every text and every Helm version given (HELM_BINS, or
// HELM_BIN, or `helm`):
//   - never a value different from Helm's
//   - never "Helm fails" for a text Helm reads
//   - texts read although Helm fails on them: no more than
//     helm-yaml-fuzz.counts.json says (it may only go down)
// and it prints the totals: agree / ok-different / ok-but-helm-fails /
// fails-but-helm-reads / cannot-tell.
//
// HELM_YAML_FUZZ=20000 (and HELM_YAML_FUZZ_SEED) runs a larger set and
// only prints its totals against the two rules above.
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { readHelmYaml } from '../../server/repo/helmYaml.js'
import { canon, helmBins, helmReadValues, helmReadValuesOneByOne } from '../helpers/helmValues.js'
import { fuzzTexts, repoYamlTexts } from '../helpers/yamlFuzz.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const COUNTS = fileURLToPath(new URL('./helm-yaml-fuzz.counts.json', import.meta.url))
const counts = JSON.parse(fs.readFileSync(COUNTS, 'utf8'))
const LARGE = Number(process.env.HELM_YAML_FUZZ || 0)
const SEED = Number(process.env.HELM_YAML_FUZZ_SEED || counts.seed)
const N = LARGE || counts.texts
const BINS = helmBins()

describe.skipIf(!BINS.length)(`readHelmYaml on ${N} generated texts, seed ${SEED}`, () => {
  let texts, reader, helm, totals
  const wrong = { okDifferent: [], failsButHelmReads: [], okButHelmFails: [] }

  beforeAll(async () => {
    texts = fuzzTexts(SEED, N, repoYamlTexts(root))
    reader = texts.map(t => readHelmYaml(t.bytes, { file: 'values.yaml' }))
    helm = []
    for (const bin of BINS) helm.push(await helmReadValues(bin, texts.map(t => t.bytes)))
    totals = { texts: N, agree: 0, okDifferent: 0, okButHelmFails: 0, failsButHelmReads: 0, cannotTell: 0, helmVersionsDiffer: 0 }
    texts.forEach((t, k) => {
      const r = reader[k]
      const hs = helm.map(h => h[k])
      if (hs.some(h => h.ok !== hs[0].ok || h.c !== hs[0].c)) totals.helmVersionsDiffer++
      const shown = `${t.name} ${JSON.stringify(t.bytes.toString('utf8').slice(0, 200))}`
      if (r.ok) {
        const v = canon(r.value)
        if (hs.some(h => h.ok && h.c !== v)) { totals.okDifferent++; wrong.okDifferent.push(`${shown} → ${v}; Helm ${hs.map(h => h.c ?? h.err).join(' | ')}`) } else if (hs.some(h => !h.ok)) { totals.okButHelmFails++; wrong.okButHelmFails.push(`${shown}: ${hs.map(h => h.err).join(' | ')}`) } else totals.agree++
      } else if (r.finding.helm === 'fails') {
        if (hs.some(h => h.ok)) { totals.failsButHelmReads++; wrong.failsButHelmReads.push(`${shown}: ${r.why}`) } else totals.agree++
      } else totals.cannotTell++
    })
    console.log(`readHelmYaml vs ${BINS.join(', ')}: ${JSON.stringify(totals)}`)
  }, 600000)

  it('never gives a value different from what Helm reads', () => {
    expect(wrong.okDifferent).toEqual([])
  })

  it('never says Helm fails on a text Helm reads', () => {
    expect(wrong.failsButHelmReads).toEqual([])
  })

  it.skipIf(LARGE)('reads no more texts Helm fails on than before', () => {
    expect(wrong.okButHelmFails.length, wrong.okButHelmFails.join('\n')).toBeLessThanOrEqual(counts.okButHelmFails)
    if (wrong.okButHelmFails.length < counts.okButHelmFails) console.log(`fewer texts read that Helm fails on: ${wrong.okButHelmFails.length}; lower okButHelmFails in helm-yaml-fuzz.counts.json`)
  })

  it.skipIf(LARGE)('reads most of what values files are written in, and says so for the rest', () => {
    // A guard against "cannot tell" spreading: the generated texts are odd
    // on purpose, but over a third of them are still answered.
    expect(totals.agree / N).toBeGreaterThan(counts.minAnswered)
  })

  it.skipIf(LARGE)('the many-texts-per-run reading is how Helm reads values.yaml', async () => {
    const sample = []
    reader.forEach((r, k) => { if (sample.length < 40 && (r.ok || (r.finding.helm === 'fails' && k % 3 === 0))) sample.push(k) })
    for (const [i, bin] of BINS.entries()) {
      const one = await helmReadValuesOneByOne(bin, sample.map(k => texts[k].bytes))
      sample.forEach((k, j) => {
        expect(one[j].ok, `${texts[k].name}: ${bin}`).toBe(helm[i][k].ok)
        if (one[j].ok) expect(one[j].c, `${texts[k].name}: ${bin}`).toBe(helm[i][k].c)
      })
    }
  }, 300000)
})
