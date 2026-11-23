import { useMutation } from '@tanstack/react-query'
import { Crosshair, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useServers } from '../../api/queries'
import { Spinner } from '../../components/States'
import { useToast } from '../../components/Toast'
import { intlLocale } from '../../i18n'
import { cx } from '../../lib/util'
import { isValidAddress } from './util'

/** Chips of addresses/networks (sshd `from=`); invalid entries are highlighted. */
export function AddressEditor({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const { t } = useTranslation('security')
  const [text, setText] = useState('')

  const add = (raw: string) => {
    const parts = raw
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter(Boolean)
    setText('')
    if (!parts.length) return
    const next = [...value]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
  }

  return (
    <div
      className={cx('tag-input addr-input', disabled && 'disabled')}
      dir="ltr"
      onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}
    >
      {value.map((a) => {
        const ok = isValidAddress(a)
        return (
          <span key={a} className={cx('tag mono', !ok && 'tag-invalid')} title={ok ? a : t('panelKey.addresses.invalid', { value: a })}>
            {a}
            {!disabled && (
              <button
                type="button"
                className="tag-x"
                onClick={() => onChange(value.filter((x) => x !== a))}
                aria-label={t('common:tags.remove', { tag: a })}
              >
                <X size={11} />
              </button>
            )}
          </span>
        )
      })}
      <input
        value={text}
        disabled={disabled}
        className="mono"
        placeholder={value.length ? '' : '203.0.113.10, 10.0.0.0/8'}
        aria-label={t('panelKey.addresses.label')}
        onChange={(e) => {
          const v = e.target.value
          if (/[,\s]$/.test(v)) add(v)
          else setText(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(text)
          } else if (e.key === 'Backspace' && !text && value.length) {
            onChange(value.slice(0, -1))
          }
        }}
        onBlur={() => add(text)}
      />
    </div>
  )
}

/** Pick a server → ask it which address the panel connects from → add that address. */
export function DetectIp({ onDetected }: { onDetected: (ip: string) => void }) {
  const { t, i18n } = useTranslation('security')
  const toast = useToast()
  const servers = useServers()
  const [serverId, setServerId] = useState('')
  const sorted = useMemo(
    () => (servers.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, intlLocale(i18n.language), { numeric: true })),
    [servers.data, i18n.language],
  )
  const m = useMutation({
    mutationFn: () => api.security.detectIp(serverId),
    onSuccess: (r) => {
      onDetected(r.ip)
      toast.success(t('panelKey.detect.found', { ip: r.ip }))
    },
    onError: (e) => toast.error(t('panelKey.detect.failed'), e),
  })
  if (servers.data?.length === 0) return <span className="dim small">{t('panelKey.detect.noServers')}</span>
  return (
    <div className="row-wrap">
      <select
        className="select select-sm"
        style={{ width: 240 }}
        value={serverId}
        onChange={(e) => setServerId(e.target.value)}
        aria-label={t('panelKey.detect.server')}
      >
        <option value="">{t('panelKey.detect.pick')}</option>
        {sorted.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} ({s.host})
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-sm" disabled={!serverId || m.isPending} onClick={() => m.mutate()}>
        {m.isPending ? <Spinner /> : <Crosshair size={13} />} {t('panelKey.detect.button')}
      </button>
    </div>
  )
}
