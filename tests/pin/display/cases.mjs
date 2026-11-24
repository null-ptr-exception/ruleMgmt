// The input table of the display pin: the deployment-values pin's inputs,
// as they are (imported, not copied), so both pins pin the same repo states.
// What this pin adds is what each display shows for them.
//
// PROBES: the value cells the editor's answer is compared on, each a path
// into the bare values (`cpu.0.threshold`: the first cpu row's threshold),
// the same for every input. A layer's own rows are its users' defaults, not
// what Helm renders for them: on a layer page only `_common` is compared.
import { CASES as VALUES_CASES } from '../deployment-values/cases.mjs'

export const CASES = VALUES_CASES

export const PROBES = ['_common.team', '_common.base', 'cpu.0.job', 'cpu.0.threshold', 'cpu.0.window', 'cpu.0.severity', 'cpu.0.freq']
export const probesFor = target => (target === 'L' ? PROBES.filter(p => p.startsWith('_common.')) : PROBES)
