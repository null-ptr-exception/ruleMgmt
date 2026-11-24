/** The commit check of a deployment's values (#100). */

import path from 'path'
import { valuesWarnings } from '../deploymentWrite.js'
import { parseIfThere, UnreadableError } from '../readIfThere.js'
import { loadValues } from '../../../src/utils/valuesText.js'

// A hand-written null in a stacked deployment's values or a layer's (#100):
// Helm versions read it differently, so what is deployed cannot be told.
const stackNulls = stack => (stack.layers.length ? stack.valueIssues : [])

/**
 * One deployment's values, as a commit checks them: a hand-written null in
 * its stack, and a values.yaml that cannot be read or is not YAML, block
 * (`findings`, in that order); rows the row identity label cannot tell
 * apart do not (`warnings`). `stack` is the deployment's resolveStack.
 * @returns { findings: [finding], warnings: [string] }
 */
export async function valuesFindings(gitopsDir, dep, stack) {
  const findings = []
  const nulls = stackNulls(stack)
  if (nulls.length) findings.push({ severity: 'commit', kind: 'values-null', deployment: dep, regenerable: false, description: `${dep}: ${nulls.join('; ')}` })
  // A values.yaml that cannot be read, or is not YAML, renders nothing:
  // said as a stack says it for a deployment on one, not passed over.
  let valuesText
  try {
    valuesText = await parseIfThere(path.join(gitopsDir, dep, 'values.yaml'), text => { loadValues(text); return text })
  } catch (err) {
    if (!stack.problems.some(p => p.kind === 'values-unreadable')) {
      findings.push({ severity: 'commit', kind: 'values-unreadable', deployment: dep, regenerable: false,
        description: `${dep}: values.yaml cannot be read (${err.why || err.message}), so Helm cannot render it` })
    }
    valuesText = null
  }
  // A Template that cannot be read is the chart check's finding
  // (chart-unreadable): this deployment's warnings wait for it.
  const repeats = valuesText === null ? [] : await valuesWarnings(gitopsDir, path.join(gitopsDir, dep), valuesText, { stack })
    .catch(err => { if (err instanceof UnreadableError) return []; throw err })
  return { findings, warnings: repeats }
}
