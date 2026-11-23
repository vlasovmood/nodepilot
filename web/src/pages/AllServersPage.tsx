import { LayoutGrid } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useServers } from '../api/queries'
import { ServersView } from '../features/servers/ServersView'

export function AllServersPage() {
  const { t } = useTranslation('servers')
  const servers = useServers()
  return (
    <div className="page page-fill">
      <div className="page-header">
        <div className="title-block">
          <h1>
            <LayoutGrid size={17} /> {t('page.title')}
          </h1>
          <span className="muted small">{servers.data ? t('page.count', { count: servers.data.length }) : ' '}</span>
        </div>
      </div>
      <ServersView />
    </div>
  )
}
