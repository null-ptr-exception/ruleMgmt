const basePath = () => (typeof window !== 'undefined' && window.__BASE_PATH__) || '/'

export function apiFetch(path, opts) {
  const base = basePath().replace(/\/$/, '')
  const url = path.startsWith('/') ? `${base}${path}` : `${base}/${path}`
  return fetch(url, opts)
}
