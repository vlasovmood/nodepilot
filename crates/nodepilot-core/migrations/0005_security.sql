-- none | passphrase | recipients. NULL on older rows: fall back to `encrypt`.
ALTER TABLE backup_jobs ADD COLUMN encryption TEXT;
ALTER TABLE backup_jobs ADD COLUMN recipients TEXT;

ALTER TABLE users ADD COLUMN totp_secret_enc TEXT;
ALTER TABLE users ADD COLUMN totp_pending_enc TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
-- JSON array of SHA-256 hashes of single-use recovery codes.
ALTER TABLE users ADD COLUMN recovery_codes TEXT;

CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    severity   TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    actor      TEXT NOT NULL,
    token      TEXT,
    ip         TEXT,
    action     TEXT NOT NULL,
    target     TEXT,
    details    TEXT,
    outcome    TEXT NOT NULL           -- 'ok' | 'denied' | 'error: …'
);
CREATE INDEX audit_log_ts ON audit_log(ts);
CREATE INDEX audit_log_actor ON audit_log(actor, ts);
