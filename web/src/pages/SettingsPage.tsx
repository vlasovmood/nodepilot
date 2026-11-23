import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Code2, KeyRound, Languages, Moon, Shield, Sun } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '../api/client'
import { LanguageSelect } from '../components/LanguageSelect'
import { Segmented } from '../components/Tabs'
import { useAuth } from '../features/auth/AuthGate'
import { UpdatesCard } from '../features/settings/UpdatesCard'
import { useTheme, type Theme } from '../lib/theme'

export function SettingsPage() {
  const { t } = useTranslation('settings')
  const { user } = useAuth()
  const [theme, setTheme] = useTheme()
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.health(), staleTime: 60_000 })

  return (
    <div className="page">
      <div className="page-header">
        <div className="title-block">
          <h1>{t('title')}</h1>
          <span className="muted small">
            <Trans t={t} i18nKey="subtitle" values={{ username: user.username }} components={{ b: <b /> }} />
            {health.data && <> · NodePilot {health.data.version}</>}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <Languages size={14} />
          <h3 className="grow">{t('language.title')}</h3>
        </div>
        <div className="card-body row">
          <LanguageSelect style={{ maxWidth: 260 }} />
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>{t('interface.title')}</h3>
        </div>
        <div className="card-body row">
          <span className="muted">{t('interface.theme')}</span>
          <Segmented<Theme>
            value={theme}
            onChange={setTheme}
            options={[
              {
                value: 'dark',
                label: (
                  <span className="row" style={{ gap: 5 }}>
                    <Moon size={13} /> {t('interface.dark')}
                  </span>
                ),
              },
              {
                value: 'light',
                label: (
                  <span className="row" style={{ gap: 5 }}>
                    <Sun size={13} /> {t('interface.light')}
                  </span>
                ),
              },
            ]}
          />
        </div>
      </div>

      <UpdatesCard />

      <div className="card">
        <div className="card-header">
          <Shield size={14} />
          <h3 className="grow">{t('security.title')}</h3>
        </div>
        <div className="card-body row-wrap">
          <span className="grow muted">{t('security.description')}</span>
          <Link className="btn btn-sm" to="/security">
            <Shield size={14} /> {t('security.open')} <ArrowRight size={14} />
          </Link>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <Code2 size={14} />
          <h3 className="grow">{t('tokens.title')}</h3>
        </div>
        <div className="card-body row-wrap">
          <span className="grow muted">{t('tokens.description')}</span>
          <Link className="btn btn-sm" to="/developer/tokens">
            <KeyRound size={14} /> {t('tokens.manage')} <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </div>
  )
}
