# Onboarding contract (landing + signup + human check + tour)

Base: `/v1/public/...` (no login) and `/v1/private/...` (login). All responses: `{ success, message?, data?, ... }`. Errors: `{ success:false, code:<http>, message, errorCode?, ... }`.
Spec: `docs/LANDING_AND_ONBOARDING_FLOW.md`. All new endpoints are zod-validated, rate limited, NoSQL-sanitised (global).

## 0. Conventions
- Mobile: any Indian format (`+91 98765 43210`, `09876543210`); server normalises to 10 digits `^[6-9]\d{9}$`.
- `registrationToken`: JWT (`purpose:'register'`, bound to the mobile, 30 min) from `POST /v1/public/register/verify-otp`. Send it as header `X-Registration-Token` (preferred) **or** body field `registrationToken`. Keep it in memory only.
- Human check token: body field **`humanToken`** (or header `X-Human-Token`). Format depends on provider, see §2.
- Honeypot: body field **`hp_website`** must be absent or empty. Render it as a visually hidden, `tabindex=-1`, `autocomplete=off` text input. Non-empty ⇒ 400 `HUMAN_CHECK_FAILED`.
- Fill time: body field **`fillMs`** (ms since the form was shown). If present and `< 1500` ⇒ 400 `HUMAN_CHECK_FAILED`. Optional but recommended.
- Error codes (`errorCode`): `HUMAN_CHECK_REQUIRED`, `HUMAN_CHECK_FAILED`, `HUMAN_CHECK_UNAVAILABLE`, `ALREADY_REGISTERED`, `REGISTRATION_CLOSED`, `PLAN_UNAVAILABLE`, `DRAFT_INCOMPLETE`, `DRAFT_IN_PROGRESS`, `TOKEN_INVALID`, `EMAIL_TAKEN`, `CONSENT_REQUIRED`.

## 1. Plans — `GET /v1/public/plans`
Cached 60 s server side, rate limit 60/min/IP. Only active, non-deleted plans, sorted by `sortOrder`, then cheaper first.
```json
{ "success": true, "data": { "plans": [ {
  "id": "64f…", "name": "Growth", "slug": "growth", "description": "…",
  "monthlyPrice": 999, "annualPrice": 9990, "gstPercent": 18, "pricesIncludeGst": false,
  "isPopular": true, "trialDays": 14,
  "limits": { "students": 300, "seats": 150, "staff": 5, "branches": 0 },
  "features": ["Unlimited reports", "ai"], "sortOrder": 1
} ], "registrationOpen": true, "defaultTrialDays": 14 } }
```
`branches: 0` and `staff: 0` mean unlimited. Prices exclude GST. No internal ids/notes beyond plan `id`.

## 2. Human verification
### 2.1 Config — `GET /v1/public/human-check/config`
```json
{ "success": true, "data": { "provider": "turnstile|hcaptcha|pow|none", "siteKey": "0x4AAA…|null",
  "challengeUrl": "/v1/public/human-challenge", "loginThreshold": 3 } }
```
`provider` is `pow` when `HUMAN_CHECK_PROVIDER` is `none`/unset (proof-of-work fallback is then active), and `none` only in non-production when `HUMAN_CHECK_PROVIDER=off` (checks skipped, dev only). The site key is public by design (`HUMAN_CHECK_SITE_KEY`).

### 2.2 Tokens
- **turnstile / hcaptcha:** render the provider widget with `siteKey`; put the widget response string in `humanToken`. Server verifies it with the provider (`siteverify`), 5 s timeout, single use (providers reject replays).
- **pow:** `GET /v1/public/human-challenge` →
  `{ "data": { "challenge": "<b64url payload>.<sig>", "difficulty": 18, "expiresAt": 1730000000000, "algorithm": "sha256-leading-zero-bits" } }`.
  Find an integer `nonce` such that `SHA-256( challenge + ":" + nonce )` has at least `difficulty` leading zero **bits**. Send `humanToken = challenge + "~" + nonce`. Challenge lifetime 5 min, single use (server stores the id until expiry), minimum 1.5 s between issue and use. Solve in a Web Worker (≈0.2–2 s).
- Failure: `400 { errorCode:'HUMAN_CHECK_FAILED' }` (bad/expired/replayed token, honeypot, too fast). Missing: `403 { errorCode:'HUMAN_CHECK_REQUIRED', humanCheck:{provider,siteKey,challengeUrl} }`. Provider down in production: `503 { errorCode:'HUMAN_CHECK_UNAVAILABLE' }` (fail closed).

**Tokens are single use, even when the request then fails.** After ANY error response from a human-checked endpoint (including validation errors and `DRAFT_INCOMPLETE`), fetch a fresh token (reset the Turnstile/hCaptcha widget, or request a new proof-of-work challenge) before retrying. The human check runs before body validation so bots are rejected cheaply.

