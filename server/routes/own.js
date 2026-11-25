/**
 * The routes server.js answers itself, as declared routes: who is signed
 * in, and the JSON 404 of an /api path no router has (any method; not the
 * page the SPA fallback sends for any other GET). Neither reads a value of
 * the request.
 *   GET /api/v2/user → { user, logoutUrl } (null each, outside JupyterHub)
 *   GET /api/v2/nope → 404 { error: 'No such API route' }
 */
import { route } from '../http/route.js'

export const userRoute = route('user', {}, async () => ({
  status: 200,
  body: {
    user: process.env.JUPYTERHUB_USER || null,
    logoutUrl: process.env.JUPYTERHUB_BASE_URL ? `${process.env.JUPYTERHUB_BASE_URL}hub/logout` : null,
  },
}))

export const unknownApiRoute = route('api.unknown', {}, async () => ({ status: 404, body: { error: 'No such API route' } }))
