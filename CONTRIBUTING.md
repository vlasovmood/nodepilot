# Contributing

Thank you for helping improve NodePilot! This guide explains how the project is organized and how to send changes.
By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Found a bug?** Check whether an issue already exists. Include the version (`nodepilot --version`), the OS of the
  panel and the servers, steps to reproduce, expected and actual behavior, and logs (`journalctl -u nodepilot`)
  with secrets removed.
- **Found a vulnerability?** Don't open a public issue. See [SECURITY.md](SECURITY.md).
- **Want a new feature?** Discuss it in an issue first, so a finished PR doesn't need rework.

## Environment

- Rust 1.88+ (stable) and Node.js 22+.
- You can develop on Linux, macOS or Windows. Releases are built for Linux (musl).

```sh
cd web && npm install && npm run build && cd ..   # frontend (the binary embeds web/dist)
cargo run -- serve                                 # panel at http://127.0.0.1:7780
cd web && npm run dev                              # frontend with hot reload (proxies /api to 7780)
```

## Project layout

| Directory | Contents |
|---|---|
| `crates/nodepilot-core` | Database (SQLite, migrations in `migrations/`), access control, services, backups, graphs, updates |
| `crates/nodepilot-ssh` | SSH: connection pool, exec, PTY, SFTP, metric collection |
| `crates/nodepilot-web` | HTTP API, endpoint and permission catalog (`catalog.rs`), OpenAPI, WebSocket terminal |
| `crates/nodepilot-mcp` | MCP tools for AI agents |
| `crates/nodepilot` | Binary and CLI |
| `web/` | UI: React + TypeScript; translations in `web/src/i18n` |

## Rules for changes

- **New endpoint:** add it to `crates/nodepilot-web/src/catalog.rs` with the permissions it needs. Without a catalog
  entry, it is not reachable with API tokens. Request and response types must implement `JsonSchema`, because the
  OpenAPI spec is built from them.
- **New AI action:** add a tool in `crates/nodepilot-mcp/src/lib.rs` with its permission area and level.
- **Database schema change:** only through a new migration in `crates/nodepilot-core/migrations/`. Never edit
  existing migrations.
- **UI text:** only through i18n, added to every language at once (rules in `web/src/i18n/README.md`).
  If you don't know a language, use the English text and translators will fix it.
- **Secrets** must never reach logs, API responses or MCP output.
- Commands that run on servers must work on Ubuntu/Debian and must not break on other distributions.
  Pass every external value through `shell_quote` or strict validation.

## Checks before a PR

```sh
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test
cd web && npx tsc -b && npm run build && npx oxlint
```

## Pull requests

1. Fork the repository and branch off `main` (`fix/…`, `feat/…`).
2. Keep commits small and focused, with messages in the imperative mood: "Add graph export", "Fix SFTP upload limit".
3. In the PR, describe what changed, why, and how you tested it. For UI changes, add screenshots in both the dark and
   light themes.
4. Update the documentation (README, `docs/`) if behavior changed.

By submitting changes, you agree that they are distributed under the project's license, [Apache-2.0](LICENSE).
