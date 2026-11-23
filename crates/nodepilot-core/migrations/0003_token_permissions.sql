-- NULL means full access (sessions and tokens issued before permissions existed).
ALTER TABLE tokens ADD COLUMN permissions TEXT;
