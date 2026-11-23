import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../api/client'

type Kind = 'success' | 'error' | 'info'
type ToastItem = { id: number; kind: Kind; title: string; message?: string }

type ToastApi = {
  success: (title: string, message?: string) => void
  error: (title: string, err?: unknown) => void
  info: (title: string, message?: string) => void
}

const Ctx = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  // Rendered above <Suspense>, so it must not suspend while translations load.
  const { t: tr } = useTranslation('common', { useSuspense: false })
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), [])

  const push = useCallback(
    (kind: Kind, title: string, message?: string) => {
      const id = ++seq.current
      setItems((xs) => [...xs.slice(-4), { id, kind, title, message }])
      window.setTimeout(() => remove(id), kind === 'error' ? 8000 : 4000)
    },
    [remove],
  )

  const api = useMemo<ToastApi>(
    () => ({
      success: (t, m) => push('success', t, m),
      info: (t, m) => push('info', t, m),
      error: (t, e) => push('error', t, e === undefined ? undefined : errorMessage(e)),
    }),
    [push],
  )

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === 'success' ? <CheckCircle2 size={16} /> : t.kind === 'error' ? <XCircle size={16} /> : <Info size={16} />}
            <div className="grow">
              <div className="toast-title">{t.title}</div>
              {t.message && <div className="toast-msg">{t.message}</div>}
            </div>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => remove(t.id)} aria-label={tr('actions.close')}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast outside ToastProvider')
  return ctx
}
