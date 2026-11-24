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

/**
 * `kind` says the same as `why`, for code to decide on (why is for people):
 * 'permission', 'folder' (a folder where the file should be), 'not-a-folder'
 * (a file where a folder should be), 'dangling-link', 'outside-link',
 * 'not-a-file' (a pipe, a device …), 'too-big', or 'other'.
 */
export const UNREADABLE_KINDS = Object.freeze(['permission', 'folder', 'not-a-folder', 'dangling-link', 'outside-link', 'not-a-file', 'too-big', 'other'])

export function unreadable(file, why, kind = 'other') {
  if (typeof why !== 'string' || !why) throw new TypeError('an unreadable file says why')
  if (!UNREADABLE_KINDS.includes(kind)) throw new TypeError(`an unreadable file's kind is one of ${UNREADABLE_KINDS.join(', ')}, not ${JSON.stringify(kind)}`)
  return noValue({ state: 'unreadable', file, why, kind })
}

/** A link that is the file itself: a write replaces the link, never what it leads to. */
export const isLinkKind = kind => kind === 'dangling-link' || kind === 'outside-link'

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
