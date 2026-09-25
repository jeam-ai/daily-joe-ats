-- Aiven PostgreSQL authoritative schema. Runtime initialization in
-- lib/server/database.ts uses compatible statements for local development.
-- records stores the workspace read model, encrypted auth state, import previews, email drafts and tracker workbook.
CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(collection,id));
CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, application_id TEXT, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resumes (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, mime TEXT NOT NULL, content TEXT NOT NULL, extracted_text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resume_sources (resume_id TEXT PRIMARY KEY REFERENCES resumes(id), provider TEXT NOT NULL, gmail_message_id TEXT, gmail_attachment_id TEXT, drive_file_id TEXT, source_url TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, active INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applicants (id TEXT PRIMARY KEY, email TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS applicants_email_idx ON applicants(email);
CREATE TABLE IF NOT EXISTS hiring_needs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, applicant_id TEXT NOT NULL REFERENCES applicants(id), hiring_need_id TEXT REFERENCES hiring_needs(id), resume_id TEXT REFERENCES resumes(id), gmail_message_id TEXT UNIQUE, gmail_thread_id TEXT, stage TEXT NOT NULL CHECK(stage IN ('Screening','Initial Interview','Final Interview','Requirements','Onboarding','Hired')), status TEXT NOT NULL CHECK(status IN ('New','For Review','Approved','In Progress','Hired','Rejected','Withdrawn','No Response','Talent Pool')), payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS applications_thread_idx ON applications(gmail_thread_id);
CREATE TABLE IF NOT EXISTS talent_pool_memberships (applicant_id TEXT PRIMARY KEY REFERENCES applicants(id), started_at TEXT NOT NULL, expires_at TEXT NOT NULL, grace_expires_at TEXT NOT NULL, updated_by TEXT);
CREATE INDEX IF NOT EXISTS talent_pool_membership_expiry_idx ON talent_pool_memberships(grace_expires_at);
CREATE TABLE IF NOT EXISTS intake_window (application_id TEXT PRIMARY KEY REFERENCES applications(id), state TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS intake_window_order ON intake_window(state,received_at,application_id);
CREATE TABLE IF NOT EXISTS application_retention (application_id TEXT PRIMARY KEY REFERENCES applications(id), category TEXT NOT NULL, started_at TEXT NOT NULL, expires_at TEXT NOT NULL, reason TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS application_retention_expiry_idx ON application_retention(expires_at,category);
CREATE TABLE IF NOT EXISTS hiring_need_retention (hiring_need_id TEXT PRIMARY KEY REFERENCES hiring_needs(id), started_at TEXT NOT NULL, expires_at TEXT NOT NULL, reason TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS hiring_need_retention_expiry_idx ON hiring_need_retention(expires_at);
CREATE TABLE IF NOT EXISTS retention_policies (name TEXT PRIMARY KEY, days INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS retention_cleanup_metrics (month TEXT NOT NULL, metric TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(month,metric));
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
