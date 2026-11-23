//! Single source of truth for API endpoints: the permission middleware and the OpenAPI spec are built from it.

use nodepilot_core::access::{Area, Level};
use nodepilot_core::audit::{AuditEntry, AuditFilter, AuditSettings, AuditSettingsInput};
use nodepilot_core::backups::BackupKeyPair;
use nodepilot_core::backups::{BackupJob, BackupJobInput, BackupRun, RunFilter, Storage, StorageInput};
use nodepilot_core::files::DirListing;
use nodepilot_core::graphs::{EdgeInput, Graph, GraphEdge, GraphFilter, GraphInput, GraphNode, GraphSummary, NodeInput};
use nodepilot_core::models::*;
use nodepilot_core::panel_key::{DeployRequest, DetectIpRequest, DetectedIp, PanelKeyInfo, PanelKeyInput, ServerOpResult};
use nodepilot_core::security::SecurityStatus;
use nodepilot_core::ssh::ExecOutput;
use nodepilot_core::ssh::manage::{Process, Service};
use nodepilot_core::stats::{StatsPoint, StatsSnapshot};
use nodepilot_core::terminals::{OpenTerminal, ReadQuery, ResizeTerminal, TerminalInfo, TerminalInput, TerminalOutput};
use nodepilot_core::totp::{DisableTwoFactor, TotpCode, TotpSetup, TwoFactorStatus};
use nodepilot_core::updates::{InstallStatus, UpdateInfo, UpdateSettings, UpdateSettingsInput};
use schemars::{JsonSchema, Schema, SchemaGenerator};

use crate::api_types::*;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Access {
    Public,
    /// Any authenticated caller; the handler checks permissions itself.
    Authenticated,
    Scoped(Area, Level),
}

pub type SchemaFn = fn(&mut SchemaGenerator) -> Schema;

#[derive(Clone, Copy)]
pub enum Body {
    None,
    Json(SchemaFn),
    Binary,
}

#[derive(Clone, Copy)]
pub enum Reply {
    NoContent,
    Json(SchemaFn),
    Binary,
    WebSocket,
}

#[derive(Clone, Copy)]
pub struct Endpoint {
    pub method: &'static str,
    pub path: &'static str,
    pub group: &'static str,
    pub summary: &'static str,
    pub access: Access,
    pub query: Option<SchemaFn>,
    pub body: Body,
    pub reply: Reply,
}

fn s<T: JsonSchema>(g: &mut SchemaGenerator) -> Schema {
    g.subschema_for::<T>()
}

use Access::{Authenticated, Public, Scoped};
use Area::*;
use Level::{Read as R, Write as W};

macro_rules! ep {
    ($m:literal $p:literal, $g:literal, $acc:expr, $sum:literal $(, q = $q:ty)? $(, body = $b:ty)? $(, raw = $raw:ident)? => $reply:expr) => {
        Endpoint {
            method: $m,
            path: $p,
            group: $g,
            summary: $sum,
            access: $acc,
            query: ep!(@opt $($q)?),
            body: ep!(@body $($b)? $($raw)?),
            reply: $reply,
        }
    };
    (@opt) => { None };
    (@opt $q:ty) => { Some(s::<$q> as SchemaFn) };
    (@body) => { Body::None };
    (@body binary) => { Body::Binary };
    (@body $b:ty) => { Body::Json(s::<$b> as SchemaFn) };
}

macro_rules! json {
    ($t:ty) => {
        Reply::Json(s::<$t> as SchemaFn)
    };
}

const NC: Reply = Reply::NoContent;

