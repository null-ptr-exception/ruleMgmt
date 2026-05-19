import { useState, useEffect, createContext, useContext } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState({ loading: true, isLocal: false, isAuthenticated: false, user: null })

  useEffect(() => {
    fetch('/api/auth/user')
      .then(res => res.json())
      .then(data => {
        if (data.local) {
          setAuth({ loading: false, isLocal: true, isAuthenticated: true, user: null })
        } else if (data.authenticated) {
          setAuth({ loading: false, isLocal: false, isAuthenticated: true, user: data })
        } else {
          setAuth({ loading: false, isLocal: false, isAuthenticated: false, user: null })
        }
      })
      .catch(() => {
        setAuth({ loading: false, isLocal: true, isAuthenticated: true, user: null })
      })
  }, [])

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
