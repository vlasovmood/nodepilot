import { useQuery } from '@tanstack/react-query'
import { ScrollText, Shield } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import { api } from '../api/client'
import { qk } from '../api/queries'
import { AuditSettingsCard } from '../features/security/AuditSettingsCard'
import { MasterKeyCard } from '../features/security/MasterKeyCard'
import { PanelKeyCard } from '../features/security/PanelKeyCard'
import { StatusOverview } from '../features/security/StatusOverview'
import { TwoFactorCard } from '../features/security/TwoFactorCard'
import { scrollToSection } from '../features/security/util'

export function SecurityPage() {
  const { t } = useTranslation('security')
  const status = useQuery({ queryKey: qk.securityStatus, queryFn: () => api.security.status() })
  const { hash } = useLocation()

  // /security#sec-2fa etc. — jump to the section once it is rendered.
  useEffect(() => {
    if (!hash) return
    const id = hash.slice(1)
    const timer = window.setTimeout(() => scrollToSection(id), 150)
    return () => window.clearTimeout(timer)
  }, [hash])

  return (
    <div className="page sec-page">
      <div className="page-header">
        <div className="title-block">
          <h1>
            <Shield size={17} /> {t('page.title')}
          </h1>
          <span className="muted small">{t('page.subtitle')}</span>
        </div>
        <div className="actions">
          <Link className="btn btn-sm" to="/audit">
            <ScrollText size={14} /> {t('page.openAudit')}
          </Link>
        </div>
      </div>
      <StatusOverview status={status} />
      <TwoFactorCard />
      <PanelKeyCard />
      <MasterKeyCard status={status.data} />
      <AuditSettingsCard />
    </div>
  )
}
