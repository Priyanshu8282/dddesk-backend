# Dashboard contract (REST + Socket.io)

Backend half of the new Super Admin / Library Owner dashboards. All paths are under `/v1/private`.
All REST responses use `{ success, message, data }`. All money is rupees (number, 2 decimals max), all dates ISO-8601 UTC strings.
Buckets (months, days, weeks) are cut in **IST (Asia/Kolkata)**.

The old endpoints (`GET /dashboard/admin`, `/dashboard/superadmin`, `/dashboard`, `/superadmin/dashboard`) are unchanged and keep working.

## 1. REST endpoints

| Method + path | Who | Purpose |
|---|---|---|
| `GET /dashboard/summary` | superadmin, admin (owner), staff | Whole dashboard in one call. Role picks the payload: `superadmin` → platform summary, `admin`/`staff` → library summary. A superadmin may add `?libraryId=<id>` to get that library's owner summary. Students get 403. |
| `GET /dashboard/charts?range=` | same | Only the range-dependent charts (cheap, for the range dropdowns). |
| `GET /dashboard/realtime-info` | same | Tells the UI whether sockets exist (else poll). |

Optional query: `branchId=<id>|all` (library summary only; branch-limited staff are always limited to their branches, the server enforces it).

`range` values
* superadmin: `year` (default, Jan → current month of this IST year) | `6m` (last 6 months) | `30d` (last 30 days, daily buckets)
* library (fees chart): `week` (default, Mon → Sun of this IST week) | `month` (every day of this IST month) | `year` (Jan → Dec of this IST year)
An unsupported value → 400.

Caching: responses are cached in-process for 20 s per (library, branch scope, permission flags, range). Realtime events invalidate that cache. `generatedAt` tells the UI how fresh the data is.

### 1.1 Common building blocks

```jsonc
// KPI card
{ "value": 248, "changePct": 12.4, "spark": [ {"label":"Apr","value":180}, ... ] }
//  changePct: percent change against the previous period (this month vs last month). null when it cannot be computed (previous = 0).
//  spark: 7 points (library) / 12 points (superadmin), oldest first, never empty (missing months are 0).

// Chart point
{ "key": "2026-10", "label": "Oct", "value": 31 }          // month bucket, key = YYYY-MM
{ "key": "2026-10-24", "label": "24", "value": 5 }         // day bucket,   key = YYYY-MM-DD
```

### 1.2 Superadmin summary (`role: "superadmin"`)

```jsonc
{
  "role": "superadmin",
  "generatedAt": "2026-10-24T09:10:11.000Z",
  "range": "year",
  "kpis": {
    "totalLibraries":  { "value": 248,   "changePct": 12.0, "spark": [...12] },   // all non-deleted libraries; change = new this month / total at end of last month
    "totalStudents":   { "value": 18630, "changePct": 18.0, "spark": [...12] },   // non-deleted students across all libraries
    "monthlyRevenue":  { "value": 148500, "changePct": 25.0, "spark": [...12], "currency": "INR" }, // subscription revenue this IST month, BEFORE GST (same rule as the Revenue page)
    "activePlans":     { "value": 214,   "changePct": 10.0, "spark": [...12] }    // = subscriptionStatus.active.count; trend uses paid subscription periods
  },
  "registrationTrend": { "range": "year", "points": [ {"key","label","value"} ] },   // libraries registered per bucket
  "librariesByPlan": { "total": 248, "items": [ { "planId": "..|null", "name": "Growth", "count": 128, "percent": 51.6 } ] },  // sorted by count desc, "No plan" row when planId null
  "revenueOverview": {
    "thisMonth": 148500, "lastMonth": 118800, "changePct": 25.0,
    "points": [ {"key","label","value"} ]                                            // 12 months, subscription revenue before GST
  },
  "recentRegistrations": [                                                          // newest 5
    { "id": "..", "name": "Apex Study Library", "ownerName": "Rakesh Meena", "plan": "Growth", "createdAt": "..", "status": "approved|pending|rejected|suspended", "logo": "/uploads/..|null", "city": "..", "state": ".." }
  ],
  "subscriptionStatus": {
    "total": 248,
    "active":       { "count": 214, "percent": 86.3 },
    "expiringSoon": { "count": 18,  "percent": 7.3 },     // ends within 7 days
    "expired":      { "count": 16,  "percent": 6.5 },     // end date passed, or suspended for non-payment. total = active + expiringSoon + expired
    "trial": 12,                                           // informational: how many of "active" are trials (their end date is trialEndsAt)
    "suspended": 3                                         // informational: suspended by a superadmin for another reason (not in total)
  },
  "topLibraries": [ { "id": "..", "name": "..", "logo": "..|null", "students": 482 } ],      // top 5 by non-deleted students
  "studentGrowth": { "range": "year", "points": [ {"key","label","value"} ] },               // CUMULATIVE student count at the end of each bucket
  "paymentActivity": [ { "id": "..", "libraryId": "..", "libraryName": "..", "logo": "..|null", "amount": 1770, "status": "paid|failed", "at": "ISO" } ],   // latest 5 paid/failed subscription payments, amount = GST-inclusive amount charged; libraryName "Deleted library" when gone
  "pendingApprovals": { "count": 3, "items": [ { "id","name","ownerName","city","state","createdAt" } ] },
  "alerts": [ { "type","severity":"danger|warning|info","message","count" } ]               // same shape as the old dashboard
}
```

