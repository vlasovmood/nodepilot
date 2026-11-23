import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api } from './client'
import type { Server, StatsSnapshot } from './types'

export const qk = {
  authStatus: ['auth', 'status'] as const,
  servers: ['servers'] as const,
  server: (id: string) => ['servers', id] as const,
  statsAll: ['stats'] as const,
  stats: (id: string) => ['stats', id] as const,
  statsHistory: (id: string, hours: number) => ['stats-history', id, hours] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  identities: ['identities'] as const,
  tokens: ['tokens'] as const,
  notes: (f?: { project_id?: string; server_id?: string }) => (f ? (['notes', f] as const) : (['notes'] as const)),
  processes: (id: string) => ['processes', id] as const,
  services: (id: string) => ['services', id] as const,
  files: (id: string, path: string) => ['files', id, path] as const,
  storages: ['backup-storages'] as const,
  graphs: ['graphs'] as const,
  graph: (id: string) => ['graphs', id] as const,
  jobs: (f?: { server_id?: string }) => (f ? (['backup-jobs', f] as const) : (['backup-jobs'] as const)),
  runs: (f?: { job_id?: string; server_id?: string }) => (f ? (['backup-runs', f] as const) : (['backup-runs'] as const)),
  securityStatus: ['security', 'status'] as const,
  twoFactor: ['security', '2fa'] as const,
  panelKey: ['security', 'panel-key'] as const,
  audit: (f?: { actor?: string; q?: string; severity?: string }) => (f ? (['audit', 'log', f] as const) : (['audit', 'log'] as const)),
  auditSettings: ['audit', 'settings'] as const,
}

export const STATS_POLL_MS = 10_000

export function useServers() {
  return useQuery({ queryKey: qk.servers, queryFn: () => api.servers.list(), staleTime: 15_000 })
}

export function useServer(id: string) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.server(id),
    queryFn: () => api.servers.get(id),
    // show the row from the cached list instantly, then refresh in the background
    placeholderData: () => qc.getQueryData<Server[]>(qk.servers)?.find((s) => s.id === id),
  })
}

export function useAllStats() {
  return useQuery({
    queryKey: qk.statsAll,
    queryFn: () => api.stats.all(),
    refetchInterval: STATS_POLL_MS,
    placeholderData: keepPreviousData,
  })
}

export function useStatsMap(): Map<string, StatsSnapshot> {
  const { data } = useAllStats()
  return useMemo(() => {
    const m = new Map<string, StatsSnapshot>()
    for (const s of data ?? []) m.set(s.server_id, s)
    return m
  }, [data])
}

export function useServerStats(id: string) {
  return useQuery({
    queryKey: qk.stats(id),
    queryFn: () => api.servers.stats(id),
    refetchInterval: STATS_POLL_MS,
    placeholderData: keepPreviousData,
  })
}

export function useProjects() {
  return useQuery({ queryKey: qk.projects, queryFn: () => api.projects.list(), staleTime: 15_000 })
}

export function useIdentities() {
  return useQuery({ queryKey: qk.identities, queryFn: () => api.identities.list() })
}

export function useStorages() {
  return useQuery({ queryKey: qk.storages, queryFn: () => api.backups.storages() })
}

/** Invalidate everything that depends on the server list (after create/update/delete/import). */
export function invalidateServers(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: qk.servers })
  void qc.invalidateQueries({ queryKey: qk.projects })
  void qc.invalidateQueries({ queryKey: qk.statsAll })
  void qc.invalidateQueries({ queryKey: qk.identities })
}

export function useGraphs() {
  return useQuery({ queryKey: qk.graphs, queryFn: () => api.graphs.list() })
}

/** Refresh everything on the security page (status, 2FA, panel key). */
export function invalidateSecurity(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ['security'] })
}
