# Integration tests (real Express app + real MongoDB)

These tests start the actual `src/app.js` against a throw-away MongoDB (`mongodb-memory-server`) and call it over real HTTP,
including real Socket.IO connections. They never read the values in `backend/.env` and never touch your real database:
`lib.js` pre-sets every variable that the backend's `dotenv` would load (dotenv does not override existing variables),
uses dummy payment/mail keys, and replaces the Razorpay SDK with an in-process fake (no network).

## Run

```bash
cd backend
npm install                 # installs the devDependencies (mongodb-memory-server, socket.io-client)
npm run test:integration    # ~1 minute
npm test                    # the two original unit test files
```

The first run downloads a MongoDB server binary (about 500 MB for 6.0.x, cached in `~/.cache/mongodb-binaries`).
`MONGOMS_VERSION` (default `6.0.14`) chooses the version. If your machine has no Visual C++ runtime
(`mongod` exits with code 3221225781 on Windows), install the "Microsoft Visual C++ Redistributable 2015-2022 (x64)".

Environment switches: `DD_PARTS=p_fees,p_security npm run test:integration` runs only some parts (tests 01-14
in `integration.test.js` always run because later parts depend on their data); `HUMAN_CHECK_PROVIDER` defaults to `off`
(the proof-of-work tests switch to `pow` themselves).

## What is covered

| File | Area |
|---|---|
| `integration.test.js` | health, superadmin login, platform plans, OTP registration -> approval, sessions (refresh rotation, replay, logout), forged JWTs, branches, roles, staff, plans, seats, students (consent, Aadhaar masking, duplicates, minors), branch isolation |
| `p_fees.js` | permissions, partial and idempotent collects, overpay/decimals, FY receipt format, receipt branch isolation, 20 parallel collects, waive/discount/refund, GST on receipts |
| `p_members.js` | activate, plan-change proration, credit policy on renew, pause/extend, seats (assign/transfer/move), attendance, cron jobs |
| `p_security.js` | 403s on hardened routes, staff escalation, cross-tenant IDOR, impersonation blocks, lockout, rate limit, DPDP export/erase, maintenance windows, dashboards |
| `p_sub.js` | subscription order -> verify -> finalize, webhook signature + replay, half-applied payment repair, lapse/suspend/reinstate, reject |
| `p_edge.js` | proof-of-work human check, signup wizard (draft, complete, race, replay), auto-approve + OTP-only owner + tour, contact form, student portal, seat race, CRUD smoke, cron auth, forgot password, bulk import |
| `p_adv.js` | plan limits (students/staff/seats/branches), mass assignment, NoSQL injection, immediate revocation |
| `p_receipts.js` | receipt numbering: legacy counter, new financial year, parallel first-of-year |
| `p_smoke.js` | every route: anonymous -> 401, student token, public routes, index sync |
| `p_ops.js` | upload validation + protected documents, Aadhaar migration script, seed script idempotency |
| `p_realtime.js` | socket auth, room isolation, events, disconnect on revocation |
| `p_legal.js` | dynamic legal pages: XSS sanitiser suite, draft/publish/schedule lifecycle, immutability, restore/compare, access control, ETag/304, rate limit, consent versions |

The smoke tests write the full route tables (`route-smoke-private.md`, `route-smoke-public.md`) to the run's temp folder.

## Not covered

Real SMS/e-mail delivery, real Razorpay and Turnstile/hCaptcha calls, browsers, load testing, MongoDB Atlas specifics
(replica-set transactions, the Mongo-backed rate-limit store used only when `NODE_ENV=production`).
