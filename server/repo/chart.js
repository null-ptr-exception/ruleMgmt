/**
 * A Chart.yaml as the stack, the sync copy and the `_common` moves read it:
 * the one place its text is parsed outside the Helm reader (helmYaml.js).
 *
 *   parseChart(text)       the document; throws what the parser throws
 *   chartDoc(repo, dir)    the Chart.yaml of the chart folder `dir`, read
 *                          through the snapshot: the document, undefined
 *                          when there is none, null when it cannot be read
 *                          or is not YAML
 *
 * This is the YAML 1.2 reading these callers have always had (a key
 * written twice is not YAML here; `yes` is the text "yes"), not Helm's.
 * Reading it as Helm does (repo.helmYaml, as the walk and the deployment's
 * own Chart.yaml are read) changes what they answer for such a file: to do
 * with a behaviour change, not here.
 */
import yaml from 'js-yaml'

export const parseChart = text => yaml.load(text)

// Not there, for these callers: no file, a file where its folder should
// be, and a link to nothing (what reading through it finds).
const none = f => f.state === 'absent' || (f.state === 'unreadable' && (f.kind === 'not-a-folder' || f.kind === 'dangling-link'))

export function chartDoc(repo, dir) {
  const file = dir ? `${dir}/Chart.yaml` : 'Chart.yaml'
  return repo.memo('chartDoc', file, async () => {
    const f = await repo.file(file)
    if (none(f)) return undefined
    if (f.state !== 'ok') return null
    try {
      return parseChart(f.value.text)
    } catch {
      return null // not YAML: said by whoever asked, as a chart that cannot be read
    }
  })
}