### 1.3 Library summary (`role: "admin" | "staff"`)

```jsonc
{
  "role": "admin",
  "generatedAt": "..",
  "greeting": { "userName": "Rahul Sharma", "libraryName": "Apex Study Library", "libraryLogo": "..|null", "today": "2026-10-24", "branchScope": "all|limited" },
  "permissions": {                       // everything the UI needs to hide controls; sections the user may not see are `null` below
    "students": true, "seats": true, "attendance": true, "fees": true, "notices": true,
    "quickActions": [ { "key": "add_student", "label": "Add Student", "to": "students/add-student", "allowed": true }, ... ]   // collect_fee, mark_attendance, manage_seats, add_notice too; `allowed:false` → hide
  },
  "kpis": {
    "totalStudents": { "value": 128, "changePct": 12.0, "spark": [...7] } | null,   // null without students.view
    "occupiedSeats": { "occupied": 96, "total": 120, "percent": 80.0 } | null,      // null without seats.view
    "feesCollected": { "value": 42500, "changePct": 18.0, "spark": [...7] } | null, // this IST month, net of refunds; null without fees.view
    "pendingFees":   { "amount": 12000, "students": 24 } | null                      // null without fees.view
  },
  "attendanceToday": { "present": 96, "absent": 22, "total": 128, "presentPercent": 75.0, "insideNow": 41 } | null,   // total = active students with a running plan; absent = max(total - present, 0)
  "membershipExpiring": { "count": 4, "items": [ { "id","studentId":"registration no|null","name","photo":"..|null","daysLeft":2,"expiryDate":".." } ] } | null,   // next 7 days, soonest first, max 5
  "recentStudents": [ { "id","name","photo","joinedAt","status":"active|inactive|leave|suspended","seat":"A-12|null" } ] | null,   // newest 5
  "feesCollection": { "range": "week", "total": 25400, "points": [ {"key","label":"Mon","value":2200} ] } | null,          // null without fees.view
  "seatLayout": {                                                  // null without seats.view
    "total": 120, "truncated": false,
    "counts": { "available": 24, "occupied": 96, "reserved": 0, "maintenance": 0 },     // counts cover ALL seats; maintenance includes blocked
    "rows": [ { "row": "A", "seats": [ { "id": "..", "number": "A-1", "status": "available|occupied|reserved|maintenance" } ] } ]
  },
  "notices": [ { "id","title","type":"holiday|...|general","date":"ISO","pinned":false } ] | null    // latest 4 active notices (null without content.view)
}
```
Seat rows: grouped by the alphabetic prefix of the seat number (`A-12`, `A12`, `a 12` → row `A`); numbers without a prefix go to row `#`. Seats inside a row are sorted by their number. Max 400 seats are returned (`truncated: true` when `total` is larger than the seats returned; `counts`/`total` always cover every seat).

