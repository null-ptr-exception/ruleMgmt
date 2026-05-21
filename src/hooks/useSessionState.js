import { useState, useCallback } from 'react'

const PREFIX = 'alertforge:'

export default function useSessionState(key, defaultValue = null) {
  const fullKey = PREFIX + key

  const [value, setValue] = useState(() => {
    try {
      const stored = sessionStorage.getItem(fullKey)
      return stored !== null ? JSON.parse(stored) : defaultValue
    } catch {
      return defaultValue
    }
  })

  const set = useCallback((next) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next
      try {
        if (resolved === null || resolved === undefined) {
          sessionStorage.removeItem(fullKey)
        } else {
          sessionStorage.setItem(fullKey, JSON.stringify(resolved))
        }
      } catch { /* quota exceeded — degrade silently */ }
      return resolved
    })
  }, [fullKey])

  return [value, set]
}
