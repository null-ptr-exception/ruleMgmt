const basePath = () => (typeof window !== 'undefined' && window.__BASE_PATH__) || '/'

export async function apiFetch(path, opts) {
  const base = basePath().replace(/\/$/, '')
  const url = path.startsWith('/') ? `${base}${path}` : `${base}/${path}`
  try {
    return await fetch(url, opts)
  } catch (err) {
    return { ok: false, status: 0, json: async () => ({ error: err.message }) }
  }
}
