import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { Loading } from './components/States'
import { AuthGate } from './features/auth/AuthGate'
import { AppLayout } from './layout/AppLayout'
import { AllServersPage } from './pages/AllServersPage'
import { NotFoundPage } from './pages/NotFoundPage'

const ServerPage = lazy(() => import('./pages/ServerPage').then((m) => ({ default: m.ServerPage })))
const ProjectPage = lazy(() => import('./pages/ProjectPage').then((m) => ({ default: m.ProjectPage })))
const IdentitiesPage = lazy(() => import('./pages/IdentitiesPage').then((m) => ({ default: m.IdentitiesPage })))
const BackupsPage = lazy(() => import('./pages/BackupsPage').then((m) => ({ default: m.BackupsPage })))
const NotesPage = lazy(() => import('./pages/NotesPage').then((m) => ({ default: m.NotesPage })))
const ExecPage = lazy(() => import('./pages/ExecPage').then((m) => ({ default: m.ExecPage })))
const GraphsPage = lazy(() => import('./pages/GraphsPage').then((m) => ({ default: m.GraphsPage })))
const GraphPage = lazy(() => import('./pages/GraphPage').then((m) => ({ default: m.GraphPage })))
const DeveloperPage = lazy(() => import('./pages/DeveloperPage').then((m) => ({ default: m.DeveloperPage })))
const SecurityPage = lazy(() => import('./pages/SecurityPage').then((m) => ({ default: m.SecurityPage })))
const AuditPage = lazy(() => import('./pages/AuditPage').then((m) => ({ default: m.AuditPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))

const page = (el: ReactNode) => <Suspense fallback={<Loading />}>{el}</Suspense>

export function App() {
  return (
    <AuthGate>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to="/servers" replace />} />
          <Route path="servers" element={<AllServersPage />} />
          <Route path="servers/:id" element={page(<ServerPage />)} />
          <Route path="servers/:id/:tab" element={page(<ServerPage />)} />
          <Route path="projects/:id" element={page(<ProjectPage />)} />
          <Route path="graphs" element={page(<GraphsPage />)} />
          <Route path="graphs/:id" element={page(<GraphPage />)} />
          <Route path="identities" element={page(<IdentitiesPage />)} />
          <Route path="backups" element={page(<BackupsPage />)} />
          <Route path="notes" element={page(<NotesPage />)} />
          <Route path="exec" element={page(<ExecPage />)} />
          <Route path="developer" element={page(<DeveloperPage />)} />
          <Route path="developer/:tab" element={page(<DeveloperPage />)} />
          <Route path="security" element={page(<SecurityPage />)} />
          <Route path="audit" element={page(<AuditPage />)} />
          <Route path="settings" element={page(<SettingsPage />)} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </AuthGate>
  )
}
