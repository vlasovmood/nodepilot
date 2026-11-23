import { useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Lock, ShieldAlert, ShieldCheck, Unlock } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { qk, useServers, useStorages } from '../../api/queries'
import type { BackupEncryption, BackupJob, BackupJobInput, BackupSourceInput, DbSourceInput } from '../../api/types'
import { Field } from '../../components/Field'
import { Modal } from '../../components/Modal'
import { Alert, InlineError, Spinner } from '../../components/States'
import { Segmented } from '../../components/Tabs'
import { useToast } from '../../components/Toast'
import { CRON_PRESETS } from '../../lib/cron'
import { Snippet } from '../developer/Snippet'
import { cronErrorKey, describeSchedule, presetLabel } from './cronText'
import { isAgeRecipient, jobEncryption } from './encryption'
import { KeyPairDialog } from './KeyPairDialog'

type SourceType = 'files' | 'postgres' | 'mysql'
type ScheduleMode = 'manual' | 'preset' | 'custom'

export function JobDialog({
  open,
  onClose,
  job,
  serverId,
}: {
  open: boolean
  onClose: () => void
  job?: BackupJob | null
  /** Fix the server (when opened from a server page). */
  serverId?: string
}) {
  const { t } = useTranslation('backups')
  return (
    <Modal open={open} onClose={onClose} title={job ? t('job.title', { name: job.name }) : t('job.newTitle')} size="lg">
      {open && <JobForm key={job?.id ?? 'new'} job={job ?? null} fixedServerId={serverId} onClose={onClose} />}
    </Modal>
  )
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)

const DECRYPT_COMMAND = 'age -d -i nodepilot-backup-key.txt <archive>.age > <archive>'

