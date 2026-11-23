import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { cx } from '../lib/util'

type Props = {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  /** Prevent closing via overlay click / Esc (e.g. while a request is in flight). */
  locked?: boolean
  headerExtra?: ReactNode
  bodyClassName?: string
}

export function Modal({ open, onClose, title, children, footer, size = 'md', locked, headerExtra, bodyClassName }: Props) {
  // Also rendered by providers above <Suspense> (Confirm), so it must not suspend.
  const { t } = useTranslation('common', { useSuspense: false })
  const mouseDownOnOverlay = useRef(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Only the topmost dialog reacts (a dialog may open another one on top of it).
      const overlays = document.querySelectorAll('.modal-overlay')
      if (overlays.length && overlays[overlays.length - 1] !== overlayRef.current) return
      if (!locked) {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, locked, onClose])

  if (!open) return null

  return createPortal(
    <div
      ref={overlayRef}
      className="modal-overlay"
      onMouseDown={(e) => {
        mouseDownOnOverlay.current = e.target === e.currentTarget
      }}
      onMouseUp={(e) => {
        if (mouseDownOnOverlay.current && e.target === e.currentTarget && !locked) onClose()
        mouseDownOnOverlay.current = false
      }}
    >
      <div className={cx('modal', size !== 'md' && `modal-${size}`)} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2 className="ellipsis">{title}</h2>
          {headerExtra}
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} disabled={locked} aria-label={t('actions.close')}>
            <X size={16} />
          </button>
        </div>
        <div className={cx('modal-body', bodyClassName)}>{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
