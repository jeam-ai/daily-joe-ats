# Daily Joe ATS — final system QA

Date: October 3, 2026, Asia/Singapore. Scope: the existing application and the requested workflow optimizations in this working tree. No new major module was added during this QA pass.

## Overall status

**Not production-ready for final sign-off.** The tested local application passes its regression suites, production build, authenticated API checks and browser workflows. Live Gmail authorization fails with `invalid_client`, and the current changes have not been deployed or validated against the release environment. Those are release gates, not minor cosmetic issues.

There is no remaining reproduced blocking product-logic bug in the local workflows covered below. This does not certify every external integration or every possible failure mode.

## Test environment and safeguards

- Next.js 16.3.8, React 19.3.0 and TypeScript 7.0.2; App Router pages and route handlers. Installed Next.js route/error documentation was consulted before framework changes.
- Existing Google authentication, encrypted sessions/source documents, role/origin checks, transactional workspace snapshots, normalized applicant projections and indexed intake windows were reused. PostgreSQL and optional Sheets persistence were inspected; mutations ran in isolated SQLite fixtures.
- Actual HTTP and browser mutations used a dedicated `final-system-qa-20261003.sqlite` database, fictional `example.invalid` accounts and loopback port 3004. The fixture contained 360 applicants, 45 hired employees, 30 talent-pool candidates and 1,428 attendance records for 119 employees.
- Tests exercised real local route handlers and persistence, including production mode. Gmail delivery/intake, Gemini and Sheets provider responses in automated suites were mocked. PDF, DOCX and scanned-PDF OCR processing used actual local extraction libraries.
- Existing HR data was not reprocessed, altered, deleted or used for destructive QA. Live database probes used a read-only transaction and rollback. A Google token refresh/profile probe used credentials in memory without persisting them; no email was sent.
- A temporary, guarded loopback browser-session route was removed before the final build. The final local build and existing public deployment return 404 for it. Fixture seed/server helpers live under `tests/helpers`, outside application routes.

## Final checks

| Check                                       | Observed result                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Unit tests                                  | **108 passed**, 0 failed/skipped                                                                                          |
| Server regression tests                     | **101 passed**, 0 failed/skipped                                                                                          |
| Authenticated individual issuance API suite | **6 checks passed** against the final production build                                                                    |
| Authenticated full-system API suite         | **15 checks passed** against the final production build                                                                   |
| Unauthenticated production smoke suite      | Protected pages/APIs, invalid OAuth state, PKCE login redirect, cross-origin mutations and scheduler-secret checks passed |
| Production build                            | Passed; no temporary QA application route                                                                                 |
| TypeScript                                  | Passed                                                                                                                    |
| Changed/new file formatting                 | Passed                                                                                                                    |
| Repository-wide formatting                  | 17 pre-existing, unchanged files still fail Prettier; listed in the remaining issues                                      |
| Git whitespace check                        | Passed                                                                                                                    |
| Production dependency audit                 | 0 known vulnerabilities reported by `npm audit --omit=dev`; system CA trust used                                          |
| Client bundle sanity check                  | 33 client files checked against 5 configured private values; 0 matches                                                    |
| Production browser console                  | No errors/warnings in the final observed applicant-profile and timekeeping flows                                          |

The 21 API checks are grouped workflows with multiple assertions, separate from the 209 unit/server tests. They are not 21 additional unit tests. An additional actual production-mode logout check verified redirect to login, cookie clearing and persisted session revocation: reusing the former cookie returns 401. Local logs and screenshots are in the ignored `test-results` directory.

## Modules and workflows checked