### 2.3 Where it is enforced
| Endpoint | Rule |
|---|---|
| `POST /v1/public/register/send-otp` | always |
| `POST /v1/public/register/complete` | always (fresh token) |
| `POST /v1/public/forgot-password` | always |
| `POST /v1/public/login` | only after `loginThreshold` (3) failed attempts for that identifier **or** that IP in 15 min |
`verify-otp` and `register/draft` are protected by the registration token and rate limits, not by a challenge.

### 2.4 Login hint
A failed `POST /v1/public/login` (HTTP 401) now includes `"requiresHumanCheck": true|false`. When `true`, the **next** login must include `humanToken` (else `403 HUMAN_CHECK_REQUIRED`). Successful login clears the counter. `GET /v1/public/human-check/status?identifier=<email|mobile>` → `{ "data": { "required": boolean } }` (rate limited; reveals nothing about whether the account exists).

### 2.5 CSP for the frontend `proxy.ts`
- Turnstile: `script-src https://challenges.cloudflare.com`, `frame-src https://challenges.cloudflare.com`, `connect-src https://challenges.cloudflare.com`.
- hCaptcha: `script-src https://hcaptcha.com https://*.hcaptcha.com`, `frame-src https://hcaptcha.com https://*.hcaptcha.com`, `connect-src https://hcaptcha.com https://*.hcaptcha.com`, `style-src https://hcaptcha.com https://*.hcaptcha.com`.
- PoW needs nothing (use a same-origin Worker; `worker-src 'self' blob:` if created from a blob).

## 3. Registration flow
### 3.1 `POST /v1/public/register/send-otp` (existing, now human-checked)
Body `{ mobile, humanToken, hp_website?, fillMs? }` → `200 { data:{ isOTP:true } }` (+ `otp` only if `OTP_IN_RESPONSE=true` outside production). `403 REGISTRATION_CLOSED` when registration is off. Limits: 8/10 min/IP, 5/10 min/mobile. Existing behaviour otherwise unchanged. It does **not** reveal whether the mobile is registered.

### 3.2 `POST /v1/public/register/verify-otp` (existing)
Body `{ mobile, otp }` → `200 { data:{ registrationToken } }`. Unchanged.

### 3.3 `GET /v1/public/register/draft` (header `X-Registration-Token`)
Called right after verify-otp. Creates the draft if missing, resumes if present.
```json
{ "success": true, "data": {
  "exists": true, "step": 2, "mobile": "9876543210",
  "planId": "64f…|null", "billingCycle": "monthly|annual",
  "data": { "name":"", "ownerName":"", "email":"", "address":"", "city":"", "state":"", "district":"", "pincode":"", "country":"India",
            "seatCapacity": 40, "workingHours": {"openingTime":"06:00","closingTime":"22:00","weeklyHoliday":"","openDays":""},
            "facilities": [], "alternativeMobileNumber":"", "website":"", "gstNumber":"", "description":"" },
  "consent": { "terms": false, "privacy": false, "marketing": false },
  "status": "draft", "expiresAt": "2026-…"
} }
```
If the mobile already owns an account (Admin of any type, or a Library): `409 { errorCode:'ALREADY_REGISTERED', message:'This number is already registered. Please sign in.' }` — no library details. If the draft was completed already: `409 ALREADY_REGISTERED` too.

### 3.4 `PATCH /v1/public/register/draft` (header `X-Registration-Token`)
Body (all optional, unknown keys rejected with 400): `{ step?: 1-4, planId?: ObjectId, billingCycle?: "monthly"|"annual", data?: { …only the keys above… }, consent?: { terms?, privacy?, marketing? } }`.
Merges (deep for `data`), refreshes the 7-day expiry, returns the same shape as GET. Rules: `planId` must be an active plan else `409 PLAN_UNAVAILABLE`; email is lower-cased; strings trimmed and length-capped; **no password, no Aadhaar, no files**. Draft is `409 DRAFT_IN_PROGRESS` while a completion is running.

