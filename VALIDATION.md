# Daily Joe Careers — production implementation validation

September 20, 2026. The latest user-supplied specifications supersede the earlier soft-launch requirements. Soft-launch UI and the ten-applicant gate have been removed. This record distinguishes implementation, observed results and outstanding deployment configuration.

## Automated checks

| Check              | Result                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Production build   | Pass — Next.js 16.3.5, TypeScript and all routes                                                      |
| Unit tests         | 44 passed                                                                                             |
| Server tests       | 33 passed in isolated temporary databases                                                             |
| API smoke checks   | Protected pages/APIs, cross-origin requests, OAuth state and scheduler authentication pass            |
| Formatting         | Prettier passes                                                                                       |
| Client secret scan | Configured secrets checked against production client scripts and versionable source files; no matches |
| Dependency audit   | 0 known production dependency vulnerabilities reported by npm audit                                   |
| Branding endpoints | Source-derived logo, ICO and PNG icons return HTTP 200 with image content types                       |

Coverage includes workflow confirmation and audit; demo isolation; soft deletion/restoration; role checks; encrypted tokens/documents; PDF/DOCX extraction; document deadlines; evidence validation; missing evidence; theme contrast; applicant history/deduplication; Sheets formatting; and two-file attendance reconciliation.

The intake regression imports beyond 100 fictional applicants, retains closed history and verifies 100 active records plus the older queue. A separate test verifies newest-first membership, promotion after closing a record, indexed 20-row pagination, escaped search and concurrent-worker isolation. Notification identity and deduplication remain stable, with no intake mail-send calls. A damaged-attachment regression verifies that after three bounded attempts the issue remains visible while other mailbox work continues; it no longer pauses all intake. Saving an old preferences form preserves newly imported recruitment data. Invalid preferences and unauthorized Gmail-filter changes are rejected.

Attendance regressions cover hierarchical Pivot parsing, source precision, explicitly confirmed aliases, split/overlapping clocks, missing punches, unknown schedules, independently configured late/early-out rules and numeric tolerance. Review changes record actor/time/note/previous/new values; stale reviews fail safely. Reuploading identical reports/rules reuses the analysis and reviews. Changed rules or analysis versions retain linked prior versions. CSV/XLSX retain review data and label clocks with the configured timezone.

## Live Gmail observed locally

- The official connection was verified against the actual Gmail profile endpoint and persisted across local server restarts.
- Automatic intake continued beyond **100 real Gmail applications** in the private database. A live observation verified **100 active and 69 queued**; the number can increase as intake continues. The active window remains at 100 while older records stay accessible in Queued. After maintenance, the browser confirmed another five imports and resumed automatic checking.
- Message/thread IDs, resume hashes and applicant email prevent repeated imports across retained history.
- An actual image resume displayed extracted text, measured 71% OCR confidence and an explicit HR-review warning.
- Imported records receive one stable New Application Received event with an applicant link and useful summary.
- Exactly one clearly labeled controlled test email was sent to the explicitly designated `deveraajeam@gmail.com` recipient through the application's test action. Gmail read-back verified the Sent label, Daily Joe Careers sender branding, recipient and matching thread. Inbox delivery was not independently confirmed. No real applicant was emailed, rejected, deleted or advanced for testing.
- The separate `TEST / DEMO — Jeam De Vera` record contains the confirmed message/thread IDs, Gmail link and test activity. It remains excluded from the real 100-applicant workspace and production tracker.

The live workspace now includes editable sample position/qualification templates and three clearly labeled, paused sample Hiring Needs. They do not represent approved vacancies. Evidence maintenance refreshed 169 real imported applications: 128 have submitted position evidence and 23 have preferred-work-location evidence. This is extracted evidence, not a claim that HR has verified every field. The refresh preserves HR-verified fields and records changes. Explicit residence evidence stays separate. Remaining unknown or conflicting fields require HR review. Existing stages, statuses, interviews and requirements were verified unchanged. Document-extraction warnings are linked to Diagnostics and applicant activity; unreadable or unsupported attachments remain flagged for review. No document issue was marked resolved without successful processing.

Gemini is configured server-side. An earlier model-access check and fictional structured-response request succeeded. In this pass, the latest brief enables automatic extraction fallback for incomplete newly imported applicants. Those jobs attempted provider requests using available submitted evidence. A separate fictional probe confirmed HTTP 503/high demand, and a later automatic extraction request recorded a rate-limit response. Extraction errors are recorded, applicant data and System Analysis remain usable, and a shared five-minute provider backoff now prevents repeated requests across the queue. Rate limits use a one-hour backoff. Live successful fallback is not claimed while provider failures/backoff remain active. Google Sheets destination/authorization remains unconfigured, so live spreadsheet synchronization is still unverified.

## Optional AI Assist and operations

