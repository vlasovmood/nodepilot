import { useQuery } from '@tanstack/react-query'
import { Download, Plus, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { CopyButton } from '../../components/CopyButton'
import { Modal } from '../../components/Modal'
import { Alert, InlineError, Loading } from '../../components/States'
import { downloadText } from '../../lib/util'

export const KEY_FILE_NAME = 'nodepilot-backup-key.txt'

/**
 * Generates an age key pair for backups. The private key is shown here once — the panel does not store it;
 * only the public key goes into the job.
 */
export function KeyPairDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (publicKey: string) => void }) {
  const { t } = useTranslation('backups')
  const [saved, setSaved] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  // A query, not a mutation-in-effect, so a re-render never generates a second pair behind the user's back.
  const pair = useQuery({
    queryKey: ['backup-keypair'],
    queryFn: () => api.backups.generateKey(),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const k = pair.data

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('job.keygen.title')}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!k || !saved} onClick={() => k && onAdd(k.public_key)}>
            <Plus size={14} /> {t('job.keygen.add')}
          </button>
        </>
      }
    >
      {pair.isPending ? (
        <Loading />
      ) : pair.isError ? (
        <InlineError error={pair.error} />
      ) : (
        <div className="stack">
          <Alert kind="danger" icon={<ShieldAlert size={15} />}>
            {t('job.keygen.warning')}
          </Alert>
          <div className="stack-sm">
            <span className="field-label">{t('job.keygen.privateKey')}</span>
            <div className="token-reveal" data-testid="age-private-key">
              <span className="grow">{k!.private_key}</span>
              <CopyButton text={k!.private_key} />
            </div>
            <div className="row-wrap">
              <button
                className="btn"
                onClick={() => {
                  downloadText(KEY_FILE_NAME, k!.identity_file)
                  setDownloaded(true)
                  setSaved(true)
                }}
              >
                <Download size={14} /> {t('job.keygen.download', { file: KEY_FILE_NAME })}
              </button>
              {downloaded && <span className="ok-text small">{t('job.keygen.downloaded')}</span>}
            </div>
          </div>
          <div className="stack-sm">
            <span className="field-label">{t('job.keygen.publicKey')}</span>
            <div className="copy-value" data-testid="age-public-key">
              <code>{k!.public_key}</code>
              <CopyButton text={k!.public_key} />
            </div>
            <span className="dim small">{t('job.keygen.publicHint')}</span>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            {t('job.keygen.savedCheck')}
          </label>
        </div>
      )}
    </Modal>
  )
}