function JobForm({ job, fixedServerId, onClose }: { job: BackupJob | null; fixedServerId?: string; onClose: () => void }) {
  const { t } = useTranslation('backups')
  const qc = useQueryClient()
  const toast = useToast()
  const servers = useServers()
  const storages = useStorages()

  const src = job?.source
  const db = src && src.type !== 'files' ? src : null

  const [name, setName] = useState(job?.name ?? '')
  const [serverId, setServerId] = useState(job?.server_id ?? fixedServerId ?? '')
  const [storageId, setStorageId] = useState(job?.storage_id ?? '')
  const [type, setType] = useState<SourceType>(src?.type ?? 'files')
  const [paths, setPaths] = useState(src?.type === 'files' ? src.paths.join('\n') : '/etc\n/var/www')
  const [excludes, setExcludes] = useState(src?.type === 'files' ? (src.excludes ?? []).join('\n') : '')
  const [database, setDatabase] = useState(db?.database ?? '')
  const [dbUser, setDbUser] = useState(db?.user ?? '')
  const [dbPassword, setDbPassword] = useState('')
  const [dbHost, setDbHost] = useState(db?.host ?? '')
  const [dbPort, setDbPort] = useState(db?.port ? String(db.port) : '')
  const [dbContainer, setDbContainer] = useState(db?.docker_container ?? '')

  const initialMode: ScheduleMode = !job
    ? 'preset'
    : !job.schedule
      ? 'manual'
      : CRON_PRESETS.some((p) => p.value === job.schedule)
        ? 'preset'
        : 'custom'
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(initialMode)
  const [preset, setPreset] = useState(job?.schedule && initialMode === 'preset' ? job.schedule : '0 0 3 * * *')
  const [customCron, setCustomCron] = useState(initialMode === 'custom' ? (job?.schedule ?? '') : '0 30 2 * * *')
  const [retention, setRetention] = useState(String(job?.retention ?? 7))
  const savedEncryption = job ? jobEncryption(job) : 'none'
  const [encryption, setEncryption] = useState<BackupEncryption>(savedEncryption)
  const [recipients, setRecipients] = useState((job?.recipients ?? []).join('\n'))
  const [keyDialog, setKeyDialog] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [passphrase2, setPassphrase2] = useState('')
  const [enabled, setEnabled] = useState(job?.enabled ?? true)
  /** Field → translation key of the validation message. */
  const [errors, setErrors] = useState<Record<string, string>>({})

  const schedule = scheduleMode === 'manual' ? null : scheduleMode === 'preset' ? preset : customCron.trim()
  const cronError = scheduleMode === 'custom' ? cronErrorKey(customCron) : null

  const buildSource = (): BackupSourceInput => {
    if (type === 'files') return { type, paths: lines(paths), excludes: lines(excludes) }
    const d: DbSourceInput = { database: database.trim() }
    if (dbUser.trim()) d.user = dbUser.trim()
    if (dbPassword) d.password = dbPassword
    if (dbHost.trim()) d.host = dbHost.trim()
    if (dbPort.trim()) d.port = Number(dbPort)
    if (dbContainer.trim()) d.docker_container = dbContainer.trim()
    return { type, ...d }
  }

  const validate = () => {
    const e: Record<string, string> = {}
    if (!name.trim()) e.name = 'job.errors.name'
    if (!serverId) e.server = 'job.errors.server'
    if (!storageId) e.storage = 'job.errors.storage'
    if (type === 'files' && lines(paths).length === 0) e.paths = 'job.errors.paths'
    if (type !== 'files' && !database.trim()) e.database = 'job.errors.database'
    if (dbPort && (!Number.isInteger(Number(dbPort)) || Number(dbPort) < 1 || Number(dbPort) > 65535)) e.port = 'job.errors.port'
    if (cronError) e.cron = cronError
    const r = Number(retention)
    if (!Number.isInteger(r) || r < 0) e.retention = 'job.errors.retention'
    const needPass = encryption === 'passphrase' && savedEncryption !== 'passphrase'
    if (needPass && passphrase.length < 8) e.passphrase = 'job.errors.passphrase'
    if (encryption === 'passphrase' && passphrase && passphrase.length < 8) e.passphrase = 'job.errors.passphrase'
    if (encryption === 'passphrase' && passphrase && passphrase !== passphrase2) e.passphrase2 = 'job.errors.passphrase2'
    if (encryption === 'recipients') {
      const keys = lines(recipients)
      if (keys.length === 0) e.recipients = 'job.errors.recipientsEmpty'
      else if (keys.some((k) => !isAgeRecipient(k))) e.recipients = 'job.errors.recipientsInvalid'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }
  const err = (field: string) => (errors[field] ? t(errors[field]) : undefined)

  const m = useMutation({
    mutationFn: () => {
      const body: BackupJobInput = {
        name: name.trim(),
        server_id: serverId,
        storage_id: storageId,
        source: buildSource(),
        schedule,
        retention: Number(retention),
        encryption,
        enabled,
      }
      if (encryption === 'passphrase' && passphrase) body.passphrase = passphrase
      if (encryption === 'recipients') body.recipients = lines(recipients)
      return job ? api.backups.updateJob(job.id, body) : api.backups.createJob(body)
    },
    onSuccess: (j) => {
      void qc.invalidateQueries({ queryKey: qk.jobs() })
      toast.success(job ? t('jobs.toast.saved') : t('jobs.toast.created'), j.name)
      onClose()
    },
  })

  return (
    <div className="stack">
      <div className="form-grid">
        <Field label={t('common:fields.name')} error={err('name')}>
          <input
            className="input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('job.fields.namePlaceholder')}
          />
        </Field>
        <Field label={t('common:fields.server')} error={err('server')}>
          <select className="select" value={serverId} onChange={(e) => setServerId(e.target.value)} disabled={!!fixedServerId}>
            <option value="">{t('job.fields.select')}</option>
            {servers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.host})
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={t('job.fields.storage')}
          error={err('storage')}
          hint={storages.data?.length === 0 ? t('job.fields.noStoragesHint') : undefined}
        >
          <select className="select" value={storageId} onChange={(e) => setStorageId(e.target.value)}>
            <option value="">{t('job.fields.select')}</option>
            {storages.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.kind === 's3' ? t('storages.kind.s3') : t('storages.kind.localShort')})
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('job.fields.retention')} error={err('retention')} hint={t('job.fields.retentionHint')}>
          <input
            className="input"
            inputMode="numeric"
            value={retention}
            onChange={(e) => setRetention(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
      </div>

      <Field label={t('job.fields.source')}>
        <div>
          <Segmented<SourceType>
            value={type}
            onChange={setType}
            options={[
              { value: 'files', label: t('job.sourceType.files') },
              { value: 'postgres', label: t('job.sourceType.postgres') },
              { value: 'mysql', label: t('job.sourceType.mysql') },
            ]}
          />
        </div>
      </Field>

      {type === 'files' ? (
        <div className="form-grid">
          <Field label={t('job.fields.paths')} error={err('paths')}>
            <textarea className="textarea mono" rows={4} value={paths} onChange={(e) => setPaths(e.target.value)} spellCheck={false} />
          </Field>
          <Field label={t('job.fields.excludes')}>
            <textarea
              className="textarea mono"
              rows={4}
              value={excludes}
              onChange={(e) => setExcludes(e.target.value)}
              placeholder={'*.log\nnode_modules'}
              spellCheck={false}
            />
          </Field>
        </div>
      ) : (
        <div className="form-grid">
          <Field label={t('job.fields.database')} error={err('database')}>
            <input className="input mono" value={database} onChange={(e) => setDatabase(e.target.value)} />
          </Field>
          <Field label={t('job.fields.container')} hint={t('job.fields.containerHint')}>
            <input
              className="input mono"
              value={dbContainer}
              onChange={(e) => setDbContainer(e.target.value)}
              placeholder={t('job.fields.optional')}
            />
          </Field>
          <Field label={t('job.fields.user')}>
            <input
              className="input mono"
              value={dbUser}
              onChange={(e) => setDbUser(e.target.value)}
              placeholder={type === 'postgres' ? 'postgres' : 'root'}
            />
          </Field>
          <Field
            label={t('job.fields.password')}
            hint={db?.has_password ? t('job.fields.passwordSaved') : t('job.fields.passwordServerOnly')}
          >
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={dbPassword}
              onChange={(e) => setDbPassword(e.target.value)}
              placeholder={db?.has_password ? '••••••••' : ''}
            />
          </Field>
          <Field label={t('job.fields.host')}>
            <input className="input mono" value={dbHost} onChange={(e) => setDbHost(e.target.value)} placeholder="localhost" />
          </Field>
          <Field label={t('job.fields.port')} error={err('port')}>
            <input
              className="input mono"
              inputMode="numeric"
              value={dbPort}
              onChange={(e) => setDbPort(e.target.value.replace(/\D/g, ''))}
              placeholder={type === 'postgres' ? '5432' : '3306'}
            />
          </Field>
        </div>
      )}

      <Field
        label={t('job.fields.schedule')}
        error={err('cron')}
        hint={schedule ? t('job.fields.scheduleHint', { expr: schedule }) : t('job.fields.manualHint')}
      >
        <div className="row-wrap">
          <Segmented<ScheduleMode>
            value={scheduleMode}
            onChange={setScheduleMode}
            options={[
              { value: 'preset', label: t('job.scheduleMode.preset') },
              { value: 'custom', label: t('job.scheduleMode.custom') },
              { value: 'manual', label: t('job.scheduleMode.manual') },
            ]}
          />
          {scheduleMode === 'preset' && (
            <select className="select" style={{ width: 300 }} value={preset} onChange={(e) => setPreset(e.target.value)}>
              {CRON_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {presetLabel(t, p.value)}
                </option>
              ))}
            </select>
          )}
          {scheduleMode === 'custom' && (
            <>
              <input
                className="input mono"
                style={{ width: 220 }}
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                placeholder="0 0 3 * * *"
              />
              {!cronError && <span className="dim small">{describeSchedule(t, customCron)}</span>}
            </>
          )}
        </div>
      </Field>

      <Field label={t('job.fields.encryption')}>
        <div className="enc-modes" role="radiogroup">
          {(['recipients', 'passphrase', 'none'] as const).map((mode) => (
            <label key={mode} className={encryption === mode ? 'enc-mode active' : 'enc-mode'}>
              <input type="radio" name="encryption" checked={encryption === mode} onChange={() => setEncryption(mode)} />
              <span className="enc-mode-icon">
                {mode === 'recipients' ? <ShieldCheck size={15} /> : mode === 'passphrase' ? <Lock size={15} /> : <Unlock size={15} />}
              </span>
              <span className="grow">
                <span className="enc-mode-title">{t(`job.encryption.${mode}`)}</span>
                <span className="dim small">{t(`job.encryption.${mode}Hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      {encryption === 'recipients' && (
        <div className="stack-sm">
          <Field label={t('job.fields.recipients')} error={err('recipients')} hint={t('job.fields.recipientsHint')}>
            <textarea
              className="textarea mono"
              dir="ltr"
              rows={3}
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"
              spellCheck={false}
              data-testid="recipients"
            />
          </Field>
          <div className="row-wrap">
            <button type="button" className="btn btn-sm" onClick={() => setKeyDialog(true)}>
              <KeyRound size={13} /> {t('job.keygen.button')}
            </button>
            <span className="dim small">{t('job.keygen.buttonHint')}</span>
          </div>
          <Snippet title={t('job.decryptTitle')} code={DECRYPT_COMMAND} hint={t('job.decryptHint')} />
        </div>
      )}

      {encryption === 'passphrase' && (
        <>
          <Alert kind="warn" icon={<ShieldAlert size={15} />}>
            <Trans
              t={t}
              i18nKey="job.passphraseWarning"
              values={{ command: 'age -d archive.age > archive' }}
              components={{ b: <b />, code: <code /> }}
            />
          </Alert>
          <div className="form-grid">
            <Field
              label={savedEncryption === 'passphrase' ? t('job.fields.newPassphrase') : t('job.fields.passphrase')}
              error={err('passphrase')}
              hint={savedEncryption === 'passphrase' ? t('job.fields.keepEmpty') : undefined}
            >
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </Field>
            <Field label={t('job.fields.passphrase2')} error={err('passphrase2')}>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={passphrase2}
                onChange={(e) => setPassphrase2(e.target.value)}
              />
            </Field>
          </div>
        </>
      )}

      {encryption === 'none' && <div className="muted small">{t('job.encryption.noneWarning')}</div>}

      <div className="stack-sm">
        <label className="checkbox">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('job.fields.enabled')}
        </label>
      </div>

      <InlineError error={m.error} />
      {keyDialog && (
        <KeyPairDialog
          onClose={() => setKeyDialog(false)}
          onAdd={(pub) => {
            const cur = lines(recipients)
            if (!cur.includes(pub)) setRecipients([...cur, pub].join('\n'))
            setKeyDialog(false)
            setErrors((cur) => {
              const next = { ...cur }
              delete next.recipients
              return next
            })
          }}
        />
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose} disabled={m.isPending}>
          {t('common:actions.cancel')}
        </button>
        <button className="btn btn-primary" disabled={m.isPending} onClick={() => validate() && m.mutate()}>
          {m.isPending && <Spinner />} {job ? t('common:actions.save') : t('common:actions.create')}
        </button>
      </div>
    </div>
  )
}
