# Validation record

Full workspace milestone, September 18, 2026.

## Automated checks

- `npm run typecheck` passed.
- `npm test` passed: 26 tests, including role boundaries, OAuth state, encrypted storage, Gmail payloads, confirmation rules, screening evidence, notifications and tracker structure.
- `npm run test:server` passed: isolated SQLite repository, import preview/confirmation, deduplication and resume handling.
- `npm run test:smoke` passed: protected route redirects, origin checks, OAuth scope configuration, Gmail API boundaries and workspace API access.
- `npm run build` passed with Next.js 16.3.5 and Node.js 24.
- `npm run format:check` passed.
- Localhost smoke check returned HTTP 200 after replacing the stale development process that was serving the earlier Internal Server Error.
- Localized `/no-such-page` returns the branded Daily Joe 404 page instead of a generic server error.
- Local Admin demo controls loaded ten fictional records successfully; records are marked `Demo` and can be cleared independently.
- Theme switching was checked in the browser; the dark palette has readable contrast and first-paint theme flicker is suppressed.

## Browser and integration checks

- Local workspace routes render with the authenticated `deveraajeam@gmail.com` account and the HR Associate title.
- The official operational mailbox is configured as `careers@daily-joe.com` with the Talent Acquisition Specialist title. Applicant IDs are hidden from dashboard and applicant screens; the Excel tracker includes them.
- The personal Gmail connection and manual test send were completed by the user. The user confirmed the app success message and inbox delivery to `deveraajeam@gmail.com`.
- Official mailbox authorization remains a deliberate manual step because Google requested two-device verification. No attempt was made to bypass that challenge.
- The Vercel production deployment is ready at https://daily-joe-ats.vercel.app and serves the Google sign-in gate.
- The latest local polish adds the blue transparent Daily Joe header asset, ATS favicon, pastel stage legend, profile-image support, and JPG/PNG resume retention with an explicit OCR-pending insight. A Vercel redeploy is still pending because the CLI could not reach its update/user endpoints in the current network session.

## Security checks

- No client secret, session secret, token-encryption key or refresh token is included in browser bundles or source-controlled example files.
- OAuth uses server-side PKCE, state and nonce validation, least-privilege scopes and authorized-account checks.
- Gmail test sends require an explicit button click and are limited to the authenticated test recipient.
- Vercel is configured to fail closed until PostgreSQL and the remaining server-only secrets are supplied.

## Known deployment prerequisites

- Add `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` and `DATABASE_URL` to Vercel production settings.
- Register `https://daily-joe-ats.vercel.app/api/auth/callback` as a Google OAuth redirect URI.
- Authorize `careers@daily-joe.com` for official Gmail send and controlled intake when the two-device verification is available.
- Set `DATABASE_URL` to one shared PostgreSQL database for Vercel so both authorized accounts see the same workspace and tracker state.