### 3.5 `POST /v1/public/register/complete`
Headers: `X-Registration-Token`. Body:
```json
{ "completeKey": "uuid-v4 generated once per Review screen", "password": "optional, ≥8 chars",
  "otpOnly": false, "consent": { "terms": true, "privacy": true, "marketing": false },
  "humanToken": "…", "hp_website": "", "fillMs": 45000 }
```
Rules: registration must be open (`403 REGISTRATION_CLOSED`); token valid and bound to the draft mobile (`403 TOKEN_INVALID`); `consent.terms` and `consent.privacy` must be `true` (`400 CONSENT_REQUIRED`); `password` required unless `otpOnly:true` (then a random unusable password is set and sign-in is by mobile OTP until the user sets one in Profile); draft must contain every required field (`422 DRAFT_INCOMPLETE` with `data.missing:["city","seatCapacity",…]`), plan must still be active (`409 PLAN_UNAVAILABLE`); mobile re-checked (`409 ALREADY_REGISTERED`); email (if given) unique (`409 EMAIL_TAKEN`).
Idempotent: the same `completeKey` after success returns the same `200/201` result (and a fresh session if the library is active) without creating anything; a different key after completion gives `409 ALREADY_REGISTERED`. Concurrent calls: one wins, the other gets `409 DRAFT_IN_PROGRESS` (retry after 2 s).
If `email` is empty the owner account gets a placeholder login e-mail `m<mobile>@noemail.dddesk.invalid` (never shown, never emailed). The owner signs in with the mobile.
Success `201`:
```json
{ "success": true, "message": "Your library is ready.", "data": {
  "status": "active|pending",
  "library": { "id":"…", "name":"…", "status":"active|pending", "libraryCode":"…" },
  "plan": { "id":"…", "name":"Growth", "billingCycle":"monthly", "trialEndsAt":"2026-…|null" },
  "admin": { "id":"…", "name":"…", "mobile":"9876543210" },
  "tour": { "pending": true },
  "token": "<access JWT, only when status=active>", "expiresIn": 1800,
  "user": { "id":"…", "userType":"admin", "permissions":[…], "libraryId":"…", "library":{…} } } }
```
`status` follows the platform setting `onboarding.autoApproveNewLibraries`. When `pending`: no token/cookie is issued (sign-in is blocked until the superadmin approves) and the UI shows "we are reviewing your library". When `active`: the HttpOnly refresh cookie is set exactly like login, so the frontend stores `token` in memory and redirects to `/dashboard` (tour starts because `tour.pending` is true).
Security events: `register_complete` success/failure. Audit: `library.self_registered`.

### 3.6 Legacy `POST /v1/public/register` (multipart)
Still works unchanged for existing clients (pending approval unless auto-approve). The new wizard uses §3.3-3.5. (It is also human-checked **only when** `HUMAN_CHECK_ENFORCE_LEGACY=true`.)

## 4. Product tour & checklist (login required, library owner/staff)
### 4.1 `/me` addition
`GET /v1/private/me` (and `/v1/private/profile`) now returns `tour: { completed: boolean, skippedAt: ISO|null, lastStep: number, version: number, pending: boolean }`. `pending` is true for a new owner whose tour was never completed/skipped for the current `TOUR_VERSION` (server constant, currently 1). Staff and superadmin get `pending` too (superadmin gets `tourScope:"superadmin"` to pick the shorter tour).

### 4.2 `PATCH /v1/private/profile/tour`
Body `{ lastStep?: 0-50, completed?: boolean, skipped?: boolean, restart?: boolean }`. `completed:true` sets `completed`; `skipped:true` sets `skippedAt` (tour is not offered again for this version); `restart:true` clears both (Help → "Take the tour again"). Returns `{ data: { tour } }`. Blocked for impersonation sessions (403).

### 4.3 `GET /v1/private/onboarding/checklist`
Owner/staff of a library only (superadmin gets `403`). Counts are scoped to the library (and branch for branch-limited staff).
```json
{ "success": true, "data": {
  "percent": 60, "complete": false,
  "items": [
    { "key":"profile", "label":"Complete library profile", "done": true,  "href":"/dashboard/settings" },
    { "key":"plan",    "label":"Create a membership plan", "done": false, "href":"/dashboard/plans/add" },
    { "key":"seats",   "label":"Add seats",                "done": true,  "href":"/dashboard/seats" },
    { "key":"student", "label":"Add your first student",   "done": false, "href":"/dashboard/students/add" },
    { "key":"payment", "label":"Collect your first payment","done": false, "href":"/dashboard/payments" }
  ],
  "counts": { "plans": 0, "seats": 40, "students": 0, "payments": 0 },
  "profile": { "missing": ["logo","gstNumber"] },
  "trial": { "endsAt": "2026-…|null", "daysLeft": 12 } } }
```
`profile` done = name, owner, address, city, state, pincode, workingHours, seatCapacity present (logo/GST/description are listed in `missing` but optional).

## 5. Environment
`HUMAN_CHECK_PROVIDER=turnstile|hcaptcha|none|off` (default `none` ⇒ proof-of-work), `HUMAN_CHECK_SITE_KEY`, `HUMAN_CHECK_SECRET_KEY`, `HUMAN_CHECK_POW_BITS` (default 18, 12–24), `HUMAN_CHECK_LOGIN_THRESHOLD` (default 3), `HUMAN_CHECK_ENFORCE_LEGACY` (default false). Production startup: provider `turnstile|hcaptcha` without a secret ⇒ refuse to start; provider `none`/`off` in production ⇒ warning in the log (PoW still protects), `off` is refused in production.
