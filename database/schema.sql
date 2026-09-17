-- Soft-launch portable schema. Runtime initialization in lib/server/database.ts uses the same statements.
-- SQLite locally; PostgreSQL with DATABASE_URL. All mutations use one transaction.
-- records stores the workspace read model, encrypted auth state, import previews, email drafts and tracker workbook.
CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(collection,id));
CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, application_id TEXT, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resumes (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, mime TEXT NOT NULL, content TEXT NOT NULL, extracted_text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, active INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applicants (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hiring_needs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, applicant_id TEXT NOT NULL REFERENCES applicants(id), hiring_need_id TEXT REFERENCES hiring_needs(id), resume_id TEXT REFERENCES resumes(id), gmail_message_id TEXT UNIQUE, gmail_thread_id TEXT UNIQUE, stage TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS interviews (id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id), payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS application_requirements (id TEXT NOT NULL, application_id TEXT NOT NULL REFERENCES applications(id), payload TEXT NOT NULL, PRIMARY KEY(id,application_id));
CREATE TABLE IF NOT EXISTS screening_results (application_id TEXT PRIMARY KEY REFERENCES applications(id), payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS employment_records (application_id TEXT PRIMARY KEY REFERENCES applications(id), hired_at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS application_events (id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id), occurred_at TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS qualification_templates (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requirements (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS email_templates (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS locations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
