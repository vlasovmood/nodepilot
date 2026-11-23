# NodePilot Web UI

The NodePilot panel's web interface: Vite + React 19 + TypeScript (strict), react-router, TanStack Query / Virtual,
xterm.js, CodeMirror 6, uPlot, React Flow and i18next. It ships in 7 languages (see `src/i18n/README.md`) and
uses the dark theme by default (switchable in the sidebar and settings).

API contract: [`../docs/API.md`](../docs/API.md). All types live in `src/api/types.ts`, and the typed client is
`src/api/client.ts`.

## Commands

```sh
npm install          # dependencies
npm run dev          # dev server at http://localhost:5173; /api (including WebSocket) is proxied to http://127.0.0.1:7780
npm run build        # type check (tsc -b) + build into web/dist
npm run typecheck    # type check only
npm run lint         # oxlint
npm run preview      # serve the built dist locally
```

To point the dev proxy at another backend: `NODEPILOT_BACKEND=http://host:port npm run dev`.

## Build and embedding

`npm run build` writes static files to `web/dist` (base `/`, assets under `/assets/*`).
The Rust binary embeds this directory and serves `index.html` for any unknown path (SPA).
Frontend routes: `/servers`, `/servers/:id[/:tab]`, `/projects/:id`, `/graphs[/:id]`, `/identities`, `/backups`,
`/notes`, `/exec`, `/developer[/:tab]`, `/security`, `/audit`, `/settings`.

## Layout

```
src/
  api/          types.ts (contract), client.ts (fetch client), queries.ts (react-query hooks and keys)
  components/   shared UI components: Modal, Toast, Confirm, Menu, Tabs, Meter, TimeChart, Logo, …
  layout/       AppLayout, Sidebar, Topbar (global search, Ctrl+K)
  features/
    auth/       status, login (with 2FA), first-run setup
    servers/    virtualized table, add/import/bulk action dialogs
    server/     server page tabs: overview, terminal, files, processes, services, backups
    exec/       running commands on many servers
    notes/      Markdown notes
    graph/      infrastructure graph editor
    backups/    storages, jobs, run history, encryption keys
    projects/   project dialog
    identities/ keychain
    developer/  API section: tokens, endpoint reference, MCP
    security/   2FA, panel SSH key, master key, audit log
    settings/   settings and updates
  i18n/         i18next setup and translations
  pages/        route pages
  lib/          formatting, theme, cron presets, utilities
  styles.css    global styles and theme tokens
```
