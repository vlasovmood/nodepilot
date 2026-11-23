import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { ApiRequestError } from './api/client'
import { App } from './App'
import { ConfirmProvider } from './components/Confirm'
import { ToastProvider } from './components/Toast'
import './i18n'
import '@fontsource-variable/inter'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5_000,
      // Do not retry client errors (4xx); retry network / 5xx once.
      retry: (count, err) => {
        if (err instanceof ApiRequestError && err.status >= 400 && err.status < 500) return false
        return count < 1
      },
    },
    mutations: { retry: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ToastProvider>
        <ConfirmProvider>
          <Suspense fallback={null}>
            <App />
          </Suspense>
        </ConfirmProvider>
      </ToastProvider>
    </BrowserRouter>
  </QueryClientProvider>,
)