pub static ENDPOINTS: &[Endpoint] = &[
    // ----- meta & auth -----
    ep!("GET" "/api/health", "Meta", Public, "Проверка, что панель работает" => json!(Health)),
    ep!("GET" "/api/openapi.json", "Meta", Public, "OpenAPI 3.1 спецификация этого API" => json!(serde_json::Value)),
    ep!("GET" "/api/auth/status", "Auth", Public, "Нужна ли первичная настройка и кто вошёл" => json!(AuthStatus)),
    ep!("POST" "/api/auth/setup", "Auth", Public, "Создать администратора (только пока нет пользователей)", body = Credentials => json!(LoginResponse)),
    ep!("POST" "/api/auth/login", "Auth", Public, "Вход по логину и паролю: токен сессии + cookie", body = Credentials => json!(LoginResponse)),
    ep!("POST" "/api/auth/logout", "Auth", Authenticated, "Завершить сессию" => NC),
    ep!("GET" "/api/auth/me", "Auth", Authenticated, "Текущий пользователь и права токена" => json!(Me)),
    ep!("POST" "/api/mcp", "AI", Authenticated, "MCP (JSON-RPC 2.0) для ИИ-агентов; инструменты фильтруются по правам токена", body = serde_json::Value => json!(serde_json::Value)),
    // ----- security -----
    ep!("GET" "/api/auth/2fa", "Security", Authenticated, "Состояние 2FA текущего пользователя" => json!(TwoFactorStatus)),
    ep!("POST" "/api/auth/2fa/setup", "Security", Authenticated, "Начать настройку 2FA: секрет и otpauth-ссылка для QR (только сессия)" => json!(TotpSetup)),
    ep!("POST" "/api/auth/2fa/enable", "Security", Authenticated, "Включить 2FA, подтвердив кодом; возвращает коды восстановления", body = TotpCode => json!(RecoveryCodes)),
    ep!("POST" "/api/auth/2fa/disable", "Security", Authenticated, "Выключить 2FA (пароль и код)", body = DisableTwoFactor => NC),
    ep!("POST" "/api/auth/2fa/recovery-codes", "Security", Authenticated, "Новые коды восстановления", body = TotpCode => json!(RecoveryCodes)),
    ep!("GET" "/api/security/status", "Security", Scoped(Admin, R), "Сводка безопасности панели" => json!(SecurityStatus)),
    ep!("GET" "/api/security/panel-key", "Security", Scoped(Admin, R), "Ключ панели: публичная часть, ограничения, строка authorized_keys" => json!(PanelKeyInfo)),
    ep!("POST" "/api/security/panel-key", "Security", Scoped(Admin, W), "Создать ключ панели", body = PanelKeyInput => json!(PanelKeyInfo)),
    ep!("PATCH" "/api/security/panel-key", "Security", Scoped(Admin, W), "Изменить адреса, с которых принимается ключ", body = PanelKeyInput => json!(PanelKeyInfo)),
    ep!("POST" "/api/security/panel-key/detect-ip", "Security", Scoped(Admin, W), "Определить адрес панели, каким его видит сервер", body = DetectIpRequest => json!(DetectedIp)),
    ep!("POST" "/api/security/panel-key/deploy", "Security", Scoped(Admin, W), "Установить ключ панели на серверы и переключить их на него", body = DeployRequest => json!(Vec<ServerOpResult>)),
    ep!("POST" "/api/security/panel-key/rotate", "Security", Scoped(Admin, W), "Заменить ключ панели новым на всех серверах" => json!(Vec<ServerOpResult>)),
    ep!("POST" "/api/security/panel-key/revoke", "Security", Scoped(Admin, W), "Аварийно убрать ключи панели с серверов" => json!(Vec<ServerOpResult>)),
    ep!("GET" "/api/audit", "Security", Scoped(Admin, R), "Журнал действий", q = AuditFilter => json!(Vec<AuditEntry>)),
    ep!("GET" "/api/audit/settings", "Security", Scoped(Admin, R), "Пересылка журнала (syslog, webhook) и срок хранения" => json!(AuditSettings)),
    ep!("PATCH" "/api/audit/settings", "Security", Scoped(Admin, W), "Изменить пересылку журнала", body = AuditSettingsInput => json!(AuditSettings)),
    ep!("POST" "/api/audit/test", "Security", Scoped(Admin, W), "Отправить тестовое событие в syslog/webhook" => json!(OkResult)),
    ep!("POST" "/api/backup-keys/generate", "Backups", Scoped(Backups, W), "Новая пара ключей age (приватный — один раз, не сохраняется)" => json!(BackupKeyPair)),
    // ----- system -----
    ep!("GET" "/api/system/version", "Meta", Authenticated, "Версия панели и платформа" => json!(VersionInfo)),
    ep!("GET" "/api/system/update", "Updates", Scoped(Admin, R), "Есть ли новая версия (refresh=1 — проверить сейчас)", q = RefreshQuery => json!(UpdateInfo)),
    ep!("PATCH" "/api/system/update/settings", "Updates", Scoped(Admin, W), "Настройки проверки обновлений", body = UpdateSettingsInput => json!(UpdateSettings)),
    ep!("POST" "/api/system/update/install", "Updates", Scoped(Admin, W), "Скачать, проверить и установить последнюю версию; затем панель перезапустится" => json!(InstallStatus)),
    ep!("GET" "/api/system/update/status", "Updates", Scoped(Admin, R), "Ход установки обновления" => json!(InstallStatus)),
    // ----- tokens -----
    ep!("GET" "/api/tokens", "Tokens", Scoped(Admin, R), "Список API-токенов" => json!(Vec<ApiToken>)),
    ep!("POST" "/api/tokens", "Tokens", Scoped(Admin, W), "Выпустить токен (секрет показывается один раз)", body = TokenInput => json!(CreatedToken)),
    ep!("PATCH" "/api/tokens/{id}", "Tokens", Scoped(Admin, W), "Изменить имя, права или срок действия токена", body = TokenInput => json!(ApiToken)),
    ep!("DELETE" "/api/tokens/{id}", "Tokens", Scoped(Admin, W), "Отозвать токен" => NC),
    // ----- projects -----
    ep!("GET" "/api/projects", "Projects", Scoped(Projects, R), "Список проектов" => json!(Vec<Project>)),
    ep!("POST" "/api/projects", "Projects", Scoped(Projects, W), "Создать проект", body = ProjectInput => json!(Project)),
    ep!("GET" "/api/projects/{id}", "Projects", Scoped(Projects, R), "Проект" => json!(Project)),
    ep!("PATCH" "/api/projects/{id}", "Projects", Scoped(Projects, W), "Изменить проект", body = ProjectInput => json!(Project)),
    ep!("DELETE" "/api/projects/{id}", "Projects", Scoped(Projects, W), "Удалить проект (серверы остаются)" => NC),
    ep!("PUT" "/api/projects/{id}/servers/{server_id}", "Projects", Scoped(Projects, W), "Добавить сервер в проект" => NC),
    ep!("DELETE" "/api/projects/{id}/servers/{server_id}", "Projects", Scoped(Projects, W), "Убрать сервер из проекта" => NC),
    // ----- identities -----
    ep!("GET" "/api/identities", "Identities", Scoped(Identities, R), "Связка ключей (без секретов)" => json!(Vec<Identity>)),
    ep!("POST" "/api/identities", "Identities", Scoped(Identities, W), "Добавить пароль или SSH-ключ", body = IdentityInput => json!(Identity)),
    ep!("GET" "/api/identities/{id}", "Identities", Scoped(Identities, R), "Ключ (без секрета)" => json!(Identity)),
    ep!("PATCH" "/api/identities/{id}", "Identities", Scoped(Identities, W), "Изменить ключ (секрет — только если передан)", body = IdentityInput => json!(Identity)),
    ep!("DELETE" "/api/identities/{id}", "Identities", Scoped(Identities, W), "Удалить ключ (409, если используется)" => NC),
    // ----- servers -----
    ep!("GET" "/api/servers", "Servers", Scoped(Servers, R), "Список серверов", q = ServerFilter => json!(Vec<Server>)),
    ep!("POST" "/api/servers", "Servers", Scoped(Servers, W), "Добавить сервер", body = ServerInput => json!(Server)),
    ep!("POST" "/api/servers/bulk", "Servers", Scoped(Servers, W), "Добавить много серверов (всё или ничего)", body = Vec<ServerInput> => json!(Vec<Server>)),
    ep!("GET" "/api/servers/{id}", "Servers", Scoped(Servers, R), "Сервер" => json!(Server)),
    ep!("PATCH" "/api/servers/{id}", "Servers", Scoped(Servers, W), "Изменить сервер", body = ServerInput => json!(Server)),
    ep!("DELETE" "/api/servers/{id}", "Servers", Scoped(Servers, W), "Удалить сервер из панели" => NC),
    ep!("POST" "/api/servers/{id}/test", "Servers", Scoped(Servers, R), "Проверить SSH-подключение" => json!(TestResult)),
    ep!("DELETE" "/api/servers/{id}/host-key", "Servers", Scoped(Servers, W), "Забыть закреплённый ключ хоста" => NC),
    ep!("GET" "/api/stats", "Stats", Scoped(Servers, R), "Последняя статистика всех серверов" => json!(Vec<StatsSnapshot>)),
    ep!("GET" "/api/servers/{id}/stats", "Stats", Scoped(Servers, R), "Статистика сервера" => json!(StatsSnapshot)),
    ep!("GET" "/api/servers/{id}/stats/history", "Stats", Scoped(Servers, R), "История метрик", q = HistoryQuery => json!(Vec<StatsPoint>)),
    // ----- exec & terminals -----
    ep!("POST" "/api/servers/{id}/exec", "Exec", Scoped(Exec, W), "Выполнить команду на сервере", body = ExecRequest => json!(ExecOutput)),
    ep!("POST" "/api/exec", "Exec", Scoped(Exec, W), "Выполнить команду на многих серверах", body = BulkExecRequest => json!(BulkExecResponse)),
    ep!("GET" "/api/servers/{id}/terminal", "Exec", Scoped(Exec, W), "Интерактивный терминал по WebSocket (бинарные кадры — данные, текстовые — JSON-команды)", q = TermQuery => Reply::WebSocket),
    ep!("GET" "/api/terminal-sessions", "Terminal sessions", Scoped(Exec, W), "Открытые терминальные сессии" => json!(Vec<TerminalInfo>)),
    ep!("POST" "/api/terminal-sessions", "Terminal sessions", Scoped(Exec, W), "Открыть постоянную терминальную сессию (PTY)", body = OpenTerminal => json!(TerminalInfo)),
    ep!("GET" "/api/terminal-sessions/{id}", "Terminal sessions", Scoped(Exec, W), "Сессия" => json!(TerminalInfo)),
    ep!("DELETE" "/api/terminal-sessions/{id}", "Terminal sessions", Scoped(Exec, W), "Закрыть сессию" => NC),
    ep!("POST" "/api/terminal-sessions/{id}/input", "Terminal sessions", Scoped(Exec, W), "Отправить ввод (и дождаться вывода)", body = TerminalInput => json!(TerminalOutput)),
    ep!("GET" "/api/terminal-sessions/{id}/output", "Terminal sessions", Scoped(Exec, W), "Прочитать вывод начиная со смещения", q = ReadQuery => json!(TerminalOutput)),
    ep!("POST" "/api/terminal-sessions/{id}/resize", "Terminal sessions", Scoped(Exec, W), "Изменить размер терминала", body = ResizeTerminal => json!(TerminalInfo)),
    // ----- system -----
    ep!("GET" "/api/servers/{id}/processes", "System", Scoped(System, R), "Процессы (топ-200 по CPU)" => json!(Vec<Process>)),
    ep!("POST" "/api/servers/{id}/processes/{pid}/kill", "System", Scoped(System, W), "Послать сигнал процессу", body = KillBody => NC),
    ep!("GET" "/api/servers/{id}/services", "System", Scoped(System, R), "systemd-сервисы" => json!(Vec<Service>)),
    ep!("GET" "/api/servers/{id}/services/{name}/logs", "System", Scoped(System, R), "Журнал сервиса", q = LogsQuery => json!(LogLines)),
    ep!("POST" "/api/servers/{id}/services/{name}/{action}", "System", Scoped(System, W), "start | stop | restart | reload | enable | disable" => json!(ExecOutput)),
    ep!("POST" "/api/servers/{id}/power", "System", Scoped(System, W), "Перезагрузка или выключение", body = PowerBody => NC),
    // ----- files -----
    ep!("GET" "/api/servers/{id}/files", "Files", Scoped(Files, R), "Содержимое каталога (по умолчанию — домашний)", q = ListQuery => json!(DirListing)),
    ep!("DELETE" "/api/servers/{id}/files", "Files", Scoped(Files, W), "Удалить файл или каталог (recursive=1)", q = DeleteQuery => NC),
    ep!("GET" "/api/servers/{id}/files/content", "Files", Scoped(Files, R), "Скачать файл (download=1 — как вложение)", q = DownloadQuery => Reply::Binary),
    ep!("PUT" "/api/servers/{id}/files/content", "Files", Scoped(Files, W), "Загрузить/перезаписать файл (тело — сырые байты, до 512 MiB)", q = UploadQuery, raw = binary => NC),
    ep!("POST" "/api/servers/{id}/files/mkdir", "Files", Scoped(Files, W), "Создать каталог", body = MkdirBody => NC),
    ep!("POST" "/api/servers/{id}/files/rename", "Files", Scoped(Files, W), "Переименовать/переместить", body = RenameBody => NC),
    // ----- notes -----
    ep!("GET" "/api/notes", "Notes", Scoped(Notes, R), "Заметки (фильтр по проекту/серверу)", q = NoteFilter => json!(Vec<Note>)),
    ep!("POST" "/api/notes", "Notes", Scoped(Notes, W), "Создать заметку", body = NoteInput => json!(Note)),
    ep!("GET" "/api/notes/{id}", "Notes", Scoped(Notes, R), "Заметка" => json!(Note)),
    ep!("PATCH" "/api/notes/{id}", "Notes", Scoped(Notes, W), "Изменить заметку (null отвязывает от проекта/сервера)", body = NoteInput => json!(Note)),
    ep!("DELETE" "/api/notes/{id}", "Notes", Scoped(Notes, W), "Удалить заметку" => NC),
    // ----- graphs -----
    ep!("GET" "/api/graphs", "Graphs", Scoped(Graphs, R), "Список графов", q = GraphFilter => json!(Vec<GraphSummary>)),
    ep!("POST" "/api/graphs", "Graphs", Scoped(Graphs, W), "Создать граф", body = GraphInput => json!(Graph)),
    ep!("GET" "/api/graphs/{id}", "Graphs", Scoped(Graphs, R), "Граф целиком (документ с нодами и связями)" => json!(Graph)),
    ep!("PATCH" "/api/graphs/{id}", "Graphs", Scoped(Graphs, W), "Изменить граф; с version — защита от перезаписи (409)", body = GraphInput => json!(Graph)),
    ep!("PUT" "/api/graphs/{id}", "Graphs", Scoped(Graphs, W), "То же, что PATCH", body = GraphInput => json!(Graph)),
    ep!("DELETE" "/api/graphs/{id}", "Graphs", Scoped(Graphs, W), "Удалить граф" => NC),
    ep!("POST" "/api/graphs/{id}/nodes", "Graphs", Scoped(Graphs, W), "Добавить ноду или заметку на холст", body = NodeInput => json!(GraphNode)),
    ep!("PATCH" "/api/graphs/{id}/nodes/{node_id}", "Graphs", Scoped(Graphs, W), "Изменить ноду", body = NodeInput => json!(GraphNode)),
    ep!("DELETE" "/api/graphs/{id}/nodes/{node_id}", "Graphs", Scoped(Graphs, W), "Удалить ноду вместе с её связями" => NC),
    ep!("POST" "/api/graphs/{id}/edges", "Graphs", Scoped(Graphs, W), "Соединить две ноды", body = EdgeInput => json!(GraphEdge)),
    ep!("PATCH" "/api/graphs/{id}/edges/{edge_id}", "Graphs", Scoped(Graphs, W), "Изменить связь", body = EdgeInput => json!(GraphEdge)),
    ep!("DELETE" "/api/graphs/{id}/edges/{edge_id}", "Graphs", Scoped(Graphs, W), "Удалить связь" => NC),
    // ----- backups -----
    ep!("GET" "/api/backup-storages", "Backups", Scoped(Backups, R), "Хранилища бекапов" => json!(Vec<Storage>)),
    ep!("POST" "/api/backup-storages", "Backups", Scoped(Backups, W), "Добавить хранилище (каталог панели или S3)", body = StorageInput => json!(Storage)),
    ep!("GET" "/api/backup-storages/{id}", "Backups", Scoped(Backups, R), "Хранилище" => json!(Storage)),
    ep!("PATCH" "/api/backup-storages/{id}", "Backups", Scoped(Backups, W), "Изменить хранилище", body = StorageInput => json!(Storage)),
    ep!("DELETE" "/api/backup-storages/{id}", "Backups", Scoped(Backups, W), "Удалить хранилище (409, если используется)" => NC),
    ep!("POST" "/api/backup-storages/{id}/test", "Backups", Scoped(Backups, W), "Проверить запись в хранилище" => json!(OkResult)),
    ep!("GET" "/api/backup-jobs", "Backups", Scoped(Backups, R), "Задания бекапа", q = JobsQuery => json!(Vec<BackupJob>)),
    ep!("POST" "/api/backup-jobs", "Backups", Scoped(Backups, W), "Создать задание", body = BackupJobInput => json!(BackupJob)),
    ep!("GET" "/api/backup-jobs/{id}", "Backups", Scoped(Backups, R), "Задание" => json!(BackupJob)),
    ep!("PATCH" "/api/backup-jobs/{id}", "Backups", Scoped(Backups, W), "Изменить задание", body = BackupJobInput => json!(BackupJob)),
    ep!("DELETE" "/api/backup-jobs/{id}", "Backups", Scoped(Backups, W), "Удалить задание" => NC),
    ep!("POST" "/api/backup-jobs/{id}/run", "Backups", Scoped(Backups, W), "Запустить бекап сейчас" => json!(BackupRun)),
    ep!("GET" "/api/backups", "Backups", Scoped(Backups, R), "История запусков", q = RunFilter => json!(Vec<BackupRun>)),
    ep!("GET" "/api/backups/{id}", "Backups", Scoped(Backups, R), "Запуск бекапа" => json!(BackupRun)),
    ep!("DELETE" "/api/backups/{id}", "Backups", Scoped(Backups, W), "Удалить архив" => NC),
    ep!("GET" "/api/backups/{id}/download", "Backups", Scoped(Backups, R), "Скачать архив (как хранится, зашифрованным)" => Reply::Binary),
];

pub fn find(method: &str, path: &str) -> Option<&'static Endpoint> {
    ENDPOINTS.iter().find(|e| e.method == method && e.path == path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_and_well_formed() {
        let mut seen = std::collections::HashSet::new();
        for e in ENDPOINTS {
            assert!(seen.insert((e.method, e.path)), "duplicate endpoint {} {}", e.method, e.path);
            assert!(e.path.starts_with("/api/"), "{}", e.path);
        }
    }
}
