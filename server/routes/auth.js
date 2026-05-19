import { Router } from 'express'

export default function authRouter({ gitlabUrl, gitlabAppId, gitlabAppSecret }) {
  const router = Router()

  router.get('/user', (req, res) => {
    if (!gitlabUrl) {
      return res.json({ local: true })
    }
    if (req.session?.user) {
      const { username, displayName, avatarUrl } = req.session.user
      return res.json({ authenticated: true, username, displayName, avatarUrl })
    }
    res.json({ authenticated: false })
  })

  router.get('/login', (req, res) => {
    if (!gitlabUrl) {
      return res.status(404).json({ error: 'GitLab not configured' })
    }
    const params = new URLSearchParams({
      client_id: gitlabAppId,
      redirect_uri: `${req.protocol}://${req.get('host')}/api/auth/callback`,
      response_type: 'code',
      scope: 'read_user read_repository write_repository',
    })
    res.redirect(`${gitlabUrl}/oauth/authorize?${params}`)
  })

  router.get('/callback', async (req, res) => {
    if (!gitlabUrl) {
      return res.status(404).json({ error: 'GitLab not configured' })
    }
    const { code } = req.query
    if (!code) return res.status(400).json({ error: 'missing code' })

    try {
      const tokenRes = await fetch(`${gitlabUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: gitlabAppId,
          client_secret: gitlabAppSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: `${req.protocol}://${req.get('host')}/api/auth/callback`,
        }),
      })
      if (!tokenRes.ok) {
        const err = await tokenRes.text()
        return res.status(401).json({ error: `token exchange failed: ${err}` })
      }
      const tokenData = await tokenRes.json()

      const userRes = await fetch(`${gitlabUrl}/api/v4/user`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      })
      if (!userRes.ok) {
        return res.status(401).json({ error: 'failed to fetch user info' })
      }
      const userData = await userRes.json()

      req.session.user = {
        username: userData.username,
        displayName: userData.name,
        avatarUrl: userData.avatar_url,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
      }

      res.redirect('/')
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/logout', (req, res) => {
    if (req.session) {
      req.session.destroy(() => res.json({ ok: true }))
    } else {
      res.json({ ok: true })
    }
  })

  return router
}