| Area                            | Executed verification                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard                       | Real underlying summaries/roster counts, loading, zero-record states, navigation and refresh. Injected supporting-read failure reproduced the stuck loader; error and retry recovery were then verified.                                                                                                                                                             |
| Applications                    | Manual creation, invalid/duplicate email rejection, request replay, profile reopening, header action menu, notes, soft delete/restore, closed-history protection and filtered bulk export.                                                                                                                                                                           |
| Applicant ingestion/OCR         | Resume identity versus subject/sender/body/filename, incomplete evidence, damaged files and duplicate intake. Real text PDF, DOCX and scanned PDF extraction passed; mailbox transport was mocked.                                                                                                                                                                   |
| Existing applicant reprocessing | Preview source/value differences; apply selected fields only; protected HR identity, status, stage, notes and hiring assignment retained; duplicate-email and stale-preview rejection. Browser preview and actual API application were exercised.                                                                                                                    |
| Applicant search                | Exact/partial name, email, phone, case, extra spaces, apostrophes, literal `%`/`_`, date/branch/status/stage combinations and pagination. Browser rapid `juan` → `maria` displayed the newest search. Loading, count, empty and failed-request/retry states were observed.                                                                                           |
| Applicant actions               | Header `⋮` menu observed; actual API talent-pool return, reject and withdraw persisted. Proceed/stage-email previews, one transition per delivered message and ambiguous-delivery protection passed server tests with mocked email transport.                                                                                                                        |
| Applicant bulk selection        | Browser selected all 360 results across 20-row pages; selection survived page navigation and reset after filter changes. Actual filtered note affected matching records once; unrelated records stayed unchanged. Typed delete confirmation was observed and cancelled; confirmed deletion/restoration was tested separately.                                        |
| Hiring needs                    | Actual create/edit/close/reopen, assignment and counts; server bulk updates preserved qualifications and individual audits.                                                                                                                                                                                                                                          |
| Talent pool                     | Full membership count, search/filtering, movement into/out of pool, active recruitment restoration and duplicate-membership prevention.                                                                                                                                                                                                                              |
| Timekeeping                     | Actual punch calculation matrix, severity/order/filtering, automatic completion, minute preservation, missing punches, duplicates, invalid duration, overnight/split clocks, explicit schedule variance and preservation of manual review history.                                                                                                                   |
| Odoo import/reconciliation      | Actual multipart XLSX upload, asynchronous processing/polling, saved analysis, repeated import, raw-source/review preservation and malformed/empty upload errors. Server tests cover changed-rule versions, 900+ source-row jobs, export and cutoff deletion boundaries.                                                                                             |
| Timekeeping bulk review         | 1,428-record saved cutoff; only 72 pure-overtime records confirmed. Browser selected 72 medium records across four pages and added a note once per selected record. Mixed classifications and unrelated records remained protected.                                                                                                                                  |
| Onboarding                      | All 45 hired applicants loaded beyond the workspace preview; requirement completion/notes and orientation/commitment dates persisted across independent reads. Browser selection/page navigation and selected-employee bulk issuance were exercised.                                                                                                                 |
| Equipment issuance              | Item/quantity/date/employee/issuer/condition/notes; individual and bulk retries; return/reissue stock reconciliation; individual audit/link retention. Browser confirmed 45 employee issuances in one operation.                                                                                                                                                     |
| Settings                        | Settings pages render; actual preference save, invalid timezone rejection, UTC behavior and restoration. Browser dark-theme save/refresh and return to light mode passed. Configuration, templates, requirements, AI, retention and Sheets constraints have server regression coverage; live provider edits were not made.                                           |
| Authentication/authorization    | Seeded valid/expired sessions, direct protected URLs, refresh, backend role checks and cross-origin denial. Viewer and unassigned Office Assistant profile edits return 403; Talent Acquisition cannot access timekeeping. Browser logout returned to login. Google redirect/state/PKCE handling passed; interactive Google sign-in remains a live verification gap. |
| Loading/error/empty states      | Actual asynchronous search/import/save/bulk progress; expected validation failures, sanitized unexpected 500s with diagnostic references and working retries. Temporarily emptied only the QA database to observe empty dashboard, recruitment, hiring, talent, onboarding, issuance and timekeeping states, then restored it.                                       |
| Responsive UI/persistence       | Browser widths 1366×768, 1024×768 and 390×844; no horizontal page overflow in observed issuance flows. Refresh, direct navigation, back/forward and reopening records were checked. Production browser flows were repeated after fixes.                                                                                                                              |
| Database/API/security sanity    | Atomic rollback, idempotent writes, revision conflicts, omitted-record preservation, parameterized/escaped SQL search, role/origin checks, file validation, encrypted source storage and formula-safe exports. This is a practical sanity check, not a penetration test.                                                                                             |
| Performance/regression          | Hundreds of applicants and 1,428 attendance records, multi-page selection, bounded processing and database batches. Final local production search sample: 12 warm sequential requests, **12–13 ms, mean 13 ms**. This is not a concurrent load test or hosted-service latency guarantee.                                                                             |

## Bugs found, repaired and retested