### 1.4 `GET /dashboard/charts?range=`

Superadmin: `{ range, registrationTrend, studentGrowth, revenueOverview }` (same shapes as 1.2, `revenueOverview` ignores range and is always 12 months).
Library: `{ range, feesCollection }` (`feesCollection` is `null` without `fees.view`).

### 1.5 `GET /dashboard/realtime-info`

```json
{ "socket": true, "path": "/socket.io", "transports": ["websocket","polling"], "url": "https://api.example.com|null", "pollIntervalMs": 30000 }
```
* `socket:false` → the UI must poll `/dashboard/summary` every `pollIntervalMs` (and when the tab regains focus).
* `url` is `SOCKET_PUBLIC_URL` when set (use it when the socket server is on another host than the REST API), otherwise `null` = same origin as the API.
* On Vercel (serverless) `socket` is always `false`.

## 2. Socket.io

Server: Socket.io v4 at path `/socket.io` on the same HTTP server as the API (long-running Node host only).

### 2.1 Connect + auth
```js
io(API_ORIGIN, {
  path: "/socket.io",
  auth: (cb) => cb({ token: <current access JWT> }),   // function form → fresh token on every reconnect
  transports: ["websocket", "polling"],
});
```
The token is verified exactly like the HTTP `Authentication` middleware (live session, user active, library active, `tokensValidAfter`, impersonation issuer). Failure → `connect_error` with `err.message` in `unauthorized | forbidden | library_inactive`; do not retry blindly, refresh the access token first.
* Allowed origins = `config/cors.js` (exact list). Browsers from other origins are refused.
* The server disconnects a socket when its access token expires (`auth:expired` is sent first) or when its session is revoked (checked every 60 s, `auth:revoked`). Reconnect with a fresh token.
* Clients should not send events. The server drops sockets that send more than 20 events / 10 s. Max message size 8 KB. Max 20 new connections / minute / IP.
* Students may connect, but only receive `notification:new` for themselves.

### 2.2 Rooms (joined automatically, the client never chooses)
| Room | Who joins |
|---|---|
| `super` | superadmin |
| `lib:{libraryId}` | owner (admin) and staff **without** branch limits |
| `lib:{libraryId}:branch:{branchId}` | staff limited to those branches (one room per allowed branch). Unrestricted users do not join these, they get everything through `lib:{libraryId}`. |
| `lib:{libraryId}:fees` / `lib:{libraryId}:branch:{branchId}:fees` | same rule, but only users who have `fees.view` (owner always) |
| `user:{userId}` | every connection (own notifications) |
A superadmin acting with `?libraryId=` does not join library rooms (they use `super`).

### 2.3 Events (server → client). Payloads are counters / ids only, never names, mobiles or other personal data.

