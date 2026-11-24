/** Reading routing for the commit check and Regenerate (#179). */

import path from 'path'
import yaml from 'js-yaml'
import { readRouting } from '../routingFiles.js'

export const parsedOrNull = text => {
  try {
    return yaml.load(text)
  } catch {
    return null
  }
}

export async function sameRouting(gitopsDir, a, b) {
  const [x, y] = await Promise.all([readRouting(path.join(gitopsDir, a)), readRouting(path.join(gitopsDir, b))])
  return x.text === y.text && x.cr === y.cr
}

export async function sameRoutingAs(gitopsDir, dep, { text, cr }) {
  const now = await readRouting(path.join(gitopsDir, dep))
  return now.text === text && now.cr === cr
}
