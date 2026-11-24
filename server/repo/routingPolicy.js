/**
 * What each entry point does with the findings of a deployment's routing
 * and of the shared notification configs (routing.js, shared.js). The
 * default is policy.js's: refuse what Helm fails on or deploys otherwise
 * than written (an unreadable resource, one left without its routing.yaml,
 * one behind it), let the rest through. routing.yaml and the shared file
 * are AlertForge's own (`helm: 'n/a'`): what is done with their problems
 * is a row here, with its reason.
 */
import { definePolicy } from './policy.js'

const PROBLEM = "routing.yaml's own problems are fixed on its Routing page; the resource made before is what is deployed until then"
const SAID = 'the save checks name it with the routing.yaml problems (routing.problem)'

export const ROUTING_POLICIES = Object.freeze({
  // The Routing page (GET): the file as it is, with what is wrong with it.
  routingPage: definePolicy('routingPage', { rows: {
    'routing.problem': { action: 'list', why: PROBLEM },
    'routing.shared-unresolved': { action: 'ignore', why: SAID },
    'routing.stale': { action: 'list', why: 'shown as behind: saving it again makes the resource again' },
    'routing.warning': { action: 'warn', why: 'what its configs will do that is worth saying' },
  } }),
  // A save (PUT) writes both files anew: only what stops the write counts.
  routingSave: definePolicy('routingSave', { rows: {
    'routing.*': { action: 'ignore', why: 'the save writes routing.yaml and makes the resource again from it' },
    'routing.cr-unreadable': { action: 'refuse', why: 'a resource that cannot be read cannot be replaced either' },
  } }),
  // A source's routing copied to its sync targets (sync, Regenerate): the
  // resource is made again from routing.yaml, never copied (#166).
  syncCopy: definePolicy('syncCopy', { rows: {
    'routing.problem': { action: 'refuse', why: 'a broken routing.yaml is not spread to read-only targets, which could not fix it (#180)' },
    'routing.shared-unresolved': { action: 'ignore', why: SAID },
    'routing.stale': { action: 'ignore', why: 'the resource is made again from routing.yaml, not copied' },
    'routing.cr-unreadable': { action: 'ignore', why: 'the resource is made again from routing.yaml, not copied' },
    'routing.warning': { action: 'ignore', why: 'said where it is saved and committed' },
  } }),
  // The app's Commit: what blocks today blocks; a routing.yaml's own
  // problems are listed (routingProblems), not a reason to refuse a commit
  // of everything else.
  commit: definePolicy('commit', { rows: {
    'routing.problem': { action: 'list', why: PROBLEM },
    'routing.shared-unresolved': { action: 'refuse', why: 'the shared file was changed (removed, broken, a config taken out) under deployments that were fine: a resource made now would have no one to send to' },
    'routing.warning': { action: 'warn', why: 'what its configs will do that is worth saying' },
    'routing.common-resource': { action: 'list', why: 'named, not a reason to refuse the commit: Commit did not block it before (check-deployment does)' },
    'shared.problem': { action: 'list', why: 'blocks only while a deployment uses the file (routing.shared-unresolved)' },
    'shared.warning': { action: 'warn', why: 'what its configs will do that is worth saying' },
  } }),
  // check-deployment, the gate outside the app: what deploys is what the
  // table says, or it fails.
  checkDeployment: definePolicy('checkDeployment', { rows: {
    'routing.problem': { action: 'refuse', why: 'the resource deployed is not made from this routing.yaml' },
    'routing.shared-unresolved': { action: 'ignore', why: SAID },
    'routing.warning': { action: 'warn', why: 'what its configs will do that is worth saying' },
  } }),
})
