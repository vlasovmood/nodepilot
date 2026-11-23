import { Plus, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Server } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { cx } from '../../lib/util'
import { TerminalSession, type SessionState } from './TerminalSession'

type Session = { key: number; title: string; state: SessionState }

const STATE_DOT: Record<SessionState, string> = {
  connecting: 'dot-unknown',
  ready: 'dot-online',
  exited: 'dot-unknown',
  closed: 'dot-offline',
  error: 'dot-offline',
}

/** Several independent shells per server. Kept mounted while the server page is open. */
export function TerminalTab({ server, active }: { server: Server; active: boolean }) {
  const { t } = useTranslation('terminal')
  const confirm = useConfirm()
  const seq = useRef(1)
  const [sessions, setSessions] = useState<Session[]>([{ key: 1, title: `${server.name}`, state: 'connecting' }])
  const [current, setCurrent] = useState(1)

  const add = () => {
    const key = ++seq.current
    setSessions((s) => [...s, { key, title: `${server.name} (${key})`, state: 'connecting' }])
    setCurrent(key)
  }

  const close = async (key: number) => {
    const s = sessions.find((x) => x.key === key)
    if (s?.state === 'ready') {
      const ok = await confirm({
        title: t('confirmClose.title'),
        message: t('confirmClose.message'),
        confirmText: t('common:actions.close'),
      })
      if (!ok) return
    }
    const remaining = sessions.filter((x) => x.key !== key)
    setSessions((list) => list.filter((x) => x.key !== key))
    if (key === current && remaining.length) setCurrent(remaining[remaining.length - 1].key)
  }

  const setState = (key: number, state: SessionState) => setSessions((list) => list.map((x) => (x.key === key ? { ...x, state } : x)))

  return (
    <div className="term-shell" style={{ minHeight: 420 }}>
      <div className="term-tabs">
        {sessions.map((s) => (
          <div key={s.key} className={cx('term-tab', s.key === current && 'active')} onClick={() => setCurrent(s.key)}>
            <span className={`dot ${STATE_DOT[s.state]}`} style={{ boxShadow: 'none', width: 7, height: 7 }} />
            {s.title}
            <button
              className="btn btn-ghost btn-icon btn-sm"
              style={{ width: 20, height: 20 }}
              title={t('common:actions.close')}
              aria-label={t('common:actions.close')}
              onClick={(e) => {
                e.stopPropagation()
                void close(s.key)
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="btn btn-ghost btn-icon btn-sm" title={t('tabs.new')} aria-label={t('tabs.new')} onClick={add}>
          <Plus size={14} />
        </button>
      </div>
      <div className="term-body">
        {sessions.length === 0 && (
          <div className="state">
            <div className="muted">{t('tabs.none')}</div>
            <button className="btn btn-primary" onClick={add}>
              <Plus size={14} /> {t('tabs.open')}
            </button>
          </div>
        )}
        {sessions.map((s) => (
          <TerminalSession
            key={s.key}
            serverId={server.id}
            visible={active && s.key === current}
            onStateChange={(st) => setState(s.key, st)}
          />
        ))}
      </div>
    </div>
  )
}
