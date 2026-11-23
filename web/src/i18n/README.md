# UI localization

Libraries: [i18next](https://www.i18next.com/) + [react-i18next](https://react.i18next.com/).
Languages: `en` (source and fallback), `ru`, `de`, `fr`, `zh`, `ja`, `ar` (RTL).

## Files

```
src/i18n/index.ts                 setup, language list (LANGUAGES), NAMESPACES, setLanguage(), intlLocale()
src/i18n/locales/<lang>/<ns>.json translations: one file per namespace
```

Namespaces (`NAMESPACES` in index.ts): `common`, `format`, `auth`, `layout`, `settings`, `identities`, `files`, `terminal`,
`servers`, `server`, `projects`, `graph`, `backups`, `notes`, `exec`, `developer`, `security` (the Security and Audit log pages).
To add a namespace, add it to `NAMESPACES` and create its file in **every** language.

## Rules

1. **No user-facing text in code.** Everything a person sees (headings, buttons, hints, `placeholder`, `title`,
   `aria-label`, toast and confirmation texts, validation messages) goes through `t()`.
   Not translated: names from the API (servers, projects), commands, paths, JSON, codes, API field names, and formats
   such as `5432/tcp`.
2. In components:
   ```tsx
   const { t } = useTranslation('servers')            // the component's own namespace
   t('table.cpu')                                      // key from servers.json
   t('common:actions.save')                            // shared key
   ```
   Outside React (utilities, models): `import i18n from '../i18n'` → `i18n.t('ns:key')`.
   For labels declared as module-level constants (role lists, presets), store **keys** (`labelKey: 'roles.db'`) and
   translate them at render time. Otherwise the language won't switch without a reload.
3. **Keys** are English and describe meaning and place: `dialog.title`, `toast.saved`, `confirm.deleteMessage`.
   Nest with JSON objects, not dots in the key name.
4. **Interpolation:** `t('toast.deleted', { name })` → `"Server {{name}} deleted"`. Don't build sentences from
   pieces, because word order differs between languages. For markup inside a sentence, use
   `<Trans i18nKey="..." components={{ b: <b /> }} />` with `"Server <b>{{name}}</b> will be deleted"`.
5. **Plurals** only through `count`:
   ```json
   "servers_one": "{{count}} server", "servers_other": "{{count}} servers"
   ```
   `t('servers', { count: n })`. Forms per language (Intl.PluralRules): en/de/fr use `one` and `other`; ru uses `one`,
   `few`, `many` and `other`; ar uses `zero`, `one`, `two`, `few`, `many` and `other`; zh/ja use only `other`.
   The `countRu`/`pluralRu` helpers are deprecated.
6. **Dates, numbers, sizes and durations** only through the functions in `lib/format.ts` (they are already localized).
   Don't use `toLocaleString('ru-RU')` and don't write units ("MB", "ms") by hand.
7. Code, paths, IPs, commands and JSON must stay left-to-right in the RTL UI: wrap them in an element with `dir="ltr"`
   (CSS already does this for `.mono`, `code`, `pre`, the terminal and the editor).
8. Add new strings to every language at once. If a translation isn't ready yet, copy the English text: missing keys
   would show in English anyway, but this makes untranslated strings easier to find.
