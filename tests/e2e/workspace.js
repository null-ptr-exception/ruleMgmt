import path from 'path'

// Where server.js keeps the workspace: GITOPS_DIR, or gitops/ beside it.
// The E2E server inherits the environment `npm run test:e2e` runs in; a
// server you started yourself (reused outside CI) needs the same GITOPS_DIR,
// and if it is relative, the same working directory.
export const WORKSPACE = path.resolve(process.env.GITOPS_DIR || 'gitops')
