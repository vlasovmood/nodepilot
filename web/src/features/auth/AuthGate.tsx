import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { api, setUnauthorizedHandler } from '../../api/client'
import { qk } from '../../api/queries'
import type { AuthStatus, User } from '../../api/types'
import { ErrorState, Loading } from '../../components/States'
import { AuthPage } from './AuthPage'

type AuthCtx = { user: User; logout: () => Promise<void> }

const Ctx = createContext<AuthCtx | null>(null)

export function useAuth(): AuthCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth outside AuthGate')
  return c
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation('auth')
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: qk.authStatus,
    queryFn: () => api.auth.status(),
    staleTime: Infinity,
    retry: 1,
  })

  // Any authenticated request that returns 401 drops us back to the login screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      const cur = qc.getQueryData<AuthStatus>(qk.authStatus)
      if (cur?.user) {
        qc.setQueryData<AuthStatus>(qk.authStatus, { setup_required: false, user: null })
      }
    })
    return () => setUnauthorizedHandler(null)
  }, [qc])

  const logout = useCallback(async () => {
    try {
      await api.auth.logout()
    } finally {
      // Switch to the login screen first (unmounts the app tree), then drop all cached data.
      qc.setQueryData<AuthStatus>(qk.authStatus, { setup_required: false, user: null })
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
    }
  }, [qc])

  if (status.isPending) {
    return (
      <div className="auth-screen">
        <Loading label={t('connecting')} />
      </div>
    )
  }
  if (status.isError) {
    return (
      <div className="auth-screen">
        <ErrorState title={t('unavailable')} error={status.error} onRetry={() => void status.refetch()} />
      </div>
    )
  }
  const { user, setup_required } = status.data
  if (!user) return <AuthPage setupRequired={setup_required} />

  return <Ctx.Provider value={{ user, logout }}>{children}</Ctx.Provider>
}
