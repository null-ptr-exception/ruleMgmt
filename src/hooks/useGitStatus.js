import { useState, useEffect, useCallback } from 'react'

export function useGitStatus() {
  const [status, setStatus] = useState({
    branch: '',
    changes: { modified: [], added: [], deleted: [] },
    changeCount: 0,
    behindMain: 0,
    hasRemote: false,
  })

  const refresh = useCallback(() => {
    fetch('/api/v2/git/status')
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setStatus(data) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [refresh])

  return { ...status, refresh }
}
