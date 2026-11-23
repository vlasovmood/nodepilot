import { CheckCircle2, Cpu, MinusCircle, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { SecurityStatus } from '../../api/types'
import { Alert, Spinner } from '../../components/States'
import { Snippet } from '../developer/Snippet'

const SEAL_COMMAND = 'sudo /opt/nodepilot/packaging/seal-master-key.sh --backup-to /root/nodepilot-master.key.backup'
const BACKUP_COPY =
  'scp root@<panel-host>:/root/nodepilot-master.key.backup ./\nssh root@<panel-host> shred -u /root/nodepilot-master.key.backup'
const DOCKER_COMPOSE = `services:
  nodepilot:
    environment:
      NODEPILOT_MASTER_KEY_FILE: /run/secrets/nodepilot_master_key
    secrets:
      - nodepilot_master_key

secrets:
  nodepilot_master_key:
    file: ./nodepilot-master.key`

function Availability({ ok }: { ok: boolean }) {
  const { t } = useTranslation('security')
  return ok ? (
    <span className="ok-text row" style={{ gap: 4 }}>
      <CheckCircle2 size={13} /> {t('masterKey.available')}
    </span>
  ) : (
    <span className="dim row" style={{ gap: 4 }}>
      <MinusCircle size={13} /> {t('masterKey.unavailable')}
    </span>
  )
}

/** Where the master key (encrypts all stored secrets) lives, and how to seal it into the TPM. */
export function MasterKeyCard({ status }: { status: SecurityStatus | undefined }) {
  const { t } = useTranslation('security')
  const mk = status?.master_key
  return (
    <div className="card sec-anchor" id="sec-master-key">
      <div className="card-header">
        <Cpu size={14} />
        <h3 className="grow">{t('masterKey.title')}</h3>
        {mk &&
          (mk.kind === 'data-dir' ? (
            <span className="badge badge-warn">{t('masterKey.kind.data-dir')}</span>
          ) : (
            <span className="badge badge-ok">{t(`masterKey.kind.${mk.kind}`)}</span>
          ))}
      </div>
      <div className="card-body stack">
        {!status ? (
          <div className="row muted">
            <Spinner /> {t('common:state.loading')}
          </div>
        ) : (
          <>
            <div className="muted">{t('masterKey.intro')}</div>
            <dl className="kv">
              <dt>{t('masterKey.source')}</dt>
              <dd>{t(`masterKey.kindLong.${mk!.kind}`, { defaultValue: mk!.kind })}</dd>
              <dt>{t('masterKey.path')}</dt>
              <dd>
                <span className="mono" dir="ltr">
                  {mk!.path}
                </span>
              </dd>
              <dt>{t('masterKey.tpm')}</dt>
              <dd>
                <Availability ok={status.tpm_available} />
              </dd>
              <dt>{t('masterKey.systemdCreds')}</dt>
              <dd>
                <Availability ok={status.systemd_creds_available} />
              </dd>
            </dl>

            {mk!.kind === 'systemd-credential' && (
              <Alert kind="info" icon={<ShieldCheck size={15} className="ok-text" />}>
                {t('masterKey.sealedText')}
              </Alert>
            )}
            {mk!.kind === 'file' && <Alert kind="info">{t('masterKey.fileText')}</Alert>}
            {mk!.plaintext_copy_on_disk && (
              <Alert kind="warn" icon={<ShieldAlert size={15} />}>
                <Trans t={t} i18nKey="masterKey.plaintextCopy" components={{ b: <b /> }} />
              </Alert>
            )}

            {mk!.kind === 'data-dir' && (
              <>
                <Alert kind="warn" icon={<ShieldAlert size={15} />}>
                  {t('masterKey.dataDirWarning')}
                </Alert>
                <div className="stack-sm">
                  <h4 className="sec-subtitle">{t('masterKey.sealTitle')}</h4>
                  <ol className="sec-steps">
                    <li>{t('masterKey.steps.requirements')}</li>
                    <li>
                      <div className="stack-sm">
                        <span>{t('masterKey.steps.run')}</span>
                        <Snippet code={SEAL_COMMAND} hint={t('masterKey.steps.runHint')} />
                      </div>
                    </li>
                    <li>
                      <div className="stack-sm">
                        <span>{t('masterKey.steps.backup')}</span>
                        <Snippet code={BACKUP_COPY} />
                      </div>
                    </li>
                    <li>{t('masterKey.steps.check')}</li>
                  </ol>
                  {!status.tpm_available && <div className="muted small">{t('masterKey.noTpmHere')}</div>}
                </div>
                <div className="stack-sm">
                  <h4 className="sec-subtitle">{t('masterKey.dockerTitle')}</h4>
                  <div className="muted small">
                    <Trans t={t} i18nKey="masterKey.dockerText" components={{ code: <code /> }} />
                  </div>
                  <Snippet title="docker-compose.yml" code={DOCKER_COMPOSE} />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