1. **Issue: search failed with repeated interior spaces.** Root cause: the query trimmed/lowercased input without normalizing whitespace. Fix: collapse interior whitespace before indexed search; also floor fractional pagination inputs before SQL. Verification: the previously failing spaced candidate query now returns the intended result; actual API search and browser case/space searches passed. Regression: `workflow-optimization.test.ts` checks spaced search and fractional page/limit inputs. **Status: resolved.** Fractional pagination was additional validation hardening, not a separately reproduced user-facing incident.

2. **Issue: reprocessing could change an email to one already used by another applicant.** Root cause: reprocessing bypassed the uniqueness guard used by normal edits. Fix: check case-insensitive email uniqueness before applying a changed contact value; reject conflicts with 409 and roll back. Verification: conflict leaves the applicant unchanged; selected safe corrections still persist. Regression: duplicate reprocessing, stale previews, protected manual fields and unchanged historical duplicate-email edits. **Status: resolved.**

3. **Issue: Returned equipment changed back to Issued did not reduce stock.** Root cause: `returnedAt` remained set, so stock reconciliation still treated the issuance as returned. Fix: clear that marker when leaving Returned in individual and bulk updates; use the saved business timezone for return dates. Verification: stock goes from 10 to 8 exactly once and remains 8 on replay. Regression: individual return/reissue API checks, bulk status changes and inventory tests. **Status: resolved.**

4. **Issue: operational defaults and date filters could use the previous business day/month.** Root cause: UTC string truncation was used instead of the saved workspace timezone. Fix: shared business-day and local-month boundary helpers used by affected forms/filters. Verification: Manila midnight and month/year transitions now produce the expected defaults and search bounds; UTC preference behavior and restoration passed actual API checks. Regression: `dates.test.ts`, month/week search and return-date tests. **Status: resolved.**

5. **Issue: impossible calendar dates could be normalized and saved.** Root cause: `Date.parse` accepted rollover dates without validating the original wall-clock input. Fix: strict date shape and round-trip validation for issuance and interview input. Verification: February 31, month 13, 24:00 and 08:60 fail; a valid leap day passes; invalid issuance create/edit leaves records and stock unchanged. Regression: date unit tests and actual issuance API rollback checks. **Status: resolved.**

6. **Issue: repeated concurrent individual issuance requests created duplicate records.** Root cause: individual create had no durable request receipt. Fix: optional validated request UUID with atomic payload-hash receipt; the UI retains its key during retries. Verification: concurrent identical requests return one issuance; changed payload with the same key returns 409. Regression: production-build API concurrency/replay tests plus bulk issuance idempotency tests. Legacy clients without a request key remain supported; retry protection applies to keyed requests. **Status: resolved for the shipped UI/keyed workflow.**

7. **Issue: single issuance dropped the entered issuer.** Root cause: the route's allowed-field mapping omitted `issuedBy`. Fix: retain issuer during create/edit with actor fallback, show the existing field in the form and include it in audit changes. Verification: create/readback and subsequent issuer correction persist. Regression: actual issuance API and bulk issuer/link checks. **Status: resolved.**

8. **Issue: dashboard supporting-read failure displayed an endless loader.** Root cause: a failed supporting request was caught without setting a visible error state. Fix: explicit per-panel errors and retry; aborted reads are ignored and successful retry clears the error. Verification: corrupting only one QA projection reproduced API 500 and the original stuck loader; after repair, an error/retry appeared, restored data loaded, and navigation/refresh worked. Related applicant search error/retry recovery also passed. Regression: final browser fault/recovery check, normal/empty dashboard and API smoke checks. **Status: resolved.**

9. **Issue: workflow validation returned generic server errors, and denied profile edits used a validation status.** Root cause: expected `DomainError` values were treated as unexpected failures; access denials did not carry explicit HTTP status. Fix: preserve expected domain status/message, return actionable 400 for input errors and 403 for authorization denials; bulk transition validation follows the same rule. Verification: missing required onboarding dates give useful feedback; Viewer and unassigned Office Assistant edits fail with 403 and do not save. Regression: `validation-feedback.test.ts`, role-boundary API tests and normal recruitment workflow suites. Access had already been denied before the status fix; no permissions bypass was reproduced. **Status: resolved.**

10. **Issue: a talent-pool candidate could not return through the existing status action.** Root cause: the closed-history guard also rejected Talent Pool → New/For Review. Fix: allow that confirmed change at the same recruitment stage; keep other terminal decisions and stage jumps protected. Verification: actual API pool return, subsequent withdrawal and a separate rejection persist without incompatible membership. Regression: server pool restoration/closed-decision tests and full-system API suite. **Status: resolved.**

