import { Compass } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Empty } from '../components/States'

export function NotFoundPage() {
  const { t } = useTranslation('layout')
  return (
    <div className="page">
      <Empty icon={<Compass size={30} />} title={t('notFound.title')}>
        <Link to="/servers" className="btn">
          {t('notFound.toServers')}
        </Link>
      </Empty>
    </div>
  )
}
