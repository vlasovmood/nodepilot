import { AlertTriangle } from 'lucide-react'
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Modal } from './Modal'

export type ConfirmOptions = {
  title: string
  message?: ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
  /** If set, the user must type this exact text to enable the confirm button. */
  requireText?: string
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

const Ctx = createContext<ConfirmFn | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  // Rendered above <Suspense>, so it must not suspend while translations load.
  const { t } = useTranslation('common', { useSuspense: false })
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const [typed, setTyped] = useState('')
  const resolver = useRef<((v: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((o) => {
    resolver.current?.(false)
    setTyped('')
    setOpts(o)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const close = (v: boolean) => {
    resolver.current?.(v)
    resolver.current = null
    setOpts(null)
  }

  const blocked = !!opts?.requireText && typed.trim() !== opts.requireText

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <Modal
        open={!!opts}
        onClose={() => close(false)}
        size="sm"
        title={
          <span className="row">
            {opts?.danger && <AlertTriangle size={16} className="danger-text" />}
            {opts?.title}
          </span>
        }
        footer={
          <>
            <button className="btn" onClick={() => close(false)}>
              {opts?.cancelText ?? t('actions.cancel')}
            </button>
            <button
              className={opts?.danger ? 'btn btn-danger' : 'btn btn-primary'}
              disabled={blocked}
              onClick={() => close(true)}
              autoFocus={!opts?.requireText}
            >
              {opts?.confirmText ?? t('actions.confirm')}
            </button>
          </>
        }
      >
        <div className="stack">
          {opts?.message && <div className="muted">{opts.message}</div>}
          {opts?.requireText && (
            <div className="field">
              <label>
                <Trans
                  t={t}
                  i18nKey="confirm.typeToConfirm"
                  values={{ text: opts.requireText }}
                  components={{ b: <b className="mono" dir="ltr" /> }}
                />
              </label>
              <input
                className="input"
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !blocked) close(true)
                }}
              />
            </div>
          )}
        </div>
      </Modal>
    </Ctx.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useConfirm outside ConfirmProvider')
  return ctx
}
