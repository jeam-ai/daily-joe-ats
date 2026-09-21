# Google Sheets persistence

Daily Joe Careers keeps its existing recruitment, Gmail, AI, Timekeeping, and audit workflows. `lib/server/database.ts` selects the persistence adapter; application code continues to use the same transactional repository contract.

## Storage ownership

- **Google Sheets** is the operational record store when `PERSISTENCE_PROVIDER=sheets`. Logical entities have separate tabs defined in `lib/sheets-schema.ts`. Stable keys update rows instead of appending duplicates. JSON columns preserve typed values and relationships; 30,000-character chunks avoid cell truncation.
- Position tabs, Positions, and Onboarding are formula views of canonical records. New positions create their own view. Timekeeping Exceptions is a named read model keyed by batch and employee-day, with the original encrypted analysis retained separately.
- **Private Google Drive storage** holds encrypted resumes, source messages, pending email bodies, AI results, authorization state, and isolated demo records. They never enter production workbook cells. For the careers account, `DJC_PRIVATE_FOLDER_ID` points to the existing `JEAM FILES` folder; gateway files must stay within that configured boundary. `TOKEN_ENCRYPTION_KEY` stays in server configuration, not Drive or Sheets.
- **Neon is preserved.** Selecting `local` or `sheets` does not connect to it, delete it, or change its schema. For the approved fresh start, no historic Neon records are claimed to have been recovered. Applicants start empty and Gmail intake stays paused.
- SQLite is a local development/source store and an in-memory query cache for the Sheets adapter. It is not a durable Vercel database. A remote commit must succeed before the application reports a saved change.

## One-time gateway setup

Use the official careers Google account. Create an Apps Script project containing `scripts/sheets-gateway/Code.gs` and its adjacent `appsscript.json`. The manifest enables the Sheets advanced service and Sheets/Drive access. The project must not be shared publicly.

In Project Settings → Script Properties:

1. Set `DJC_SPREADSHEET_ID` to the workbook selected in Data Management.
2. Set `DJC_PRIVATE_FOLDER_ID` to the approved private storage folder (`JEAM FILES` for the careers account). If it is omitted, `initializeStorage` creates a new private folder; production should use the approved existing folder instead. `initializeStorage` verifies workbook access. It does not change sharing permissions or create applicants.
3. Have the account owner set `DJC_SECRET` to a cryptographically random value of at least 32 characters. Configure the identical value as `SHEETS_GATEWAY_SECRET` on the application server. Do not put it in source code, a workbook cell, a public variable, or chat.
4. Deploy a Web app, executing as the careers account. The endpoint must be reachable by the application server. The owner must approve this access change. Every request requires a time-bounded HMAC; anonymous/forged requests are rejected before storage is read.
5. Set server-only `SHEETS_GATEWAY_URL` to the deployment's `/exec` URL. Keep `PERSISTENCE_PROVIDER=local` until verification completes.

### Private execution when Workspace blocks public web apps

Keep the organization's sharing restrictions. Use an **API Executable** deployment restricted to the careers account instead. The script and its storage OAuth client must use the same standard Google Cloud project inside the script owner's organization. A separate organization-owned storage project can coexist with the existing sign-in/Gmail project. Configure its client using `SHEETS_GATEWAY_CLIENT_ID` and `SHEETS_GATEWAY_CLIENT_SECRET`; do not replace the working login client. Google requires Project Browser and OAuth Config Editor (or equivalent) permissions to link that project; an administrator must enable the Apps Script API, Sheets API, and Drive API there. This does not require the account-wide Apps Script project-management access toggle.

Deploy the version containing `executeGateway`. After the owner approves the storage OAuth flow's Sheets and Drive scopes, configure `SHEETS_GATEWAY_DEPLOYMENT_ID` and the official account's `SHEETS_GATEWAY_REFRESH_TOKEN` in server-only environment configuration, alongside `SHEETS_GATEWAY_SECRET`. This bootstrap credential must remain outside Sheets because it is needed before the database can be opened. The server exchanges it for short-lived access tokens, calls the private executable, and still signs each payload with HMAC. Never copy tokens into chat, source code, browser variables, or spreadsheet cells. Keep the existing login client and callback intact.

