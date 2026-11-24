/**
 * The Template's rows of the tables every kind of file shares (policy.js
 * POLICIES): kept apart from findings/template.js, which imports policy.js.
 */
// What each of the Template's entry points does with each finding. The
// default (policy.js): refuse what Helm fails on, what it renders other than
// written, and what AlertForge cannot tell; let the rest through. Rows say
// where an entry point does otherwise, and why.
export const RULES_SOURCE = 'rules/ is the source (#57): rules that cannot be read or fail the rule checks are not passed on, though what is on disk renders'
export const PRODUCTS = 'the generated files follow rules/ (#57): behind, missing or repeated is refused until regenerated'
export const CANNOT_TELL_LIST = 'AlertForge cannot tell what Helm makes of it: listed, for the person to write it plainly'
export const FOLDER = 'a folder where a file is expected, or a link out of the repo, is named as unreadable, not taken for none or followed (Helm skips the one and follows the other)'
// A file the repo loader does not read (a link out of the repo, a folder
// where a file is expected), though Helm reads through it: refused as one
// that cannot be read, in every table that does not say otherwise.
export const READ_THROUGH = Object.freeze({
  'template.chart-unreadable': { action: 'refuse', why: FOLDER },
  'template.values-unreadable': { action: 'refuse', why: FOLDER },
  'template.schema-unreadable': { action: 'refuse', why: FOLDER },
  'template.rules-unreadable': { action: 'refuse', why: FOLDER },
})
export const LEGACY = 'a 1.x chart renders as it did; it is named until it is converted (#79)'

export const TEMPLATE_ROWS = Object.freeze({
  // Commit keeps blocking what it blocked (rules, drift, unreadable), and
  // adds what Helm fails on. Chart.yaml problems Helm stops a deployment on
  // are named with the deployment (commit/template.js), not twice.
  commit: {
    // Commit lists what Helm stops on in a deployment's values (its
    // default); a Template's file Helm stops on, or renders other than
    // written, fails every deployment of it: refused, as drift was.
    'template.*': { action: 'refuse', why: 'a Template file Helm fails on, or renders other than written, fails every deployment of the Template' },
    'template.schema-absent': { action: 'list', why: 'only the generated schema missing: Helm renders the same, without checking the values; opening the Template or regenerating writes it back' },
    ...READ_THROUGH,
    'template.rules-unreadable': { action: 'refuse', why: 'a file that cannot be read is not committed as if fine' },
    'template.rules-invalid': { action: 'refuse', why: RULES_SOURCE },
    'template.rule-check': { action: 'refuse', why: RULES_SOURCE },
    'template.drift-stale': { action: 'refuse', why: PRODUCTS },
    'template.drift-missing': { action: 'refuse', why: PRODUCTS },
    'template.drift-repeats': { action: 'refuse', why: 'the same rule rendered twice fires each alert twice' },
    'template.values-unreadable': { action: 'refuse', why: FOLDER },
    'template.legacy': { action: 'list', why: LEGACY },
    // Commit refused a values.yaml or Chart.yaml it could not parse before
    // there was a reader that can say "cannot tell"; it keeps refusing.
    'template.values-cannot-tell': { action: 'refuse', why: 'the Template values.yaml is read for every deployment: Commit refused one it could not read, and keeps doing so' },
    'template.chart-cannot-tell': { action: 'ignore', why: 'named with each deployment of the Template' },
    'template.rules-gone': { action: 'list', why: 'what is on disk renders; a save or gen-rules would write no rules, and refuses' },
    'template.schema-unchecked': { action: 'list', why: CANNOT_TELL_LIST },
    'template.chart-absent': { action: 'list', why: 'named with each deployment of the Template (its Template is not in the repo); a folder of rules with no Chart.yaml is how a Template is started by hand (gen-rules --init writes it), so it is not refused — but it is not in the Templates list, and may be what a delete stopped halfway left: said' },
    'template.chart-unreadable': { action: 'ignore', why: 'named with each deployment of the Template' },
    'template.chart-not-yaml': { action: 'ignore', why: 'named with each deployment of the Template' },
    'template.chart-version': { action: 'ignore', why: 'named with each deployment of the Template' },
  },
  checkRepo: {
    ...READ_THROUGH,
    'template.rules-unreadable': { action: 'refuse', why: 'a file that cannot be read is not passed as if fine' },
    'template.rules-invalid': { action: 'refuse', why: RULES_SOURCE },
    'template.rule-check': { action: 'refuse', why: RULES_SOURCE },
    'template.values-unreadable': { action: 'refuse', why: FOLDER },
    'template.legacy': { action: 'warn', why: LEGACY },
    'template.schema-absent': { action: 'warn', why: 'only the generated schema missing: Helm renders the same, without checking the values; opening the Template or regenerating writes it back' },
    'template.rules-gone': { action: 'warn', why: 'what is on disk renders; a save or gen-rules would write no rules, and refuses' },
  },
})

