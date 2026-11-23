import i18n, { type BackendModule } from 'i18next'
import { initReactI18next } from 'react-i18next'

export type LangCode = 'ru' | 'en' | 'de' | 'fr' | 'zh' | 'ja' | 'ar'

export const LANGUAGES: { code: LangCode; name: string; rtl?: boolean }[] = [
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Русский' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'zh', name: '中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ar', name: 'العربية', rtl: true },
]

export const NAMESPACES = [
  'common',
  'format',
  'auth',
  'layout',
  'settings',
  'identities',
  'servers',
  'server',
  'files',
  'terminal',
  'projects',
  'graph',
  'backups',
  'notes',
  'exec',
  'developer',
  'security',
] as const

const STORAGE_KEY = 'np.lang'

const loaders = import.meta.glob<{ default: Record<string, unknown> }>('./locales/*/*.json')

const lazyBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(lng, ns, callback) {
    const load = loaders[`./locales/${lng}/${ns}.json`]
    if (!load) {
      callback(null, {})
      return
    }
    load()
      .then((m) => callback(null, m.default))
      .catch((e: unknown) => callback(e instanceof Error ? e : new Error(String(e)), null))
  },
}

function isLang(v: string | null | undefined): v is LangCode {
  return !!v && LANGUAGES.some((l) => l.code === v)
}

export function detectLanguage(): LangCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (isLang(saved)) return saved
  } catch {
    /* storage unavailable */
  }
  for (const l of navigator.languages ?? [navigator.language]) {
    const base = l.toLowerCase().split('-')[0]
    if (isLang(base)) return base
  }
  return 'en'
}

/** Arabic keeps Latin digits: easier to read for IPs, ports and percentages. */
export function intlLocale(lng: string = i18n.language): string {
  switch (lng) {
    case 'ar':
      return 'ar-u-nu-latn'
    case 'zh':
      return 'zh-CN'
    default:
      return lng || 'en'
  }
}

function applyDocumentLanguage(lng: string) {
  const rtl = LANGUAGES.find((l) => l.code === lng)?.rtl ?? false
  document.documentElement.lang = lng
  document.documentElement.dir = rtl ? 'rtl' : 'ltr'
}

export async function setLanguage(lng: LangCode): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, lng)
  } catch {
    /* storage unavailable */
  }
  await i18n.changeLanguage(lng)
}

export const i18nReady = i18n
  .use(lazyBackend)
  .use(initReactI18next)
  .init({
    lng: detectLanguage(),
    fallbackLng: 'en',
    supportedLngs: LANGUAGES.map((l) => l.code),
    ns: [...NAMESPACES],
    defaultNS: 'common',
    interpolation: { escapeValue: false }, // React escapes output itself
    returnNull: false,
    react: { useSuspense: true },
  })

i18n.on('languageChanged', applyDocumentLanguage)
applyDocumentLanguage(i18n.language || detectLanguage())

export default i18n
