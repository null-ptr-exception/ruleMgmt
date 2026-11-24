/**
 * What loading a file (or a model built from files) gives:
 *
 *   { state: 'absent', file }                    not there (ENOENT only)
 *   { state: 'unreadable', file, why }           there, and cannot be read:
 *                                                no permission, a folder, a
 *                                                link to nothing, a link out
 *                                                of the repo
 *   { state: 'invalid', file, findings }         read, and no model can be
 *                                                built: not YAML, not a map …
 *   { state: 'ok', value, findings }             the model, and the facts
 *                                                about it
 *
 * Only `ok` has a value: reading `.value` of any other state throws, so a
 * caller that forgot a state stops there instead of going on with nothing.
 */
import { defaultAction } from './policy.js'

export class NotLoadedError extends Error {
  constructor(loaded) {
    super(loaded.state === 'unreadable'
      ? `${loaded.file} cannot be read: ${loaded.why}`
      : loaded.state === 'invalid'
        ? `${loaded.file}: ${loaded.findings.map(f => f.message).join('; ') || 'cannot be used'}`
        : `${loaded.file || 'the file'} is not there`)
    this.name = 'NotLoadedError'
    this.loaded = loaded
  }
}

function noValue(obj) {
  Object.defineProperty(obj, 'value', { get() { throw new NotLoadedError(obj) }, enumerable: false })
  return Object.freeze(obj)
}

export const absent = (file = '') => noValue({ state: 'absent', file })

export function unreadable(file, why) {
  if (typeof why !== 'string' || !why) throw new TypeError('an unreadable file says why')
  return noValue({ state: 'unreadable', file, why })
}

export function invalid(file, findings) {
  if (!Array.isArray(findings) || !findings.length) throw new TypeError('an invalid file says what is wrong with it')
  // Each finding that leaves no model is one every entry point refuses
  // unless its table says otherwise (policy.js): nothing passes by default.
  const passing = findings.find(f => defaultAction(f) !== 'refuse')
  if (passing) throw new TypeError(`${passing.code} (helm: ${passing.helm}) cannot make a file invalid: by default it is let through`)
  return noValue({ state: 'invalid', file, findings: Object.freeze([...findings]) })
}

export function ok(value, findings = []) {
  return Object.freeze({ state: 'ok', value, findings: Object.freeze([...findings]) })
}

/** The state's findings: an unreadable file has none of its own (its `why` says it all). */
export const findingsOf = loaded => loaded.findings ?? []
