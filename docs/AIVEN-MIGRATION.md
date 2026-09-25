# Aiven PostgreSQL migration runbook

## Audited architecture

The application persists the workspace read model and normalized supporting
entities in PostgreSQL: applicants, applications, interviews, requirements,
screening, employment/onboarding, hiring needs, users, templates, locations,
notifications, activity logs, Gmail identity fields, and timekeeping analysis.
Gmail intake is durable and idempotent on Gmail message ID. Distinct messages
in the same thread remain distinct applications; matching applicant emails
reuse the stable applicant record, and identical resume files reuse the stored
document reference. Aiven starts with no imported applicants. Neon and the
corrupted Excel workbook are not migration sources. Existing Sheets/App Script
modules remain in the repository pending verified cutover; production rejects
`PERSISTENCE_PROVIDER=sheets`.

The previous implementation incorrectly treated 500 eligible applications as
an intake ceiling. The new policy accepts Gmail continuously, retains the newest
500 in the live queue, retains the newest 100 as the active HR view, and
evaluates older records for retention at scheduled cleanup time.

## Secure service configuration

Set these Vercel **server-only** variables. Never use a `NEXT_PUBLIC_` prefix:

```text
PERSISTENCE_PROVIDER=postgres
DATABASE_URL=<complete Aiven PostgreSQL service URI>
AIVEN_CA_CERT=<PEM CA certificate from the Aiven service overview>
CRON_SECRET=<long random secret>
```

The service URI must not be committed. `AIVEN_CA_CERT` is required for Aiven so
the Node pool verifies the server certificate; the application removes the
URI's `sslmode` parameter and applies the CA explicitly rather than falling
back to `rejectUnauthorized: false`.

For Vercel, use Aiven's PgBouncer URI as `DATABASE_POOL_URL` when the selected
Startup-or-higher plan has managed pooling enabled. The PgBouncer URI is
transaction-pooled. Free, Developer and Hobbyist plans do not include Aiven's
managed pooler; those tiers use a small two-connection per-instance client pool.

Before deploying, run this read-only preflight with the same environment:

```powershell
npm exec tsx scripts/aiven-preflight.ts
```

It reports the PostgreSQL server version, database bytes in use, configured
connection limit, TLS state, and availability/installation state of `pg_cron`,
`pg_stat_statements`, and `uuid-ossp`. Confirm the selected Aiven plan and its
allocated storage in Aiven Console: provider plan allocation is not exposed by
PostgreSQL SQL. Do not enable `pg_cron` for this project unless that check says
it is both available and installed; the Vercel cleanup route is the portable
default scheduler.

After confirming the endpoint is the intended empty Aiven service, initialize
the idempotent PostgreSQL tables/indexes/constraints with
`npm run db:aiven:init`. This creates schema only; it imports no applicants
and does not enable deletion.

## Cutover and verification

1. Configure all required server-only variables for the **Preview** deployment,
   including Google OAuth, authorized-user bootstrap, encryption and session
   secrets, `DATABASE_URL`, `AIVEN_CA_CERT`, and `PERSISTENCE_PROVIDER=postgres`.
   Keep `DRY_RUN_RETENTION_CLEANUP=true` and
   `RETENTION_CLEANUP_VERIFIED=false`. Variables scoped only to Production do
   not reach Preview. Redeploy Preview after changing them.
2. Deploy the Aiven implementation to Preview and confirm its schema is empty
   before controlled Gmail intake. Create authorized users through the existing
   setup flow. Do not import Neon or Excel applicant data.
3. Test controlled real Gmail intake, message-ID replay, distinct messages in
   one thread, resume retrieval, auth, roles, applications, interviews,
   requirements, onboarding, hiring needs, Talent Pool, reports, timekeeping,
   dashboard pagination, and retention dry runs. Check the resulting Aiven rows.
4. Confirm that new Gmail attachments are retrieved from Gmail at view time;
   PostgreSQL stores a source reference and extracted text, not new attachment
   bytes. Legacy resume bytes remain untouched until a separately verified
   cleanup decision.
5. Only after all Preview checks pass should production cutover be considered.
   Retire the legacy Sheets/App Script routes in a separate reviewed change.

## Retention jobs

`GET /api/cron/cleanup` runs daily, authenticated by `CRON_SECRET`. It is
idempotent and transactional. Permanent deletion remains disabled unless both
`DRY_RUN_RETENTION_CLEANUP=false` and `RETENTION_CLEANUP_VERIFIED=true` are set
after the documented QA. Default configurable policies are 10 days for
applications outside the live queue, rejected/withdrawn/no-response records and
expired hiring needs; 30 days plus a 10-day grace for talent-pool membership;
and 30 days for activity logs. Protected interview, onboarding, and hired
applications are never deleted by the queue cleanup. A record returning to the
newest 500 has its queue-retention timer cancelled.

Timekeeping asks HR to confirm payroll start/end dates because sparse source
reports may omit the edge days. One saved analysis exists per exact cutoff;
reanalysis replaces its prior result and reviews. Workbook bytes are removed
after parsing; encrypted parsed previews remain temporary until analysis.
