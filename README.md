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

| Variable                 | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`       | Google Cloud Web application OAuth client                 |
| `GOOGLE_CLIENT_SECRET`   | Matching server-only OAuth secret                         |
| `GOOGLE_REDIRECT_URI`    | Local callback or the deployed callback URL               |
| `APP_ORIGIN`             | Local or deployed origin without a trailing slash         |
| `GOOGLE_ALLOWED_EMAIL`   | Bootstrap administrator, normally `deveraajeam@gmail.com` |
| `OFFICIAL_CAREERS_EMAIL` | Official mailbox, normally `careers@daily-joe.com`        |
| `SESSION_SECRET`         | Random value of at least 32 characters                    |
| `TOKEN_ENCRYPTION_KEY`   | 32 random bytes encoded as 64 hexadecimal characters      |
| `DATABASE_URL`           | PostgreSQL/Neon connection URI; required on Vercel        |
| `DEMO_MODE`              | Keep `false` outside local development                    |
| `SOFT_LAUNCH_MODE`       | Keep `false` for the full workspace                       |
| `FULL_CAPACITY_MODE`     | Set `true` when the 100-record workspace is enabled       |
| `GOOGLE_SHEETS_ID`       | Optional spreadsheet ID for the dedicated tracker tab     |
| `GOOGLE_SHEETS_TAB`      | Optional tab name; defaults to `ATS Tracker`              |
| `AI_API_KEY`             | Reserved; no autonomous AI screening is enabled           |

Generate local secrets with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Google OAuth

Enable Gmail API in the Google Cloud project that owns the OAuth client. In Google Cloud Console, the client must be a **Web application** and its Authorized redirect URIs must include the exact `GOOGLE_REDIRECT_URI` below (no trailing slash). If the consent screen is in Testing, add every account that can sign in under **Audience → Test users**. Login requests identity scopes. Official Gmail connection requests `gmail.send`; applicant intake additionally requests `gmail.readonly`. The app validates PKCE, state, nonce, authorized users, and the authenticated account. OAuth secrets and refresh tokens remain server-side.

For the deployed app, register:

```text
https://<your-vercel-domain>/api/auth/callback
```

For local development, also register:

```text
http://localhost:3000/api/auth/callback
```

The personal administrator account is `deveraajeam@gmail.com` and displays as **Jeam**. The official mailbox is `careers@daily-joe.com` and displays as **Daily Joe Careers**. Authorize additional active users from Settings → Users & Permissions.

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

Copy the pooled Neon connection URI into Vercel as the production `DATABASE_URL`. Also configure the Google variables, `APP_ORIGIN`, `GOOGLE_REDIRECT_URI`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `DEMO_MODE=false`, `SOFT_LAUNCH_MODE=false`, and `FULL_CAPACITY_MODE=true`. After changing Vercel variables, redeploy. Both Google accounts then use the same Neon workspace, including applicant IDs, timelines, requirements, audit events, and tracker state.

## Gmail intake and export

The official Gmail flow is deliberately controlled:

1. Connect `careers@daily-joe.com` under Settings → Integrations.
2. Authorize applicant intake when read-only access is needed.
3. Preview the newest 40 messages matching the configured application query.
4. Verify the sender-derived name and map each message to an active hiring need.
5. Confirm the import; no applicant email is sent automatically.

The ATS is the source of truth. Every saved workspace change updates the server-held Excel tracker and attempts the configured one-way Google Sheets sync. Manual tracker sync has a confirmation dialog and loading state. Unrelated Gmail is excluded by the default attachment and application-subject filter; narrow the query before importing large mailboxes.

## Resume processing

PDF text is extracted with `pdf-parse`, DOCX text with `mammoth`, and TXT is decoded directly. PNG and JPG files are retained, displayed in the resume viewer, and OCR scanned with Tesseract when the runtime can load its language data. During a confirmed import, exact direct mentions of the mapped hiring need's configured qualifications are saved as advisory evidence; every missing or uncertain match remains **Unclear**, never **Not Met**. OCR output is advisory only. If OCR is inconclusive, the application clearly asks HR to review the original image and record evidence. The system never fabricates criteria or makes a hiring decision.

## Demo data

Local administrators can use the demo loader to create ten fictional records spanning the requested stages and statuses. Demo records are marked `source: Demo` and can be removed by the local demo control. No real applicant information is included in fixtures.

## Security and roles

Secrets, tokens, resume bytes, and extracted text are protected server-side. Sessions use random cookies with keyed hashes. PostgreSQL is required on Vercel; SQLite is rejected there. Consequential decisions, user access changes, imports, interview progression, rejection, and hiring require confirmation and are written to the audit history.

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

Automated tests do not send real email or import real applicants. A deliberate manual Gmail test remains required before enabling live intake.

## Current limitations

- Google Sheets requires its own spreadsheet ID and OAuth authorization.
- Existing downloaded Excel files do not update themselves; download the latest tracker or use Sheets sync.
- OCR quality depends on image resolution and runtime language-data availability; HR verification remains required.
- AI screening is not configured and never makes final hiring decisions.
- Production deployment requires Vercel environment variables and a reachable Neon PostgreSQL database.
