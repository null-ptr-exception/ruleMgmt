/**
 * The parts of a request the Template routes share (templates.js,
 * charts.js): a Template's rules files, and the mapping a breaking change
 * carries.
 */
import { z } from 'zod'
import { pathProblem } from '../repo/paths.js'
import { map, noProtoKey } from './route.js'

/**
 * A Template's rules/ as the editor sends it: { '<group>.yaml': text },
 * `_common.yaml` among them; `{}` is a Template with no group. A key is a
 * rules file name as paths.js takes it ('rules-file').
 *   { files: { '../x.yaml': '…' } } → 400 'Invalid rules file name: ../x.yaml'
 */
export const rulesFiles = map(z.string()).superRefine((files, ctx) => {
  for (const name of Object.keys(files)) {
    if (pathProblem(name, 'rules-file')) ctx.addIssue({ code: 'custom', message: `Invalid rules file name: ${name}`, path: [name] })
  }
})

/**
 * What a breaking change does with each deployment's rows, per group: a
 * column renamed ({ columns: { cpu: { job: 'service' } } }), a group
 * renamed ({ groups: { cpu: 'compute' } }), columns dropped
 * ({ dropped: { cpu: ['team'] } }). Anything else in it is kept as it is
 * (a clone records the mapping on the copy).
 */
export const migrationMapping = noProtoKey(z.looseObject({
  columns: map(map(z.string())).optional(),
  groups: map(z.string()).optional(),
  dropped: map(z.array(z.string())).optional(),
}))
