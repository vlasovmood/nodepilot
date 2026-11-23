import { Archive, CalendarClock, HardDrive, ShieldAlert } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { Alert } from '../components/States'
import { Tabs } from '../components/Tabs'
import { JobsSection, RunsSection } from '../features/backups/JobsAndRuns'
import { StoragesSection } from '../features/backups/Storages'

type Tab = 'jobs' | 'runs' | 'storages'

export function BackupsPage() {
  const { t } = useTranslation('backups')
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = raw === 'runs' || raw === 'storages' ? raw : 'jobs'

  return (
    <div className="page">
      <div className="page-header">
        <div className="title-block">
          <h1>{t('page.title')}</h1>
          <span className="muted small">{t('page.subtitle')}</span>
        </div>
      </div>
      <Alert kind="info" icon={<ShieldAlert size={15} />}>
        <Trans t={t} i18nKey="page.decryptInfo" values={{ command: t('page.decryptCommand') }} components={{ code: <code /> }} />
      </Alert>
      <Tabs<Tab>
        value={tab}
        onChange={(next) => setParams(next === 'jobs' ? {} : { tab: next }, { replace: true })}
        tabs={[
          { key: 'jobs', label: t('page.tabs.jobs'), icon: <CalendarClock size={14} /> },
          { key: 'runs', label: t('page.tabs.runs'), icon: <Archive size={14} /> },
          { key: 'storages', label: t('page.tabs.storages'), icon: <HardDrive size={14} /> },
        ]}
      />
      {tab === 'jobs' && <JobsSection />}
      {tab === 'runs' && <RunsSection title={t('page.allRuns')} />}
      {tab === 'storages' && <StoragesSection />}
    </div>
  )
}