The same migration verification gate applies to both transports. A configured endpoint or a successful OAuth grant alone does not authorize cutover; read-back verification must pass first.

## Copy, verify, and cut over

Data Management provides schema validation/repair, an operational copy, full verified migration, encrypted export, and a reviewed spreadsheet import. An operational copy alone is **not** a completed migration: private storage must also pass verification.

Migration creates and decrypt-verifies an encrypted source backup, validates IDs and relationships, copies all public and private entities, reads every field back, checks counts/duplicates, and compares the source snapshot. Unmigratable records are retained in Migration Issues and the source remains intact. No original records are deleted.

A persisted maintenance lease blocks source writes during migration. After successful verification the source stays frozen, preventing edits from being lost between verification and cutover. Set `PERSISTENCE_PROVIDER=sheets` and restart/redeploy. Verify sign-in, settings, and a deliberately isolated test workflow before enabling intake. **Cancel Cutover & Resume Source** is an explicit administrator recovery action; it preserves the destination and requires a new reviewed migration before a later cutover.

Gateway commits use a script lock, expected revision, and idempotency receipt. Private blobs and their manifest are immutable. One atomic Sheets batch publishes operational row changes and the new manifest pointer. An interrupted upload leaves unreferenced private files, not a partially committed database. There is no automatic destructive cleanup.

`manifest-*.json` files describe a committed revision. `private-batch-*.json` files appear only when protected records change and can contain several records in one batch. The manifest currently referenced by the workbook and every private batch it references are required for normal reads. Older unreferenced files are recovery artifacts from previous commits or interrupted staging. Do not remove them by filename alone; any future retention tool must first prove that a file is unreachable from the live manifest and preserve a reviewed recovery window.

## Backup and recovery

Export Database produces an encrypted backup, excluding credentials. Retain the server encryption key separately. Export Full Workbook preserves workbook structure, formulas and canonical data, but is not a substitute for private Drive files. Before imports, the application presents new/changed/unchanged counts, blocks changed previews and broken relationships, preserves append-only history, and saves a verified encrypted backup. Imports merge stable IDs and do not delete records.

Treat canonical workbook rows as application-managed data. Editing their display columns does not change canonical JSON. Manual corrections belong in Edit Applicant or a reviewed import. Do not move/remove canonical tabs or the gateway control cells in Sync Status and System Health. The application detects schema/integrity failures instead of inventing missing records.

## Deployment variables

Required on the server: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `APP_ORIGIN`, `GOOGLE_ALLOWED_EMAIL`, `OFFICIAL_CAREERS_EMAIL`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `PERSISTENCE_PROVIDER`, `SHEETS_GATEWAY_SECRET`. Private execution also requires `SHEETS_GATEWAY_DEPLOYMENT_ID`, `SHEETS_GATEWAY_REFRESH_TOKEN`, `SHEETS_GATEWAY_CLIENT_ID`, and `SHEETS_GATEWAY_CLIENT_SECRET`. Only the public web-app alternative uses `SHEETS_GATEWAY_URL`. Configure `CRON_SECRET` for scheduled intake. `GEMINI_API_KEY` and `GEMINI_MODEL` are optional. None is a `NEXT_PUBLIC_` credential. `DATABASE_URL` may remain an archival configuration value; the Sheets provider does not require it. Never deploy with `PERSISTENCE_PROVIDER=local`.

Google Sheets and Apps Script have provider quotas and execution limits. Status checks are cached, reads are loaded by entity, writes are batched, and failures have deadlines. A provider outage produces a recoverable error; the app does not silently fail over to a divergent local database.