| Event | Rooms | Payload |
|---|---|---|
| `dashboard:invalidate` | library rooms (non-money widgets), `:fees` rooms (money widgets), `super` | `{ scope: "library"\|"platform", widgets: string[], at }` → refetch `/dashboard/summary` (or just those widgets via `/dashboard/charts`). Widget names: library `kpis, attendanceToday, membershipExpiring, recentStudents, feesCollection, seatLayout, notices`; platform `kpis, registrationTrend, librariesByPlan, revenueOverview, recentRegistrations, subscriptionStatus, topLibraries, studentGrowth, paymentActivity, pendingApprovals, alerts`. Clients may simply refetch everything, debounced 1–2 s. |
| `kpi:update` | library rooms / `super` | `{ key, value: number\|null, delta: number\|null }` e.g. `{ key:"totalStudents", value:null, delta:1 }`. `value:null` = unknown, apply the delta or refetch. Keys: library `totalStudents, occupiedSeats`; platform `totalLibraries, totalStudents`. |
| `attendance:checkin` | library rooms (branch aware) | `{ present, total, insideNow }` today's counters (sent after a check-in or check-out). |
| `payment:received` | `:fees` rooms | `{ amount, count: 1, kind: "collection"\|"refund" }` (`amount` positive; refunds have `kind:"refund"`). |
| `student:created` | library rooms | `{ count: 1 }` |
| `seat:changed` | library rooms | `{ seatId, status }` where status is the new seat status, or `released`. |
| `library:registered` | `super` | `{ libraryId, status: "pending" }` |
| `library:status` | `super` | `{ libraryId, status }` (approved/rejected/suspended/reinstated) |
| `subscription:changed` | `super` + `lib:{libraryId}` | `{ libraryId, state: "paid"\|"lapsed"\|"changed" }` |
| `maintenance:changed` | every connection | `{ refresh: true }` → call `GET /v1/public/maintenance-status`. Also sent once right after connect when maintenance blocks that user. |
| `notification:new` | `user:{userId}` for every in-app notification row created by the notification service; library rooms (branch aware) when a notice is created | `{ kind: "notice"\|"notification", id }` |
| `auth:expired`, `auth:revoked` | the socket | `{}` just before the server disconnects it. |

Every event is also followed by (or is) a `dashboard:invalidate`, so a client that only handles `dashboard:invalidate` + polling stays correct.

### 2.4 Failure modes the UI must handle
* `realtime-info.socket === false`, the socket cannot connect, or it drops: fall back to polling `pollIntervalMs` (default 30 s). Re-sync (one `/dashboard/summary` fetch) after every (re)connect.
* Multi-instance hosting without `REDIS_URL`: events only reach clients on the same instance. Poll as a safety net (e.g. 60 s) even when connected.

## 3. Server behaviour worth knowing

* **Who emits what** (all through `src/realtime/emitters.js`, fire-and-forget): student register/import/update/status/archive/plan changes, attendance check-in/out/scan/manual/correction/leave/absentee marking, payment collect/online finalize/refund and charge create/cancel/adjust/waive, seat create/update/assign/release/transfer/reserve/block/delete, library registered/approved/rejected/suspended/reinstated/deleted/created, subscription paid/failed/plan assigned/lapse run, notice created, notification rows created, maintenance applied. Changes made by a cron job that bypass those functions (for example membership auto-expiry) are picked up by the next poll or refetch, not pushed.
* **Branch unknown?** A money or charge event whose branch cannot be read from the result is sent to the library fee room only, so branch-limited staff see it on the next refetch/poll.
* **Cache:** `/dashboard/summary` and `/dashboard/charts` use a 20 s per-process cache (`DASHBOARD_CACHE_TTL_MS`); every emit above clears it for the library (and the platform where relevant). The greeting block is never cached.
* **Superadmin `?libraryId=`:** returns that library's owner summary with every section visible, and the `greeting.userName` of the superadmin.
* **Errors:** 400 invalid `range`/`branchId`, 401 no/expired token, 403 student or branch not allowed, 503 maintenance (body `{ maintenance:true, message, ... }`).
* **Environment:** `REALTIME_ENABLED=false` (turn sockets off), `SOCKET_PUBLIC_URL`, `REDIS_URL` (+ `@socket.io/redis-adapter`, `redis` installed), `DASHBOARD_CACHE_TTL_MS`, `DASHBOARD_POLL_INTERVAL_MS`, `SOCKET_MAX_CONN_PER_IP_MIN` (20), `SOCKET_MAX_PER_USER` (10), `SOCKET_SESSION_CHECK_MS` (60000).
* **Hosting:** real sockets need a long-running Node host (Render, Railway, Fly.io, VPS). On Vercel `realtime-info.socket` is `false` and the UI must poll.
* **Client events:** the server accepts none. Anything a client emits is answered with an `error` (`not_supported`) and floods are disconnected.
