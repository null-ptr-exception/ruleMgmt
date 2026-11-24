/** The commit check of a deployment's values (#100). */

// A hand-written null in a stacked deployment's values or a layer's (#100):
// Helm versions read it differently, so what is deployed cannot be told.
export const stackNulls = stack => (stack.layers.length ? stack.valueIssues : [])