11. **Issue: onboarding header Bulk issuance ignored the selected employees.** Root cause: that entry point did not pass the current selection into the existing issuance component. Fix: pass selected employee keys, retaining the roster picker when there is no selection. Verification: browser reproduced 0 recipients despite 45 selected, then retested 45 recipients after page navigation and confirmed 45 distinct issuance records with stock/audit updates. Regression: existing bulk component/server tests, actual API bulk checks and repeated production browser navigation. **Status: resolved.**

## Timekeeping calculation evidence

The matrix used actual check-in/check-out timestamps, not only manually entered duration values. Standard duration is 9 hours; the normal minimum is 8 hours; overtime classification begins at 9h31. Separately evidenced late/early-out or schedule problems can still require review.

The implemented rounding follows the user's clarification: 9h31 earns one overtime hour. Excess over 9 hours is credited to the nearest whole hour, with exactly 30 minutes rounding down. Total source time, excess minutes, remainder minutes and rounding adjustment remain stored and visible. Credited overtime is a calculation pending confirmation, not proof of payroll payment.

| Attendance | Classification without another discrepancy                         | Credited overtime |
| ---------- | ------------------------------------------------------------------ | ----------------- |
| 7h00       | Exception                                                          | 0h                |
| 7h59       | Exception                                                          | 0h                |
| 8h00       | Normal                                                             | 0h                |
| 8h01       | Normal                                                             | 0h                |
| 8h30       | Normal                                                             | 0h                |
| 8h59       | Normal                                                             | 0h                |
| 9h00       | Normal                                                             | 0h                |
| 9h01       | Normal                                                             | 0h                |
| 9h13       | Normal; 13 additional minutes retained                             | 0h                |
| 9h29       | Normal                                                             | 0h                |
| 9h30       | Normal                                                             | 0h                |
| 9h31       | Overtime                                                           | 1h                |
| 9h43       | Overtime; 43 actual excess minutes retained, 17m rounding up shown | 1h                |
| 9h45       | Overtime                                                           | 1h                |
| 10h00      | Overtime                                                           | 1h                |
| 10h01      | Overtime; 1m remainder retained                                    | 1h                |
| 10h13      | Overtime; 13m remainder retained                                   | 1h                |
| 10h30      | Overtime; 30m remainder retained                                   | 1h                |
| 10h31      | Overtime; 31m remainder and rounding adjustment retained           | 2h                |
| 10h59      | Overtime                                                           | 2h                |
| 11h00      | Overtime                                                           | 2h                |

Additional passing cases cover 8h15/9h15, missing time-in/out, invalid/contradictory clocks, unmatched identities, duplicates, overnight attendance, source worked time excluding lunch, confirmed aliases and independently configured late/early-out checks.

Explicit approved leave/rest-day evidence produces those classifications and corresponding summaries. A scheduled workday without attendance is an unverified absence requiring review. Missing schedule context remains unknown/missing, rather than becoming a proven absence or invented leave day. A zero expected-hours value by itself is not sufficient evidence of approved leave.

In the realistic fixture, **1,240 of 1,428 records were automatically completed**, leaving 188 genuine exceptions. Confirming only 72 pure-overtime records produced **1,312 completed / 116 still requiring review**: 15 critical, 29 high and 72 medium. Raw imported rows and other exceptions were unchanged. Repeat import/processing preserved the latest manual review and its history.

Finalization/readiness calculation and review persistence are covered by automated tests; the browser intentionally retained the 116 unresolved exceptions rather than falsely marking the cutoff ready.

## Issuance and browser evidence

The browser selected all 45 hired employees across pages and confirmed one uniform each. Together with the three API fixture issuances present in that phase, the issuance screen showed **48 records, 45 employees with history and 952 of 1,000 units on hand**. Each employee retained an individual linked issuance and audit. Later suite runs reseeded the fictional workspace; these counts describe the observed browser phase, not a live stock report.

![Fictional QA workspace after bulk issuance](test-results/final-qa-bulk-issuance.png)

Additional screenshots: [mobile issuance](test-results/final-qa-mobile-issuance.png), [production timekeeping](test-results/final-qa-production-timekeeping.png).

## Remaining issues and verification gaps

