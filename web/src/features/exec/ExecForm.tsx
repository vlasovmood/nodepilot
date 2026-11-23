import { useMutation } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import type { BulkExecRequest, BulkExecResult } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { InlineError, Spinner } from '../../components/States'

const HISTORY_KEY = 'np.exec.history'

function loadHistory(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function pushHistory(cmd: string) {
  try {
    const h = [cmd, ...loadHistory().filter((c) => c !== cmd)].slice(0, 30)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h))
  } catch {
    /* ignore */
  }
}

const DANGEROUS = /\b(rm\s+-[a-z]*r[a-z]*f|mkfs|dd\s+if=|shutdown|reboot|poweroff|halt|init\s+0)\b/i

type Target = { server_ids: string[] } | { project_id: string; count: number }

export function ExecForm({ target, onResults }: { target: Target; onResults: (r: BulkExecResult[], cmd: string) => void }) {
  const { t } = useTranslation('exec')
  const confirm = useConfirm()
  const [command, setCommand] = useState('')
  const [timeout, setTimeoutSecs] = useState('60')
  const [history, setHistory] = useState<string[]>(loadHistory)

  const count = 'server_ids' in target ? target.server_ids.length : target.count

  const m = useMutation({
    mutationFn: (req: BulkExecRequest) => api.exec.bulk(req),
    onSuccess: (res, req) => onResults(res.results, req.command),
  })

  const run = async () => {
    const cmd = command.trim()
    if (!cmd || count === 0 || m.isPending) return
    if (DANGEROUS.test(cmd) || count > 20) {
      const ok = await confirm({
        title: t('form.confirm.title'),
        message: (
          <>
            {t('form.confirm.message', { count })}
            <pre className="output" style={{ marginTop: 8 }}>
              {cmd}
            </pre>
          </>
        ),
        confirmText: t('form.confirm.button'),
        danger: DANGEROUS.test(cmd),
      })
      if (!ok) return
    }
    pushHistory(cmd)
    setHistory(loadHistory())
    const secs = Number(timeout)
    const timeout_secs = Number.isFinite(secs) && secs > 0 ? secs : undefined
    m.mutate(
      'server_ids' in target
        ? { command: cmd, server_ids: target.server_ids, timeout_secs }
        : { command: cmd, project_id: target.project_id, timeout_secs },
    )
  }

  return (
    <div className="stack-sm">
      <textarea
        className="textarea mono"
        rows={3}
        placeholder={t('form.placeholder')}
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void run()
          }
        }}
        spellCheck={false}
      />
      <div className="row-wrap">
        <button className="btn btn-primary" disabled={!command.trim() || count === 0 || m.isPending} onClick={() => void run()}>
          {m.isPending ? <Spinner /> : <Play size={14} />}
          {t('form.run', { count })}
        </button>
        <span className="dim small">Ctrl+Enter</span>
        <span className="spacer" />
        <label className="row small muted">
          {t('form.timeout')}
          <input
            className="input input-sm"
            style={{ width: 70 }}
            inputMode="numeric"
            value={timeout}
            onChange={(e) => setTimeoutSecs(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        {history.length > 0 && (
          <select
            className="select select-sm"
            style={{ width: 220 }}
            value=""
            onChange={(e) => e.target.value && setCommand(e.target.value)}
            title={t('form.history')}
          >
            <option value="">{t('form.historyPlaceholder')}</option>
            {history.map((h) => (
              <option key={h} value={h}>
                {h.length > 60 ? h.slice(0, 60) + '…' : h}
              </option>
            ))}
          </select>
        )}
      </div>
      {m.isPending && (
        <div className="row muted small">
          <Spinner /> {t('form.running')}
        </div>
      )}
      <InlineError error={m.error} />
    </div>
  )
}