- System Analysis remains deterministic and authoritative. Automatic AI Integration extraction is separate from manual AI Assist and runs only for eligible missing/uncertain submitted information when enabled. Navigation, profile reads, search, System Analysis, qualification edits and Timekeeping do not themselves request AI. AI Assist starts OFF and requires an explicit HR request and confirmation.
- Official Google GenAI SDK, configurable Flash model, server-only key, bounded timeouts, single provider attempt, durable operation lease, encrypted results, source-version caching and explicit refresh are implemented separately from applicant decisions.
- Structured responses validate exact evidence references and reject malformed/incomplete output and hiring-decision language. AI cannot write applicant stage, qualification results, interview outcomes or hiring decisions. HR must verify interpretation against the source.
- Isolated tests exercise missing/configured keys, OFF/enabled state, low-confidence OCR and unclear evidence, success, rate limits, timeouts, malformed output, retries, concurrent requests, caching, stale evidence, role checks and preservation of deterministic results. No provider quota is invented; usage is labeled application-level.
- System Health uses cached results and explicit bounded checks. Database, authentication, Gmail, model access and storage were checked against actual configured services. Parser installation is labeled a capability check; OCR remains Not Verified without a new end-to-end processing check. Email, extraction and Timekeeping job health use actual persisted job states and expired-lease detection; an unexercised service is labeled Not Verified.
- Diagnostics has a fixed sanitized issue catalog, severity/status filters, deduplication, occurrence and recovery history, contextual applicant links and resolution guidance. Only programmed bounded workers recover automatically: Gmail intake, queued confirmed email delivery and eligible extraction fallback. Manual AI Assist and document reprocessing remain explicit actions. Unknown email delivery is never automatically resent. Unknown issues never execute code, SQL, schema changes, environment changes or recruitment decisions.
- Tests deliberately simulate Gmail authorization/timeouts, AI rate-limit/timeouts, extraction failures, spreadsheet failures, database failures, job failures, notification/export failures and repeat occurrences. These are isolated failure tests, not intentional outages of the live database or mailbox.
- Audit History is append-only through application APIs, generated server-side, indexed, paginated and role-filtered. It records edits, decisions, documents, integrations, AI, Timekeeping, exports, settings and demo operations. Applicant deletion retains the audit trail. Diagnostic notification read state is per user and resets for new occurrences.

## Latest reliability verification

- Proceed/outbox tests verify atomic transitions, correct configured templates, one transition and one message under repeat/concurrent requests, encrypted content, retained send IDs and safe retry after a known 429 failure. Ambiguous delivery remains Unconfirmed and cannot resend; Gmail verification uses the returned actual timestamp.
- Missing or unsupported placeholders produce a visible failed email without calling Gmail. Demo applicants cannot enter the outbox. These new workflow-email tests use mocked provider transport; no real applicant was advanced or emailed in this pass.
- Extraction tests verify source evidence, duplicate-request prevention, HR-field protection, provider backoff, separation from qualification/stage data and an interrupted worker returning after an HR edit. Stale results cannot commit.
- Empty documents use Not Assessed; unstated evidence is Unclear. Conservative semantic role aliases still require stated experience duration. Resume names outrank sender names, with unlabeled headings treated as uncertain and conflicting identities preserved for HR review.
- A synthetic 975-row dual-file job completes with progress and survives concurrent execution without duplicate analyses. Live browser QA also exercised a polling interruption: the saved job completed and Check progress recovered the result at 100%. Both supplied workbooks also passed the new asynchronous pipeline in an isolated database: 940 raw rows, 911 Pivot rows, 1,425 employee-days, 100% progress and a valid 279,853-byte Excel export. Production payroll decisions and original files were untouched.

- Live concurrent-work testing found PostgreSQL contention during startup DDL and attendance polling. Cold starts now read the database catalog before running any required schema setup; existing tables/indexes are left alone. Attendance job coordination has an independent advisory lock, and normal progress reads do not acquire a write lock. The rebuilt workspace reopened while evidence maintenance was still running, and attendance reached 1,425/1,425 employee-days. Health checks now observe service state without first scanning and writing document incidents; cached results are persisted independently of recruitment writes, with diagnostic recovery recorded after the response. No source or payroll decisions were discarded during recovery.

## Actual Odoo workbooks

Both supplied files were read directly and uploaded through the authenticated application. The original files were not modified.

| Evidence                          | Result                                                    |
| --------------------------------- | --------------------------------------------------------- |
| Detected cutoff                   | September 1–15, 2026                                      |
| Raw attendance entries            | 940                                                       |
| Daily Pivot rows                  | 911; headers and totals excluded                          |
| Distinct source identities        | 95 before HR-confirmed aliases                            |
| Potential suffix aliases          | 11; not merged without confirmation                       |
| Employee-day coverage             | 1,425                                                     |
| Raw worked hours                  | 8,441.798333333332                                        |
| Pivot worked hours                | 8,441.798333333329; equal within floating-point precision |
| Missing time out / incomplete     | 18 / 18                                                   |
| Multiple-entry days               | 22                                                        |
| Material worked-hours discrepancy | 1                                                         |
| Potential overtime / undertime    | 883 / 70; review required                                 |
| No Attendance                     | 513; unresolved reasons/schedules are identified          |
| Supported rest-day results        | 59                                                        |
| Late / early out                  | Unknown without HR start/end schedules                    |

