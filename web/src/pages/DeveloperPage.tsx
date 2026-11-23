import { BookOpen, Bot, Code2, KeyRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { Tabs, type TabDef } from '../components/Tabs'
import { McpTab } from '../features/developer/McpTab'
import { ReferenceTab } from '../features/developer/ReferenceTab'
import { TokensTab } from '../features/developer/TokensTab'
import { cx } from '../lib/util'

const TABS = ['tokens', 'reference', 'mcp'] as const
type Tab = (typeof TABS)[number]

const TAB_ICONS: Record<Tab, ReactNode> = {
  tokens: <KeyRound size={14} />,
  reference: <BookOpen size={14} />,
  mcp: <Bot size={14} />,
}

export function DeveloperPage() {
  const { t } = useTranslation('developer')
  const { tab: rawTab } = useParams()
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as Tab) : 'tokens'
  const navigate = useNavigate()
  const tabDefs: TabDef<Tab>[] = TABS.map((key) => ({ key, label: t(`page.tabs.${key}`), icon: TAB_ICONS[key] }))

  return (
    <div className={cx('page', tab === 'reference' && 'page-fill dev-ref')}>
      <div className="page-header">
        <div className="title-block">
          <h1>
            <Code2 size={17} /> {t('page.title')}
          </h1>
          <span className="muted small">{t('page.subtitle')}</span>
        </div>
      </div>
      <Tabs tabs={tabDefs} value={tab} onChange={(k) => navigate(`/developer/${k}`)} />
      {tab === 'tokens' && <TokensTab />}
      {tab === 'reference' && <ReferenceTab />}
      {tab === 'mcp' && <McpTab />}
    </div>
  )
}
