# Daily Joe Careers ATS

Internal recruitment operations workspace for Daily Joe. The application centralizes applicant intake, screening review, interviews, requirements, onboarding, hiring, talent pooling, reporting, notifications, and controlled Gmail communication.

## Stack

- Next.js 16, React 19, TypeScript, and a maintainable CSS design system
- Server-side API routes with role and origin checks
- SQLite for local development and PostgreSQL/Neon for shared deployments
- Gmail OAuth with least-privilege send and read-only intake scopes
- Excel tracker generation and optional one-way Google Sheets synchronization
- PDF, DOCX, TXT, PNG, and JPG resume handling; PNG/JPG OCR uses Tesseract when language data is available

## Local setup

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`. Local data is stored in `.data/` and is ignored by Git. Copy `.env.example` to `.env.local` and fill in server-only values. Never commit `.env.local`, OAuth JSON files, tokens, or database credentials.

## Environment variables

| Variable                 | Purpose                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `GOOGLE_CLIENT_ID`       | Google Cloud Web application OAuth client                                                                    |
| `GOOGLE_CLIENT_SECRET`   | Matching server-only OAuth secret                                                                            |
| `GOOGLE_REDIRECT_URI`    | Local callback or the deployed callback URL                                                                  |
| `APP_ORIGIN`             | Local or deployed origin without a trailing slash                                                            |
| `GOOGLE_ALLOWED_EMAIL`   | Bootstrap administrator, normally `deveraajeam@gmail.com`                                                    |
| `OFFICIAL_CAREERS_EMAIL` | Official mailbox, normally `careers@daily-joe.com`                                                           |
| `SESSION_SECRET`         | Random value of at least 32 characters                                                                       |
| `TOKEN_ENCRYPTION_KEY`   | 32 random bytes encoded as 64 hexadecimal characters                                                         |
| `CRON_SECRET`            | Server-only secret used by the background intake scheduler                                                   |
| `DATABASE_URL`           | PostgreSQL/Neon connection URI; required on Vercel                                                           |
| `GOOGLE_SHEETS_ID`       | Optional spreadsheet ID for the dedicated tracker tab                                                        |
| `GOOGLE_SHEETS_TAB`      | Optional tab name; defaults to `ATS Tracker`                                                                 |
| `ENABLE_DEMO_DATA`       | Set `true` to allow administrators to launch demos in production; local development permits demos by default |
| `GEMINI_API_KEY`         | Optional server-only Gemini credential for extraction fallback and explicit AI Assist                        |
| `GEMINI_MODEL`           | Configurable Flash-class model; defaults to `gemini-flash-latest`                                            |

Generate local secrets with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Google OAuth

Enable Gmail API in the Google Cloud project that owns the OAuth client. In Google Cloud Console, the client must be a **Web application** and its Authorized redirect URIs must include the exact `GOOGLE_REDIRECT_URI` below (no trailing slash). If the consent screen is in Testing, add every account that can sign in under **Audience → Test users**. Login requests identity scopes. Official Gmail connection requests `gmail.send` and `gmail.readonly` together with offline access. Personal Gmail testing requests send-only access. Existing encrypted refresh tokens are reused across logins; transient network failures do not discard authorization. The official connected badge requires a successful Gmail profile check. The app validates PKCE, state, nonce, authorized users, and the authenticated account. OAuth secrets and refresh tokens remain server-side.

For the deployed app, register:

```text
https://<your-vercel-domain>/api/auth/callback
```

For local development, also register:

```text
http://localhost:3000/api/auth/callback
```

The application identity is always **Daily Joe Careers**. User identity comes from the authenticated Google display name, with the assigned job title and permission role displayed separately. A mailbox or application name is never parsed into a person’s first name. Authorize additional active users from Settings → Account → Authorized Users.

## Neon and Vercel

The linked Neon project is `daily-joe-ats` (`lucky-darkness-03830349`) on the `production` branch. The repository contains [`neon.ts`](./neon.ts).

```powershell
npm i -g neon@latest
neon auth
neon projects list
neon branches list --project-id lucky-darkness-03830349
neon link --project-id lucky-darkness-03830349 --branch production -y
neon status
neon config init
neon deploy
```

Copy the pooled Neon connection URI into Vercel as the production `DATABASE_URL`. Also configure the Google variables, `APP_ORIGIN`, `GOOGLE_REDIRECT_URI`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, and (only if wanted) `ENABLE_DEMO_DATA=true`. After changing Vercel variables, redeploy. Both Google accounts then use the same Neon workspace, including applicant IDs, timelines, requirements, audit events, and tracker state.

## Gmail intake and export

Connect `careers@daily-joe.com` once under Settings → Integrations. Login, opening the workspace and real workflow changes schedule automatic intake. A database lease prevents overlapping workers. Each worker processes a bounded batch from a durable paginated Gmail queue, extracts resumes, creates applicants, screens configured qualifications and records one New Application notification per applicant. No email is sent by intake. A manual preview remains available for verified hiring-need assignment.

The active window contains the **latest 100 eligible production applicants**, with 20 rows per server-paginated page. Older eligible records remain in Queued. New arrivals continue to import when the window is full; closing an active record promotes the next newest queued record within the same transaction. Rejected, withdrawn, hired, talent-pool and archived applicants remain in history without consuming active capacity. Deduplication covers all history using message ID, thread ID, email and resume hash. Ambiguous position/location matches are left for HR review; they do not require inventing a hiring need.

### Background scheduling

`GET /api/cron/intake` requires `Authorization: Bearer <CRON_SECRET>`. Set a long random `CRON_SECRET` in the hosting environment. The included Vercel schedule runs daily, compatible with Hobby limits. For frequent intake when nobody has the app open, configure an authenticated external scheduler every five minutes, or change the Vercel cron schedule to `*/5 * * * *` on a plan that supports it. Vercel Hobby does not support sub-daily cron. Without a configured scheduler, live background polling runs while an authorized HR workspace is open, and login/workflow changes also trigger server work. Never expose the cron secret in browser code.

A run has a deadline, a recoverable lease, progress, a timestamp and retry state. Failed batches retry with a delay and move past unreadable messages after bounded attempts so one attachment cannot block the mailbox. A separate recent-message scan discovers new arrivals while the durable cursor processes older messages. Mailbox work continues independently of active-window membership. Disconnect stops subsequent imports. External scheduling and production deployment must be verified separately from a successful local build.

The ATS is the source of truth. Saved changes to real recruitment records update the Excel tracker and attempt one-way Google Sheets sync. Preference changes and demo operations do not trigger production synchronization. The dedicated tab gets a frozen, formatted header and filters; stable ID rows are replaced rather than appended, preventing duplicates. Demo and soft-deleted records are excluded. Manual tracker sync has a confirmation dialog and loading state. Unrelated Gmail is excluded by the default attachment and application-subject filter; narrow the query before importing large mailboxes.

## Workflow email delivery

An explicitly confirmed Proceed action atomically commits the stage transition and one rendered configured-stage email in an encrypted outbox. Repeated or concurrent submissions return the same transition/outbox record. Intake itself never emails applicants. Demo workflows cannot enqueue or send email.

The server validates recipients and placeholders before sending. Missing template values produce a visible failed delivery rather than an unresolved message. A bounded worker stores Gmail message/thread IDs and the actual sent timestamp. Applicant Email History and timeline links expose the rendered subject/body, recipient, sender, template, status and Gmail link. Safe known-before-send failures can retry without advancing the applicant again. Ambiguous delivery is marked Unconfirmed: check Gmail Sent by its stable RFC Message-ID before any new message. The app never automatically resends uncertain deliveries.

Settings → Email Templates supports editing and preview with fictional values. Stage advancement and delivery status are shown separately so a Gmail failure cannot masquerade as a delivered message.

## Resume processing

PDF text is extracted with `pdf-parse`, DOCX with `mammoth`, and TXT directly. Scanned PDF pages and PNG/JPG/JPEG files use Tesseract OCR. Original bytes and normalized extracted text are encrypted server-side. The viewer reports the extraction method, measured OCR confidence, and warnings without inventing a confidence score for ordinary text extraction. Files are limited to 8 MB and PDF processing to the first ten pages, with an explicit warning when truncated.

Empty documents show **Not Assessed**. Local evidence matching includes conservative role aliases and explicit duration checks. It uses only the assigned Hiring Need's configured qualifications and treats missing or uncertain evidence as **Unclear** unless that individual HR rule explicitly treats absence as failure. Negated direct matches require HR verification. Changing a hiring need or its criteria resets stale assessments.

Automatic **AI Integration** is a separate, configurable extraction fallback. Normal parsing and OCR run first. Missing identity, applied position, preferred branch, residence, low confidence or conflicting information can enqueue a durable extraction job when Gemini is configured and extraction is enabled. Exact submitted evidence must support every accepted value. HR-verified fields are protected, and source-version/run leases fence stale responses. Three bounded attempts and shared provider/rate-limit backoff prevent request storms. This can clarify applicant facts; it cannot change qualifications, stages or hiring decisions. Source labels distinguish submitted evidence, AI extraction and HR edits. Applied role, preferred work branch, residence and Hiring Need assignment stay separate.

Optional **AI Assist** uses the official Google GenAI SDK with one attempt per explicit request, structured JSON, exact-source evidence checks, server-only credentials and a 45-second provider timeout. It never runs during intake, profile views, searches, Gmail synchronization, template changes or System Analysis. Each applicant starts OFF. HR explicitly consents before sharing extracted text. Results are encrypted and stored separately from deterministic qualification results, keyed by source version and model. Unchanged results are cached; stale results are labeled; Re-run is explicit. A durable request claim fences concurrent requests and expired workers. Missing keys, quota failures, timeouts and invalid output leave recruitment data unchanged. See the [Google GenAI SDK](https://googleapis.github.io/js-genai/) and [structured output guide](https://ai.google.dev/gemini-api/docs/structured-output).

## Demo data and deletion

Settings → System → Launch Demo creates **five** fictional applicants and **three** hiring needs. Records carry a database-level `isDemo` marker and visible DEMO labels. Real and demo records have separate workspace views; a banner appears only while viewing Demo, with Exit Demo and confirmed Clear Demo Data. With Demo OFF, demo controls remain in Settings and the real workspace has no demo banner. Demo launch is idempotent, and clearing uses markers rather than names. Demo records cannot send recruitment emails, attach real resumes, or appear in production trackers.

Shared recruitment configuration is read-only while viewing Demo. Server-side demo updates reject changes to real records or shared settings. Appearance preferences remain available, and dates, interview times and monthly filters respect the selected workspace timezone.

Add Applicant creates an idempotent manual record. Authorized HR staff can edit contact details, assignment to a hiring need, and notes; existing workflow actions confirm stage/status changes. Edits preserve source identity and audit previous/new values. Real applicant deletion requires the exact ID and preserves history using `deletedAt`, `deletedBy`, and `deletionReason`. Administrators can restore records under Data Management. Demo deletion removes only marked demo recruitment records.

## Timekeeping

Timekeeping requires **Attendance (hr.attendance).xlsx** and **Pivot Worked Hours (hr.attendance).xlsx**, each up to 8 MB, 12,000 rows and 100 columns. The parser reads the raw clock columns and the Pivot employee/date hierarchy, excluding subtotal and total rows. The supplied September 1–15, 2026 files were used as the reference structure.

The employee-first view preserves every raw entry, Pivot row, expected-hour value, overtime field and discrepancy. Exact normalized names match; numbered variants require explicit HR alias confirmation. Employee IDs take precedence when present. Missing department, branch or schedule information stays unknown. Pivot expected hours take precedence over optional HR fallback rules. No default shift or global eight-hour day is invented. Overlap, missing punches, split shifts and unmatched dates remain visible for review.

Uploads and analyses use durable asynchronous jobs with progress, bounded worker leases and explicit retry. The browser can resume polling after navigation or refresh. Parsing and analysis yield between batches and run outside the shared workspace write transaction. Job coordination uses a separate database lock, and ordinary progress polling is read-only so it does not wait behind recruitment updates. Duplicate job execution and identical analysis output are fenced.

Each analysis stores encrypted source copies and results, SHA-256 fingerprints, uploader/time, cutoff, rules and version. An identical pair with identical rules returns the existing analysis and preserves reviews. Changed reports/rules produce a linked version. Preview access expires after 30 minutes; saved analyses are shared only with Admin, HR Generalist and Office Assistant roles. HR review status is separate from calculated results; updates require revision checks and create an audit event with old/new status, actor, time and note. XLSX and CSV exports preserve source references and review outcomes. Originals are never modified.

## Production workspace

There is no ten-applicant validation gate. Server-side transactions maintain the newest 100 active records and retain up to 500 eligible records across the active workspace and Queued intake, ordered newest first. Closed records remain in history and do not consume intake capacity. Deployment readiness still depends on validating configured external services; a successful local build does not certify live deployment. Demo Mode ON/OFF only controls the separate fictional dataset. HR retains final responsibility for recruitment and payroll review.

## Branding and themes

The supplied original images are preserved in `public/brand/`. The header logo retains the provided wordmark artwork; only the black matte becomes transparent. The favicon ICO and PNG sizes 16/32/48/64/192, plus the 180px Apple icon, are padded derivatives of that exact wordmark, with no generated replacement symbol. No PWA is currently configured. Semantic color tokens live in `app/polish.css`; light, dark, and system preferences use the same component structure.

## Security and roles

Secrets, tokens, resume bytes, and extracted text are protected server-side. Sessions use random cookies with keyed hashes. PostgreSQL is required on Vercel; SQLite is rejected there. Consequential decisions, user access changes, manual imports, interview progression, rejection, and hiring require confirmation and are written to the audit history.

Roles are intentionally clear:

- **Admin** — workspace configuration and user access
- **Talent Acquisition** — recruitment workflow and applicant communication
- **HR Generalist** — recruitment review and applicant communication
- **Office Assistant** — operational updates on assigned applicants
- **Viewer** — read-only access

## Checks

```powershell
npm run typecheck
npm test
npm run test:server
npm run test:smoke   # with the local server running
npm run build
npm run format:check
```

Automated tests do not send real email or import real applicants. Live Gmail checks are recorded separately from synthetic tests.

See [VALIDATION.md](./VALIDATION.md) for the current test results, browser walkthrough and deployment and integration requirements.

## Current limitations

- Google Sheets requires its own spreadsheet ID and OAuth authorization.
- Existing downloaded Excel files do not update themselves; download the latest tracker or use Sheets sync.
- OCR quality depends on image resolution and runtime language-data availability; HR verification remains required.
- AI Assist is optional, explicitly requested, and independent of System Analysis and Gmail.
- Production deployment requires Vercel environment variables and a reachable Neon PostgreSQL database.

## System operations

Settings → System provides System Health, Error Center and append-only Activity History. Checks include the active window, email outbox, AI extraction and Timekeeping jobs, with actual timestamps and actionable failures. Check Now performs bounded checks; unverified services are labeled explicitly. OCR package availability is not presented as a successful end-to-end OCR test. Application AI request counts are not provider quota.

Diagnostics use a fixed, sanitized category catalog. Repeated failures share one issue with occurrence history and linked audit events. Gmail workers retain their durable lease and stop automatic retries after three service failures. Individual unreadable attachments are flagged after bounded attempts and do not stop the remaining mailbox; authorization failures require human action. Manual AI Assist retries require HR action; automatic extraction retries only transient failures within its fixed attempt limit and provider backoff. No diagnostic action executes arbitrary code, SQL, schema repairs, environment changes, or recruitment decisions. An administrator can close an issue only with a verification note.

Audit history is generated on the server, indexed by time/entity/action, paginated at 25 events, and role-filtered. New events capture role and actor at the time of action. Older events retain their genuine timestamps and say “Not recorded” for unavailable role metadata. Deleting an applicant, including a demo record, does not delete audit history. Process-local fallback categories for database failures are bounded and contain no raw exceptions; they are flushed when a subsequent diagnostic check can persist them. They cannot guarantee durable reporting across process loss during a database outage; external infrastructure monitoring remains necessary.

Sample configurations are paused and clearly labeled. They do not represent approved production vacancies. Explicit evidence maintenance reads existing emails and resumes, fills only unverified fields and refreshes unreviewed deterministic analysis, preserving HR decisions. Positions and preferred work locations are extracted independently of active hiring needs; home addresses never become applied locations.