The saved cutoff survives navigation and reload. Employee/day/result filters and underlying multiple-entry details were exercised. An inspected day exposes all three original clock records and its Pivot row. Calculated results and HR decisions are separate. No real payroll review outcome was assigned by the agent; resolution persistence was tested with fictional data.

Actual-cutoff CSV and Excel downloads were exercised. The final production-browser Excel download was confirmed on disk and reopened successfully: five worksheets, 1,425 Attendance review data rows, 25 columns and 22 Multiple Entries data rows. The browser automation download event did not fire, so completion was verified against the actual downloaded workbook. The final saved analysis also generated and successfully reopened a five-sheet Excel workbook: Summary, Attendance review, Source and rules, Exceptions and Multiple Entries. Attendance review contains 1,425 data rows and 25 columns; Multiple Entries contains 22 data rows. Encrypted source copies, uploader/time, hashes, rules, analysis version and review history remain associated with the saved analysis. These outputs require HR review before payroll use.

## UI and interaction audit

- Product identity, Google display name and assigned role stay separate. Branding consistently uses Daily Joe Careers.
- Transparent logo and favicon derivatives preserve the supplied artwork. Dark mode brightens the artwork without a rectangular backplate.
- Semantic light/dark tokens, readable hover/focus/disabled states, bounded requests, friendly failures, toast feedback and loading states remain consistent across modules.
- Both dark and light preferences were saved in the actual UI; the original light theme was restored after QA. The targeted settings endpoint prevents background intake from overwriting unrelated settings changes.
- Applications use 20 rows per page with bounded pagination controls. Tables scroll inside their containers; resumes load on demand.
- Attendance metrics, filters, daily clocks, source details, review modal/history and exports use the application design system.
- Geometry checks cover 1280×720, 1366×768, 1440×900, 1920×1080, tablet widths and 390×844. A tablet header overflow was found and corrected. The final System Health cards fit all requested desktop sizes and narrower widths without document overflow. Dialogs fit and scroll internally; Escape restores focus.
- Final browser checks covered dashboard greeting, the 20-row application list and pagination, paused sample Hiring Needs, Talent Pool, Reports, Timekeeping without Gmail UI, AI Integration, Diagnostics details, Audit History and the controlled test applicant's activity/Gmail link. Favicon metadata references the supplied-logo derivatives.
- The earlier walkthrough covered demo editing, workflow guards, requirements, Hiring Needs, reports, empty states, notification actions and mobile navigation. Current server tests rerun their safety boundaries. Browser coverage is representative, not an assertion that every possible record and third-party condition was exercised.

## Remaining live-service and deployment validation

1. Gemini has returned HTTP 503/high demand and a rate-limit response for generation. Deterministic extraction and System Analysis work; live successful fallback needs a recovered provider.
2. Deploy this build to the intended host and verify callback URL, database, favicon and integrations there. Local production-build verification does not establish a cloud deployment.
3. Review sample qualification templates and configure approved Hiring Needs with HR. Ambiguous matches remain unassigned for review. Review the seven document warnings and remaining unknown fields against source evidence.
4. Configure and authorize the Google Sheets tracker; validate actual formatting, stable IDs and updates.
5. Set server-only CRON_SECRET for authenticated background intake. The checked-in Vercel cron runs daily for Hobby compatibility. Frequent closed-browser intake requires a supported hosting plan or an external authenticated scheduler; see README. Login, connection, browser and workflow triggers operate separately.

Fresh OAuth scope grants/revocation recovery, recipient-inbox delivery, live Sheets updates, a future new incoming message and deployed scheduled execution were not exercised in this pass. Existing-mailbox import, stored authorization, a controlled Gmail send/read-back, an earlier synthetic Gemini request, the current Gemini failure, real OCR and continuous intake beyond the active window were exercised live.

## Operational limits

Resumes: 8 MB and ten PDF pages. OCR depends on legibility; uncertain evidence requires review. Odoo: original XLSX up to 8 MB per file, 12,000 rows, 100 columns and a 93-day cutoff. Preview access expires after thirty minutes; expired encrypted upload records need a future retention policy. Analyzed sources and prior versions are retained. Database-outage fallback records are process-local until storage recovers and cannot survive every infrastructure failure; external monitoring remains necessary. Production load testing and an independent security assessment were not performed. This validation establishes the local production build, not a deployed production certification.
