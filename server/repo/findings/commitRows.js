/**
 * The rows of Commit's and check-repo's tables (policy.js POLICIES) for the
 * routing, shared configs, walk and sync.yaml findings: kept apart from
 * routingPolicy.js, which imports policy.js.
 */
const PROBLEM = "routing.yaml's own problems are fixed on its Routing page; the resource made before is what is deployed until then"

// The app's Commit: what blocks today blocks; a routing.yaml's own problems
// are listed (routingProblems), not a reason to refuse a commit of
// everything else.
export const ROUTING_COMMIT_ROWS = Object.freeze({
  // Commit lists what Helm stops on in values (its default); a resource Helm
  // deploys otherwise than its routing.yaml says, or cannot read, is
  // refused, as it was before the tables were one.
  'routing.*': { action: 'refuse', why: 'a resource that cannot be read, is left without its routing.yaml, or is behind it deploys otherwise than the routing.yaml says' },
  'routing.problem': { action: 'list', why: PROBLEM },
  'routing.shared-unresolved': { action: 'refuse', why: 'the shared file was changed (removed, broken, a config taken out) under deployments that were fine: a resource made now would have no one to send to' },
  'routing.warning': { action: 'warn', why: 'what its configs will do that is worth saying' },
  'routing.common-resource': { action: 'list', why: 'named, not a reason to refuse the commit: Commit did not block it before (check-deployment does)' },
  'shared.*': { action: 'refuse', why: 'the shared configs are what every resource using them is made from' },
  'shared.problem': { action: 'list', why: 'blocks only while a deployment uses the file (routing.shared-unresolved)' },
  'shared.warning': { action: 'warn', why: 'what its configs will do that is worth saying' },
})

// check-repo: Commit's refusals (policy.js), and what Commit only lists is
// refused too: the gate outside the app is where a hand-edited file is
// caught, as check-deployment catches it.
export const ROUTING_CHECK_REPO_ROWS = Object.freeze({
  'routing.problem': { action: 'refuse', why: 'the resource deployed is not made from this routing.yaml: it stays what was made before (check-deployment fails on it too)' },
  'routing.warning': { action: 'warn', why: 'what its configs will do that is worth saying' },
  'shared.problem': { action: 'refuse', why: 'the shared configs file is AlertForge\'s own: with problems, no routing.yaml can use it' },
  'shared.warning': { action: 'warn', why: 'what its configs will do that is worth saying' },
})

const LISTED_WALK = 'a folder whose deployments cannot be read, or a deployment whose Chart.yaml cannot be, is named, not a reason to refuse a commit of everything else; check-repo refuses it'
const TARGET_DIFFERS = 'a sync target is its source\'s copy (read-only in the app): values or a Template changed on it deploy something else than its source, until it is synced again or unlinked'
const SYNC_WRONG = 'a sync.yaml row the app cannot use, or that cannot be right (a path that is no deployment, a target with two sources, a chain), leaves targets that are no copy of their source'

export const WALK_SYNC_ROWS = Object.freeze({
  commit: {
    'walk.*': { action: 'list', why: LISTED_WALK },
    'sync.*': { action: 'refuse', why: SYNC_WRONG },
    'sync.backslash': { action: 'ignore', why: 'a \\ in a path is read as /, as sync.yaml has always been read: the same deployment' },
    'sync.duplicate-target': { action: 'ignore', why: 'a target listed twice under one source is the same link' },
    'sync.target-differs': { action: 'refuse', why: TARGET_DIFFERS },
  },
  checkRepo: {
    'walk.*': { action: 'refuse', why: 'what cannot be read cannot be said to deploy as written' },
    'sync.*': { action: 'refuse', why: SYNC_WRONG },
    'sync.backslash': { action: 'warn', why: 'read as /: said, so it can be written as the app writes it' },
    'sync.duplicate-target': { action: 'warn', why: 'the same link twice: said, so it can be written once' },
    'sync.target-differs': { action: 'refuse', why: TARGET_DIFFERS },
  },
})