| Issue                                                                       | Severity                   | Impact                                                                                                 | Why it remains                                                                                                                                                                                   | Required next action                                                                                                                                                         |
| --------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configured live Gmail refresh fails with HTTP 401 / `invalid_client`        | **High — release blocker** | Cannot certify real mailbox intake, document retrieval or workflow email delivery                      | OAuth client configuration/authorization is rejected by Google; valid replacement credentials are not available in this task                                                                     | Verify the release OAuth client ID/secret and callback configuration, then reconnect the official mailbox and verify profile, controlled intake and designated test delivery |
| Current changes are not deployed; live integration acceptance is incomplete | **High — release blocker** | Local production-mode tests do not establish hosted Google login, Gmail, Sheets or scheduler operation | No deployment was performed in this QA request; valid live provider access and controlled delivery destination are needed                                                                        | Deploy this reviewed change to the intended release environment and run authenticated provider/scheduler checks with controlled data                                         |
| Database release target/schema is not fully established                     | **Medium**                 | Local configuration may differ from the actual deployed provider/schema                                | The read-only PostgreSQL probe reached a configured endpoint, found 5 of 6 requested tables and zero orphan applications; this is not proof of the deployed target or a complete integrity audit | Confirm the release database selection and inspect all required tables/indexes with the existing schema/init tooling before deployment; do not migrate an unknown endpoint   |
| Repository formatting baseline                                              | **Low**                    | Global `format:check` remains red despite clean changed files                                          | 17 unchanged files already violate formatting; rewriting unrelated stable components would enlarge this QA repair                                                                                | Address in a separate formatting-only pass if desired                                                                                                                        |

The 17 unchanged formatting files are `app/(workspace)/error.tsx`, `app/api/applicants/[id]/resume/route.ts`, `app/api/reports/recruitment/route.ts`, `app/api/tracker/route.ts`, `app/globals.css`, `components/applicant-information.tsx`, `components/applicant-management.tsx`, `components/application-source.tsx`, `components/document-recovery.tsx`, `components/provider.tsx`, `components/report-details.tsx`, `components/reports.tsx`, `components/screening-controls.tsx`, `components/settings.tsx`, `lib/screening.ts`, `lib/server/repository.ts` and `tests/soft-launch.test.ts`.

Current read-only live observations: public deployment login 200; unauthorized workspace 401; temporary QA route 404; Google discovery 200; configured PostgreSQL reachable with no orphan application-parent links in the checked join; Gmail token refresh rejected. These observations concern the currently published release, not this unshipped working tree. Historical success in `VALIDATION.md` is not substituted for current verification.

The following were **not executed**: fresh interactive Google login and login-after-logout against the release configuration; real Gmail import and outbound delivery; live Sheets writes; live Gemini success; deployed scheduler execution; authenticated destructive operations against production; complete concurrent PostgreSQL load testing; long-duration memory profiling; physical-device/screen-reader testing; and hard network teardown during every mutation. Instead, isolated tests cover provider failures/timeouts, sessions, rollback, unknown delivery, safe retries and stale revisions, and browser QA covers selected real HTTP failures and responsive viewports. Those checks do not prove all unexecuted scenarios.

## Reproducing the local checks

Run from the repository root:

```powershell
npm test
npm run test:server
npm run typecheck
npm run build
node --conditions=react-server --import tsx tests/helpers/system-qa-seed.ts
node tests/helpers/system-qa-server.mjs start
```

In another terminal, while that server is running:

```powershell
node tests/api-issuance-qa.mjs
node tests/api-system-qa.mjs
$env:SMOKE_BASE_URL = 'http://localhost:3004'
node tests/api-smoke.mjs
```

The seed creates only the named fictional local database and fixture workbooks. The authenticated mutation suites refuse non-loopback URLs and refuse a workspace whose owner is not `admin@example.invalid`. Seed once before a complete API run; the tests deliberately mutate that fixture. Stop the local QA server afterwards. Browser checks were performed separately with an isolated fixture session; the removed temporary application login helper is not required or shipped.

Local evidence logs: `final-qa-unit.log`, `final-qa-server.log`, `final-qa-build.log`, `final-qa-typecheck.log`, `final-qa-production-issuance.log`, `final-qa-production-api.log`, `final-qa-production-smoke.log`, `final-qa-production-logout.log`, `final-qa-changed-format.log`, `final-qa-format.log`, `final-qa-secret-scan.log`, `final-qa-dependency-audit.json` and `final-qa-live-readonly.log`, all under `test-results`.
