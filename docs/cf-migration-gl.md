# Moving Grandlab apps to the new backend (Cloudflare) — the switch

The Grandlab apps still run on the self-hosted Supabase (`https://db.grandlab.com.my`). The new backend
(gl-api on Cloudflare Workers + D1, Better Auth login, tenant `gl`) is only used where **the switch is on**: either
that phone/PC chose it (`?backend=cf`), or — at go-live — the central setting in `gl-backend-config.js` says `"cf"`
for the page's **module**. With the switch off nothing changes: `gl-cf-client.js` and `gl-cf-page.js` are not even
downloaded (each page loads the tiny `gl-backend-config.js` and runs a 2-line inline check). Same design as the
Grandpride Hub (`docs/cf-migration.md` in grandpride-hub), adapted for Grandlab, plus per-module go-live.

**Every Grandlab page that talks to the backend now carries the switch: 47 pages** (list below). Pages with no
backend: `review.html`, `shuzi-yijing.html`, `GLboard/index.html` (video player), the PDFs/images.

## The go-live setting (`gl-backend-config.js`)

```js
window.GL_BACKEND_DEFAULT = "sb";
window.GL_BACKEND_MODULES = { core: "sb", customer: "sb", marketing: "sb", claim: "sb" };
```

Each word is `"sb"` (current system), `"cf"` (new system) or `"default"` (follow `GL_BACKEND_DEFAULT`). A module that
is not listed follows `GL_BACKEND_DEFAULT`. **It ships as `"sb"` everywhere = exactly today's behaviour.**

| This page's module is set to | Device chose nothing | Device opened `?backend=cf` | Device opened `?backend=sb` |
|---|---|---|---|
| `"sb"` | current system | new system (remembered) | current system (the device choice is cleared, as before) |
| `"cf"` (go-live) | **new system** | new system | **current system, remembered** (emergency fallback) |

- `?backend=auto` forgets the device choice (follows the setting again).
- The device choice (`localStorage.gl_backend`, `"cf"` or `"sb"`) is **one per browser, for all modules**.
  `?backend=sb` is only remembered when the page's own module is `"cf"`, so a device that switched back while testing
  is not stuck on the old system after go-live.
- If `gl-backend-config.js` cannot load, pages use the old rule (`localStorage.gl_backend === "cf"`).
- Status UI: the blue **NEW SYSTEM · switch back** tag only shows on a device switched **by hand**; after go-live
  (module `"cf"`) nobody sees it. Staff pages still show the orange "not signed in" bar when there is no new login.

### Modules (= switch groups of gl-platform `docs/step2/gl-app-usage.md`)

| Module | Pages | Switch group | Can go live… |
|---|---|---|---|
| `claim` | gl-claim | G1 (isolated) | first, any time. Needs a staff login on the new system (bar "sign in here", or the Hub). |
| `marketing` | gl-marketing, gl-ads, gl-mkt-calendar | G2 | after the hourly **meta-sync** runs on the Worker (`/gl/api/fn/meta-sync` + cron) and the **WhatsApp bridge** writes the new DB (below). Reads `gl_jobs`/`gl_payments` read-only: until `core` is live those numbers are the copy made at data cut-over (stale). |
| `core` | gl-hub, gl-hub-v3, gl-jobcard, gl-platescan, gl-staff-appointment-FINAL, gl-customers, grandlab-pos-v2, grandlab-pos, GLboard/gl-board, gl-tower, gl-tower-lite, gl-agents, gl-qc, gl-qc-addon, gl-inspect, gl-commission, gl-commission-centre, gl-daily, gl-statement, gl-ladder, gl-academy, gl-members, gl-warranty-admin, gl-coating-maintenance, gl-sa, gl-sa-admin, gl-sa-quote, gl-quote, gl-deck, gl-mia, grandlab-admin, grandlab-notify, grandlab-winback, gl-freewash, gl-spin, gl-giveaway, q | G3–G8 + G7 shop side | **the same night as `customer`** (one switch-over, G7): shop and customer app write the same rows (`gl_packages`, `gl_profiles` wallet/points, `gl_payments`, `gl_bookings`…). Together with the **Google Sheet mirror** re-point (below). |
| `customer` | index.html (customer PWA), receipt, gl-warranty, gl-inspect-view, gl-qc-view, gl-sa-accept | G7 customer side | with `core` (same commit: both words `"cf"`). |

### Go-live procedure (per module)

1. Server ready for that module (lead): data cut over, the RPCs / routes in "What the server must provide" below.
2. Test on one device with `?backend=cf` (everything) — or serve a copy of `gl-backend-config.js` with only that module
   `"cf"` (the Playwright test does this).
3. Change that module's word to `"cf"` in `gl-backend-config.js`, commit + push (GitHub Pages ~1–10 min).
   `core` + `customer`: one commit, both words, the same night as the Sheet mirror re-point.
4. Everyone using that module signs in once on the new system (sessions are not moved; staff: reception login on the
   Hub or the page's own login; customers: SMS code). Old logins (`gl_auth`, `gl_session`) are kept for going back.

Going back: one device → open any page of that module with `?backend=sb` (remembered until `?backend=auto`).
Everyone → change the word back to `"sb"` and push. Data written to the new system meanwhile is NOT copied back.

## Turn it on / off on one device (testing)

| What | How |
|---|---|
| Turn ON (this browser, all modules) | open any switched page with `?backend=cf`, e.g. `https://app.grandlab.com.my/gl-hub-v3.html?backend=cf` |
| Turn OFF | `?backend=sb` (before go-live it clears the choice; after go-live it is the remembered fallback) |
| Follow the central setting again | `?backend=auto` |
| Check | NEW SYSTEM tag bottom-left (hand-switched devices); console `[gl-cf-page] … is using the NEW backend`; `GL_BACKEND_PICK('core')` in the console |
| Test against a local Worker | `localStorage.setItem('gl_api_base','http://localhost:8787')` (remove it to go back to the default) |

- The switch is per browser (localStorage on `app.grandlab.com.my`). All Grandlab pages on that origin share it,
  including the pages `gl-hub-v3.html` shows in frames (each frame decides by its own module).
- Default API: `https://gl-api.jimmykuek94.workers.dev`, tenant `gl` (`/gl/auth/*`, `/gl/api/db`, `/gl/api/rpc/:name`,
  `/gl/api/storage/*`, `/gl/api/fn/:name`, `/gl/public/db`, `/gl/public/rpc/:name`, `/gl/files/*`).
- Logins are kept apart, old ones untouched:
  - **Staff**: old Supabase session stays in `gl_auth`; the new token is `gl_ba_token`. Switching back finds `gl_auth`.
  - **Customers** (PWA, SMS code): new token `gl_ba_token_cust` (a customer login on a shop device never replaces the
    reception login). The PWA keeps its session JSON in `gl_session`; when switched on, an old Supabase `gl_session`
    is put aside as `gl_session_sb`, and switching off puts it back.

## How each page follows the switch

| Kind | Pages | How |
|---|---|---|
| supabase-js, staff login of their own | gl-hub, gl-hub-v3, gl-jobcard, gl-platescan, gl-staff-appointment-FINAL, gl-customers, grandlab-pos-v2, gl-academy, gl-agents, gl-coating-maintenance, gl-commission, gl-daily, gl-deck, gl-inspect, gl-ladder, gl-members, gl-qc, gl-statement, gl-tower, gl-tower-lite, gl-warranty-admin, grandlab-winback, gl-marketing, gl-ads, gl-mkt-calendar | guard after the supabase-js tag loads `gl-cf-client.js` + `gl-cf-page.js`; `createClient(<Grandlab URL>)` returns the new client; the page's own login signs in on the new system. Pages that load supabase-js twice (gl-hub, gl-academy, gl-commission, gl-daily, gl-inspect, gl-jobcard, gl-ladder, gl-platescan, gl-qc, gl-statement) have a one-line `GLCF_PAGE.rewrap()` after the 2nd tag. |
| supabase-js, **no** Grandlab staff login of their own (`hubLogin`) | gl-claim, gl-commission-centre, gl-qc-addon, gl-quote, gl-sa, gl-sa-admin, gl-sa-quote, gl-mia, GLboard/gl-board | as above; signed out → orange bar "Sign in on the Hub (reception login) first, **sign in here**, or use the current system". "sign in here" opens a small email + password form (new system) and reloads the page. gl-commission-centre, gl-qc-addon, gl-quote, gl-sa-admin, gl-sa-quote send a signed-out user to `gl-hub.html` themselves (their own rule) — the Hub's login then signs in on the new system. |
| direct `fetch` to Supabase REST with a service / anon key (`restAuth:'token'`, `hubLogin`) | grandlab-admin, grandlab-pos (legacy), grandlab-notify (function only) | `gl-cf-page.js` answers the fetch (`GLCF.handleSupabaseFetch`) as **the staff login** (`/gl/api/*` + staff token), whatever key the page sends. grandlab-admin still asks for its "key" to unlock its screens (any text works on the new system; the login is what counts: role `admin` for catalogue/price/wallet writes). |
| customer PWA | index.html | direct REST/auth/storage `fetch` answered by `GLCF.handleSupabaseFetch` (customer token / public routes) |
| used without a login (`public`) | receipt, gl-warranty, gl-inspect-view, gl-qc-view, gl-sa-accept (links sent to customers / partners), gl-freewash, gl-spin, gl-giveaway (shop kiosks), q (QR router) | no bar; with no login every data call goes to `/gl/public/db` / `/gl/public/rpc/:name` **without a token** (like the anon key today); with a login on the device (e.g. a kiosk tablet signed in as reception), to `/gl/api/*`. |

The **Grandpride reads** (the access check `gp_staff.apps` in 14 pages + the Hub tile filter in gl-hub / gl-hub-v3, the people / attendance / fleet
in gl-tower / gl-tower-lite, the staff sync in gl-academy) go to gl-api `GET /gl/gpread/me|tower|staff-apps` through `gl-gp-read.js`, on **both**
switch settings (the old gateway `gpdb.grandlab.com.my` is stopped). The token is the Cloudflare login on "cf" and the Grandlab Supabase login
(`gl_auth`) on "sb". If the staff-list check itself cannot run, the guarded pages let the person in (`GLGP.GUARD_FAIL_OPEN = true` in `gl-gp-read.js`;
set it to `false` to block instead); only a clear "not in the staff list / no access to this app" blocks. Tests: `tests/gl-gp-read.test.mjs`, `tests/gl-gp-read.playwright.cjs`.

## Status per page (switch on, signed in on the new system)

Checked in a browser against a mocked Worker (tests below): every page loads with **no request to Supabase** and
sends its data calls to the API with the right token. "Needs server" = the RPC / route is still a TODO in
gl-platform `docs/step7/gl-api.md`; until it exists that call returns `PGRST202` / `42501` and the page shows its own error.

| Page | Module | Status | Notes / needs server |
|---|---|---|---|
| `gl-claim.html` | claim | works | needs a staff login: Hub, or the bar's "sign in here". Receipts/PDF: bucket `gl-claims` (signed links, 7 days). |
| `gl-marketing.html` | marketing | works | composite `onConflict` `ym,bucket`, `campaign_name,period_start,period_end`. |
| `gl-ads.html` | marketing | works | **"Sync now"** → `POST /gl/api/fn/meta-sync {force:true}` (needs the route). `gl_wa_chat`/`gl_wa_msg` come from the WhatsApp bridge (below). |
| `gl-mkt-calendar.html` | marketing | works | composite `onConflict` `ym,task_key`. |
| `index.html` (customer PWA) | customer | works / partial | SMS login, profile, cars, packages, orders, check-in, bookings, referral, spin, rewards, wallet, review proofs. **Online payment (DOKU)**: `${SENANGPAY_FN}/create` now → `POST /gl/api/fn/doku-create` (same body, customer token) — needs Agent K's route; `doku/notify` is server-to-server and blocked from the browser. Push: subscriptions saved to the new `gl_push_subs`; pushes need `/gl/api/fn/push-send` + the 3 crons on the Worker. Slot counting across customers (`gl_orders` by date) now returns only the caller's orders (server TODO). |
| `gl-hub-v3.html` | core | works | needs `gl_customer_list`. |
| `gl-hub.html` | core | works | own login; Grandpride gate unchanged. |
| `gl-platescan.html` | core | works | embedded selects done by the client as a 2nd query. |
| `gl-jobcard.html` | core | works (realtime → polling 30 s) | needs `gl_lookup_customer`, `gl_lookup_cars`, `gl_deduct_package`. |
| `gl-staff-appointment-FINAL.html` | core | works | needs `gl_lookup_customer`, `gl_lookup_cars`. |
| `gl-customers.html` | core | works | needs `gl_customer_list`, `gl_customer_detail`, `gl_due_by_plate`, `gl_mark_reminded`. |
| `grandlab-pos-v2.html` | core | works (data) | needs 14 RPCs (invoice numbers, deductions, spin, membership). **Do not take real sales on the new system before the Sheet mirror is re-pointed.** |
| `grandlab-pos.html` (legacy) | core | works (data) | REST incl. `or=` search; needs `gl_next_bill` (+ `gl_redeem_*`), table `gl_sales` (admin). Retire? |
| `GLboard/gl-board.html` (TV board) | core | works (realtime → polling **15 s**) | `gl_jobs` is staff-only now: the TV signs in once (bar "sign in here", reception login). |
| `gl-tower.html`, `gl-tower-lite.html` | core | works (realtime → polling **20 s**) | `gl-tower` "ask the agents" → `/gl/api/fn/agent-desk`. Grandpride attendance/fleet via `gp` unchanged. |
| `gl-agents.html` | core | works | `agent-desk` → `/gl/api/fn/agent-desk`. |
| `gl-qc.html`, `gl-inspect.html` | core | works | gl-inspect's WhatsApp **share link** becomes `<api>/gl/public/inspect?t=<token>` (needs that public route: preview tags + redirect to `gl-inspect-view.html`, as the old `inspect` function). |
| `gl-qc-addon.html` | core | partial | needs `qc_addon_agree/create/decline/month/pin_check/set_pin`. |
| `gl-commission.html`, `gl-daily.html`, `gl-ladder.html`, `gl-academy.html`, `gl-statement.html`, `gl-members.html`, `gl-coating-maintenance.html`, `gl-deck.html`, `grandlab-winback.html` | core | works | tables only (all in the server's policy list). |
| `gl-commission-centre.html` | core | partial | reads view **`gl_sa_comm_ledger`** (not in the server's policy list) + `qc_addon_month`. |
| `gl-warranty-admin.html` | core | works | "email certificate" → `/gl/api/fn/warranty-email`. |
| `gl-sa.html` | core | works | |
| `gl-sa-admin.html`, `gl-sa-quote.html` | core | partial | need `sa_add_partner`, `sa_quote_cancel`, `sa_quote_make_job`, view `gl_sa_comm_ledger`. |
| `gl-quote.html` | core | partial | needs `gl_quote_check_customer`. Its two `or()`s on `gl_services`: 1st on the server, 2nd applied in the browser. |
| `gl-mia.html` | core | partial | needs staff login (bar) + `gl_mia_login`, `gl_mia_user_*`; chat → `/gl/api/fn/mia`. |
| `grandlab-admin.html` | core | works (data) | as the **admin** login (role `admin`); image uploads → storage `gl-images`; push → `/gl/api/fn/push-send`. |
| `grandlab-notify.html` | core | works | push → `/gl/api/fn/push-send` with the staff login (the URL/key boxes are ignored on the new system). |
| `gl-freewash.html`, `gl-spin.html`, `gl-giveaway.html` (kiosks) | core | partial | guests may only read the catalogue (`gl_car_brands`, `gl_car_models`, `gl_spin_prizes` work). Their writes (`gl_walkin`, `gl_free_wash`, `gl_bookings`) and RPCs (`gl_walkin_find`, `gl_lookup_*`, `gl_spin_record`, `gl_spin_phone_taken`, `gl_freewash_plate_taken`) need **either** the kiosk tablet signed in as reception (then all go to `/gl/api/*`) **or** token/kiosk routes on the server. |
| `q.html` (My-QR router) | core | works | a staff device signed in on the new system (`gl_ba_token`) is recognised as staff (one guarded line) → referral code looked up on `/gl/api/db` → gl-customers. |
| `receipt.html` | customer | needs server | `gl_receipt_by_invoice` on `/gl/public/rpc` (public, token). |
| `gl-warranty.html` | customer | needs server | `gl_warranty_find` public (+ `gl_warranty_terms` is public already). |
| `gl-inspect-view.html` | customer | needs server | `get_inspection` public (token); photos from bucket `inspections` (served without `sig`). |
| `gl-qc-view.html` | customer | needs server | `qc_addon_public` public (token). |
| `gl-sa-accept.html` | customer | needs server | `sa_quote_public/view/catalogue/accept/confirm/decline` public (token). |

**Important (data split):** with the switch on, everything is read from and written to the new database only. Until
a module's go-live (data cut-over), use the switch for testing with test data.

## Realtime → polling

The new backend has no realtime. `channel().on('postgres_changes', …).subscribe()` keeps working: the callback runs on
a timer while the page is visible (and at once when it becomes visible again), payload
`{eventType:'*', table, new:{}, old:{}, cf_poll:true}`. All Grandlab realtime users just reload their list on any change.

| Page | Channel | Interval (ON) | Before |
|---|---|---|---|
| `GLboard/gl-board.html` (TV) | `board-rt` on `gl_jobs` | **15 s** (`pollMs:15000` in its guard) | instant |
| `gl-jobcard.html` | `jobs-rt` on `gl_jobs` | 30 s (default) | instant |
| `gl-tower.html`, `gl-tower-lite.html` | `gl-tower-jobs` on `gl_jobs` | **20 s** (+ their own 60 s reload) | instant |

Change an interval: `pollMs` in that page's guard `GLCF_PAGE_CFG`. A cheap "max(updated_at) of gl_jobs" endpoint
could later make polls lighter.

## Edge functions → new server routes (one table: `FUNCTION_ROUTES` in `gl-cf-client.js`)

Both `sb.functions.invoke(name, {body})` and `fetch(<Supabase>/functions/v1/<name>[/<sub>])` are sent as
`POST <api><route>` with the **same body** and `Authorization: Bearer <this page's login>` (the anon/service key the
page puts in its headers is dropped). Answers: `invoke` → supabase-js shape (`{data, error}`, non-2xx →
`FunctionsHttpError` with the Response as `context`); `fetch` → the server's Response untouched. No login → 401
without a request. A route set to `null` is blocked with a clear 400 message.

| Function (page) | Today | New route |
|---|---|---|
| `doku` `/create` (index.html online payment) | `db.grandlab.com.my/functions/v1/doku/create` (anon key) | `POST /gl/api/fn/doku-create` (customer token) |
| `doku-sandbox` `/create` | sandbox | `POST /gl/api/fn/doku-create` |
| `doku` `/notify`, `doku-sandbox`, `senangpay` | DOKU webhook / old | `null` (blocked from the browser; DOKU calls the Worker directly) |
| `push-send` (grandlab-admin, grandlab-notify) | service/anon key, **no auth check** today | `POST /gl/api/fn/push-send` (staff/admin login) |
| `meta-sync` (gl-ads "Sync now") | `functions.invoke` | `POST /gl/api/fn/meta-sync` |
| `mia` (gl-mia) | anon key | `POST /gl/api/fn/mia` |
| `agent-desk` (gl-agents, gl-tower) | staff JWT | `POST /gl/api/fn/agent-desk` |
| `warranty-email` (gl-warranty-admin) | staff JWT | `POST /gl/api/fn/warranty-email` |
| any other name | — | `POST /gl/api/fn/<name>` (`FUNCTION_DEFAULT_PREFIX`) |
| share link `inspect?t=` (gl-inspect builds it) | `…/functions/v1/inspect?t=` | `<api>/gl/public/inspect?t=` (`FUNCTION_LINKS`) |

Server-side only (no page calls them; must run on the Worker at go-live): crons `daily-greeting`, `maint-reminder`,
`spin-reminder`, meta-sync hourly; `tgbot`/`tgai` (Telegram `setWebhook`), `sa-quote` share link, DOKU `/notify`
(re-point the DOKU dashboard notify URL).

## Outside this repo: Google Sheet mirror and WhatsApp bridge

Neither is in this repo, so neither follows the switch. Both talk to Supabase directly and **must be re-pointed on
the night their data goes live**, or the new system's sales / chats never reach them.

### Google Sheet mirror (`gl-sheet-mirror-v2.gs`, Apps Script, time-triggered)

What it relies on today (from grandlab-pos-v2 comments, gl-platform `docs/step2`, and the project's operating notes — the script itself is not in this repo, so check it before the re-point):
- reads **`gl_payments`** (the payment's `items` snapshot, `method`, `net_paid`, `sale_date`, `voided`/`voided_at`
  — POS voids instead of deleting "so the sheet mirror can clear that row", and bumps **`sql_keyed_at`** on a date
  change "so the sheet mirror re-scans and moves the row"), **`gl_jobs`**, `gl_service_records` (service history),
  `gl_walkin` + `gl_packages` (models / balances, "Refresh balances + models").
- calls Supabase REST (`/rest/v1/...`) with a key from its Script Properties; no realtime (it polls on its trigger).

What it must call on the new API (module `core`, same night as `core` + `customer`):
1. **Login**: a dedicated staff account on the new system (Better Auth, role `staff`) for the script:
   `POST /gl/auth/sign-in/email {email, password}` → token in the `set-auth-token` response header; keep it in Script
   Properties; on any `401` sign in again (sessions slide 30 days). (Or a server-to-server secret route if the lead
   prefers — then only the URL/header changes.)
2. **Reads**: `POST /gl/api/db` with `Authorization: Bearer <token>` and the compat JSON, e.g.
   `GET /rest/v1/gl_payments?select=*&sql_keyed_at=gte.<t>&order=sql_keyed_at.asc&limit=500` becomes
   `{"table":"gl_payments","op":"select","columns":"*","filters":[["sql_keyed_at","gte","<t>"]],"order":[["sql_keyed_at",{"ascending":true,"nullsFirst":false}]],"limit":500}`.
   Answer `{data, error, count}` (not a bare array). Money = RM numbers, booleans true/false, timestamps UTC ISO with
   milliseconds (`…T…:…:….sssZ`; Postgres had microseconds), JSON columns as JSON. Page through with `offset`/`limit`.
3. **Writes**, if the script writes anything back (stamps): `op:"update"` with filters by `id` — never a filter-less
   update. Keep its safe menu items; the "re-scan" items work the same against the new API.
4. Check after re-point: one test sale on the new POS → appears on the sheet; edit its date → row moves; void → row clears.

### WhatsApp bridge (MIA WhatsApp / ads attribution)

What the repo shows: nothing in this repo calls it; it **writes** `gl_wa_chat`, `gl_wa_msg` (and `gl_leads`;
`gl_wa_draft` has no reader) which gl-ads reads (first message time, ad id per chat) and `agent-desk` reads.
On the new API these tables are staff read/write (`docs/step7/gl-api.md`).

What it must call on the new API (module `marketing`, before or with its go-live):
- same login as the mirror (own staff account, Bearer token, re-sign-in on 401);
- inserts/upserts via `POST /gl/api/db`: `{"table":"gl_wa_chat","op":"upsert","values":{…},"onConflict":"<its key, e.g. chat_jid>"}`,
  `{"table":"gl_wa_msg","op":"insert","values":[…]}` — upsert keys must be a primary key or a unique index on the
  server (send the list to the lead); timestamps as ISO strings, money (`paid_rm`) as RM.
- If it uses Supabase realtime or `functions/v1/mia`, those become polling / `POST /gl/api/fn/mia`.

## What `gl-cf-client.js` does

Same calls and the same `{ data, error }` / `{ data, error, count }` results as supabase-js v2, and exactly the
compat-contract JSON (`docs/api/compat-contract.md`) — the same code as the Hub's `cf-client.js` for:
select/insert/update/upsert/delete, `.select()` after a write, `eq neq gt gte lt lte like ilike in is`,
`not(col,'is',v)`, `filter`, `match`, one `or()`, `order` (Postgres null order sent explicitly), `limit`, `range`,
`single`, `maybeSingle`, `count`/`head`, `abortSignal`, `throwOnError`, `rpc()`, storage (upload/update/download/remove/
list/sign/sign-many/getPublicUrl), email+password login, getSession/getUser/signOut/onAuthStateChange, 401 → signed out.

**Grandlab additions:**

| Feature | What happens |
|---|---|
| `auth.signInWithOtp({phone})` | `POST /gl/auth/phone-number/send-otp {phoneNumber}`. Number normalised first: `012-345 6789`, `0123456789`, `60123456789`, `123456789` → `+60123456789` (`GLCF.normalizePhone`). |
| `auth.verifyOtp({phone, token, type:'sms'})` | `POST /gl/auth/phone-number/verify {phoneNumber, code}` → keeps `set-auth-token`, reads `/get-session` for the expiry, returns `{user, session}`. `user.phone` = digits (`60123456789`, like Supabase), placeholder email `…@phone.grandlab.invalid` shown as `''`. |
| PWA direct auth REST | `POST /auth/v1/otp`, `/auth/v1/verify` (Supabase-shaped session JSON + `_cf:true`), `/auth/v1/token?grant_type=refresh_token` (Better Auth sessions slide 30 days, so "refresh" = check the session; dead → 400 like Supabase), `?grant_type=password` (hidden test login), `/auth/v1/logout`, `GET /auth/v1/user`. |
| Guest reads | a request the page made with the anon key (`Authorization: Bearer <anon key>` = `apikey`) goes to `/gl/public/db` or `/gl/public/rpc/:name` **without** a token — like the anon role today. Logged-in calls go to `/gl/api/*` with the customer token. |
| Embedded selects | `gl_vehicles` + `gl_profiles(cols)` (object) and `gl_profiles` + `gl_vehicles(cols)` (array), join on `gl_vehicles.owner_id = gl_profiles.id`: base query, then `rel.select(cols).in(join, keys)`; join columns the page did not ask for are added and removed again. Others → not supported. |
| Realtime | `channel().on('postgres_changes', …, cb).subscribe()` → `cb` every 30 s while visible (payload `{eventType:'*', table, new:{}, old:{}, cf_poll:true}`), `SUBSCRIBED` status, `removeChannel` stops it. |
| `getPublicUrl` | returns the signed link from this page's upload with an empty `&_=` at the end, so a page that appends `?v=<time>` (gl-claim PDF link) does not break `sig`. |
| Old storage links | `https://db.grandlab.com.my/storage/v1/object/[public/]<bucket>/<path>` inside JSON written to the API → key `gl/storage/<bucket>/<path>` (PWA review proofs store such a link). |
| Edge functions | `functions.invoke(name, {body})` and page `fetch` to `/functions/v1/<name>[/<sub>]` → `POST /gl/api/fn/<route>` from `GLCF.FUNCTION_ROUTES` (one table, see "Edge functions" above), same body, this login's Bearer. `GLCF.functionLink(client, 'inspect', '?t=…')` → share link from `GLCF.FUNCTION_LINKS`. |
| Guest pages (`guestPublic`) | pages with `GLCF_PAGE_CFG.public`: with no login every `from()`/`rpc()` goes to `/gl/public/db` / `/gl/public/rpc/:name` without a token; with a login, to `/gl/api/*`. |
| Staff REST with a key (`restAuth`) | `handleSupabaseFetch(client, url, init, {anon:false})`: a service/anon key in the page's headers is treated as "the staff login" (grandlab-admin, grandlab-pos). |
| REST `or=(…)` | one flat `or=(a.op.v,b.op.v)` → `or()`; `*` in like/ilike values → `%` (grandlab-pos search, grandlab-admin phone lookup). Nested `and(`/`or(` → unsupported. |
| 2nd `or()` | the contract takes one `or`. A 2nd/3rd `or()` on a plain select (no limit/range/count/head/single/embed) is applied in the browser to all rows the server returns (columns it needs are added, then removed): gl-quote's service list. Otherwise unsupported. |
| Go-live setting | `GLCF.enabled(module)` / `applyUrlSwitch(search, module)` follow `gl-backend-config.js` when loaded (device choice, else the module's word); old rule without it. |

**Not supported yet (fails soft** — `{ data:null, error:{ code:'CF_UNSUPPORTED' } }` + one console warning, never a
partial query): realtime broadcast/presence; storage move/copy/signed upload URLs/FormData/list search;
other embeds, nested embeds, aliases, `!inner`; `contains`/`overlaps`/`textSearch`/`range*`/`*AllOf|AnyOf`, `not()`
other than `is`; more than one `or()` (except as above); `upsert({ignoreDuplicates})`; `csv/explain`; modifiers after `rpc()`;
`schema()`; `signUp`, WhatsApp OTP, phone+password, email links, `setSession`, admin API; REST `and=` / nested `or=` params,
`not.<op>` other than `not.is`, GET rpc, `fetch(Request)`. The list is `GLCF.UNSUPPORTED`.

Unsupported calls found in the switched pages today: **none** (checked automatically over all 662 supabase-js calls in
the 42 supabase-js pages, every direct REST call of index.html (67 + 4 auth), grandlab-admin (115), grandlab-pos (9),
q.html (1), and every edge-function call — see Tests). The checker lists one false alarm it cannot evaluate
(gl-inspect `ilike(field, …)`, column from a variable); that exact shape is tested by hand.


## What the server (gl-api) must provide for these pages

### Still missing for the pages (checked against gl-platform `docs/step7/gl-api.md`, 21 Nov 2026)

Generated from all 47 pages (every `from()`/`rpc()`/REST call) minus the server's policy list and ported RPCs:

| Needed | For | Route |
|---|---|---|
| `/gl/api/fn/<name>` for `doku-create`, `push-send`, `meta-sync`, `mia`, `agent-desk`, `warranty-email` | index, grandlab-admin/notify, gl-ads, gl-mia, gl-agents/gl-tower, gl-warranty-admin | POST, same body as the edge function, Bearer login (Agent K) |
| `GET /gl/public/inspect?t=` | gl-inspect share link | preview tags + redirect to gl-inspect-view (old `inspect` function) |
| public (token) RPCs: `get_inspection`, `qc_addon_public`, `sa_quote_public/view/catalogue/accept/confirm/decline`, `gl_receipt_by_invoice`, `gl_warranty_find` | gl-inspect-view, gl-qc-view, gl-sa-accept, receipt, gl-warranty | `/gl/public/rpc/:name` (today only `gl_app_spin_status` there) |
| view **`gl_sa_comm_ledger`** (select, staff) | gl-commission-centre, gl-sa-admin | `/gl/api/db` (not in the policy list) |
| staff RPCs `gl_customer_list/detail`, `gl_due_by_plate`, `gl_mark_reminded`, `gl_lookup_customer/cars`, `gl_deduct_package/wallet/points`, `gl_dec_service_stock`, `gl_next_invoice_no(_for_date)`, `gl_member_quote`, `gl_grant_membership_phone`, `gl_redeem_claim/package/reward`, `gl_spin_find/redeem` | hub-v3, customers, jobcard, appointment, POS v2 | already TODO in gl-api.md |
| staff RPCs `qc_addon_agree/create/decline/month/pin_check/set_pin`, `sa_add_partner`, `sa_quote_cancel/make_job`, `gl_quote_check_customer`, `gl_mia_login`, `gl_mia_user_list/save/delete`, `gl_next_bill` (legacy POS) | gl-qc-addon, gl-commission-centre, gl-sa-admin/quote, gl-quote, gl-mia, grandlab-pos | `/gl/api/rpc/:name` |
| kiosk: `gl_walkin_find`, `gl_spin_record`, `gl_spin_phone_taken`, `gl_freewash_plate_taken` + `gl_walkin`/`gl_free_wash`/`gl_bookings` writes | gl-freewash, gl-spin, gl-giveaway | staff login on the kiosk tablet (works with the RPCs above) **or** dedicated kiosk routes |
| a staff account for the Google Sheet mirror and one for the WhatsApp bridge | Apps Script, bridge | see "Outside this repo" |

General (from the first step; 1–9 are done in gl-api step 7):
1. **`/gl/api/db` + `/gl/api/rpc/:name` + `/gl/api/storage/*`** for tenant `gl` with the same contract as `/gp/*`
   (today only `/gl/api/me` exists). Role mapping: today's "reception UID" RLS → `staff` (import the reception account
   `9684de35-a49c-4630-b02b-a1deb8d52e6f` with role `staff` via `gl-roles.json`); customer RLS (`owner_id = auth.uid()`,
   `id = auth.uid()`) → `own:<column>`.
2. **Public (no-login) routes** `POST /gl/public/db` (select only) and `POST /gl/public/rpc/:name`, rate-limited, for
   what the anon role may do today. Tables the PWA reads with the anon key: `gl_onboarding_slides, gl_settings,
   gl_services, gl_categories, gl_stores, gl_brands, gl_flash_deals, gl_car_brands, gl_car_models, gl_rewards`.
   Guests also hit it through `authHeaders()` (anon key when no login): `gl_membership_tiers, gl_spin_settings,
   gl_spin_prizes` (select) and rpc `gl_app_spin_status`. Anything not allowed → `42501` (the page falls back quietly).
3. **Phone login**: `phoneNumber` plugin is in `src/index.ts`; needs the Twilio secrets, the `+60` validator (done),
   users imported with `phoneNumber` (+60…) so imported customers keep their UUID. `ALLOWED_ORIGINS_GL` must contain
   `https://app.grandlab.com.my` (it does) and expose `set-auth-token` (it does).
4. New customers (created on first SMS verify) get a new UUID; the PWA then upserts `gl_profiles` (id = uid) and calls
   `claim_walkin_by_phone`, `claim_spin_wins_by_phone`, `gl_app_claim_pending` — those RPCs must exist (customer role,
   user id from the session, never from the body).
5. `or()` values contain dots, `%`, `+` and emails (`phone.eq.+60123…`, `name.ilike.%ali%`, `owner_id.eq.<uuid>`):
   split each condition on the first two dots only.
6. Upserts without `onConflict` use the primary key (`gl_board_config` id, `gl_jobs` id, `gl_profiles` id,
   `gl_push_subs` id). Composite `onConflict`: `gl_month_counts (ym,bucket)`, `gl_ad_imports (campaign_name,period_start,period_end)`,
   `gl_mkt_tasks (ym,task_key)`, `gl_checkins (owner_id)`.
7. REST values arrive as strings (`id=eq.5` → `"5"`, `active=eq.true` → `"true"`): compare with column affinity /
   booleans as 0/1.
8. Money columns (`gl_payments`, `gl_jobs.total`, `gl_unpaid`, `gl_profiles.wallet`, packages…) stay RM numbers at the API.
9. Storage buckets `gl-claims` (staff) and `gl-review-proofs` (customer, path starts with the user id), keys
   `gl/storage/<bucket>/<path>`, signed links `/gl/files/<key>?exp=&sig=` that **ignore extra query params** (`&_=`, `?v=`),
   and own signed links turned back into keys on write (as `/gp`).
10. Realtime: nothing (the client polls). A cheap "max(updated_at) of gl_jobs" endpoint could later replace the 30 s reload.

Per page (tables → ops; `count` = head/count query; `or` = uses or()):

| Page | Tables / ops | RPCs | Other |
|---|---|---|---|
| gl-claim | `gl_claim_users` count/select, `gl_claim_categories` select/insert/update, `gl_claim_items` select/insert/update/delete, `gl_claim_batches` count/select/insert(+returning single)/update | `gl_claim_first_admin`, `gl_claim_login`, `gl_claim_add_user`, `gl_claim_set_password` | storage `gl-claims` upload/remove/getPublicUrl; role `staff` |
| gl-marketing | `gl_month_counts` select/upsert, `gl_campaigns` select/insert/update/delete, `gl_ad_imports` select/upsert, `gl_jobs` select (5000), `gl_payments` select | — | composite onConflict |
| gl-ads | `gl_meta_ad`, `gl_meta_campaign`, `gl_meta_ad_daily` (20000 rows), `gl_wa_chat`, `gl_wa_msg`, `gl_meta_sync_log` select | — | edge function `meta-sync` (cron + manual) |
| gl-mkt-calendar | `gl_mkt_tasks` select/upsert | — | |
| index.html (customer) | public: see 2. Customer (`own:`): `gl_profiles` select/upsert/update, `gl_vehicles` select/insert/delete, `gl_packages`, `gl_package_rewards`, `gl_redemptions` (by `package_id` and `owner_id`), `gl_claims` select/insert, `gl_checkins` select/upsert, `gl_service_records` select (by `vehicle_id`, `owner_id`), `gl_orders` select/insert/update (also select by `order_ref` and by `appointment_date`/`status` across customers for slot counting — copy today's RLS), `gl_referrals` (referrer_id), `gl_mystery_draws` select/update, `gl_flash_grabs`, `gl_bookings`, `gl_feedback`, `gl_spin_review_proofs` insert, `gl_push_subs` upsert, `gl_payments` (customer_id), `gl_wallet_txns`, `gl_point_txns`, `gl_spin_wins` select; `gl_profiles` select by `referral_code` | `claim_walkin_by_phone`, `claim_spin_wins_by_phone`, `gl_app_claim_pending`, `gl_subscribe_with_credit`, `gl_grab_flash`, `gl_app_pay_order_wallet`, `gl_app_create_order_package`, `gl_app_spin_status`, `gl_app_spin_record`, `gl_app_redeem_reward`, `gl_apply_referral` | storage `gl-review-proofs`; edge `doku` (blocked), `push-send` |
| gl-hub-v3 | `gl_jobs`, `gl_payments`, `gl_qc` select; `gl_bookings`, `gl_service_records` count | `gl_customer_list` | |
| gl-platescan | `gl_walkin` select/insert/update/delete (or), `gl_vehicles` select/insert/delete, `gl_profiles` select, `gl_service_records` select/insert/delete(+returning) (or), `gl_jobs` select (or), `gl_payments`, `gl_bookings`, `gl_inspections`, `gl_car_brands`, `gl_car_models`, `gl_services` select, `gl_packages` select/insert/update, `gl_pending` select/insert/update/delete | — | embeds (client) |
| gl-jobcard | `gl_jobs` select/insert/upsert/update/delete, `gl_bookings` select/insert/update/delete, `gl_walkin` select/insert/update, `gl_board_config` select/upsert, `gl_settings`, `gl_services`, `gl_car_brands`, `gl_car_models`, `gl_profiles`, `gl_qc`, `gl_inspections` select, `gl_vehicles` select/insert, `gl_packages` select/update, `gl_service_records` insert | `gl_lookup_customer`, `gl_lookup_cars`, `gl_deduct_package` | realtime → polling; embeds |
| gl-staff-appointment-FINAL | `gl_bookings` select/insert/update, `gl_free_wash` select/update, `gl_walkin` select/insert/update, `gl_vehicles` select/insert(+returning), `gl_profiles` select (or), `gl_packages`, `gl_services`, `gl_car_brands`, `gl_car_models` select | `gl_lookup_customer`, `gl_lookup_cars` | embeds |
| gl-customers | `gl_walkin` insert/update(in), `gl_packages` select/insert/update, `gl_profiles`, `gl_car_brands`, `gl_car_models` select | `gl_customer_list`, `gl_customer_detail`, `gl_due_by_plate`, `gl_mark_reminded` | |
| grandlab-pos-v2 | `gl_jobs` select/update, `gl_payments` select/count/insert/update(+returning) (or), `gl_unpaid` select/insert/update/delete, `gl_packages` select/insert/update, `gl_walkin` select/insert/update (or), `gl_profiles` select (or), `gl_spin_wins` update/delete, `gl_warranties` select/insert, `gl_warranty_products`, `gl_services`, `gl_board_config`, `gl_car_brands`, `gl_car_models` select | `gl_next_invoice_no`, `gl_next_invoice_no_for_date`, `gl_lookup_customer`, `gl_member_quote`, `gl_deduct_package`, `gl_deduct_wallet`, `gl_deduct_points`, `gl_dec_service_stock`, `gl_redeem_claim`, `gl_redeem_package`, `gl_redeem_reward`, `gl_spin_find`, `gl_spin_redeem`, `gl_grant_membership_phone` | sheet mirror re-point (G7) |

(Lists are generated from the live page files, so they include calls newer than `docs/step2/gl-app-usage.md`, e.g.
`gl_member_quote`, `gl_grant_membership_phone`, `gl_subscribe_with_credit`.)


## Tests

- `node --test tests/gl-cf-client.test.mjs` — no packages; fetch mocked. **90 tests**: switch, phone normalisation, SMS
  login, staff login, exact JSON for the query shapes of the pages, embeds, polling realtime, storage, the PWA's
  `/auth/v1` and `/rest/v1` translation, plus (new) **go-live setting** (`gl-backend-config.js` run in a VM: ships
  `"sb"`, `?backend=cf|sb|auto`, one module live, `"default"` → `GL_BACKEND_DEFAULT`, `GLCF.enabled(module)`),
  **edge functions** (route table; every `/functions/v1/*` and `functions.invoke` found in the pages has a route;
  invoke/fetch shapes, DOKU create with the customer token, blocked/401/network cases, share link), **guest pages**
  (public routes without token / `/api` with a login), **staff REST with a key**, REST `or=`, **2nd `or()` in the
  browser**, and automatic checks: **every supabase-js call in all 42 supabase-js pages (662)** must build a
  supported request; **every direct REST call** in index.html (67 + 4 auth), grandlab-admin (115), grandlab-pos (9),
  q.html (1) must be translated. A negative control checks the checker.
- `node tests/gl-check-syntax.mjs gl-cf-client.js gl-cf-page.js gl-backend-config.js *.html GLboard/gl-board.html` —
  `node --check` on every inline script (125/125).
- `node tests/gl-switch.playwright.cjs <dir with the unchanged pages>` — headless Chromium, nothing on the network
  (supabase-js and three.js replaced by local stubs, the Worker mocked). `PW_ONLY=a.html,b.html` limits the pages,
  `PW_CONCURRENCY` (default 6). About 6 minutes:
  - **A. Switch OFF: 192 runs** (47 pages × {all external blocked, supabase-js stub signed in} × {plain, `?backend=sb`},
    plus index.html with a saved login, jobcard `?plate=`, grandlab-admin with its key): unchanged copy vs this copy give
    **identical** console messages, page errors, requested URLs (the only extra request allowed: `gl-backend-config.js`),
    localStorage and page text; `gl-cf-*.js` never requested; `gl_backend` never written.
  - **B. Switch ON** (mocked Worker), all 46 staff/guest pages twice: signed in as staff → cf client in use, no
    request to Supabase, all data calls on `/gl/api/*` with the staff Bearer, `gl_auth` kept, tag shown; signed out →
    staff pages show the bar (`hubLogin` pages offer "sign in here"; pages that send you to the Hub themselves are
    noted), guest pages read `/gl/public/*` without a token. Plus: platescan embed, Grandpride check still supabase-js,
    jobcard / TV board / tower(-lite) polling ticks reload `gl_jobs`, gl-ads "Sync now" → `/gl/api/fn/meta-sync`,
    bar sign-in on gl-claim (wrong password shown, then signed in), grandlab-admin service-key REST → `/gl/api/db`
    with the staff token, q.html staff route, the full customer PWA flow (old login aside, SMS login, refresh,
    **DOKU create → `/gl/api/fn/doku-create` with the customer token**, `/notify` blocked, logout, back to `sb`).
  - **C. Go-live setting** (the mock server serves edited copies of `gl-backend-config.js`): `claim:"cf"` → gl-claim on
    the new system with no `?backend`, no tag, gl-hub-v3 / gl-jobcard unchanged; `?backend=sb` remembered fallback;
    `?backend=auto` back; `marketing:"cf"` → exactly the 3 marketing pages move; `GL_BACKEND_DEFAULT:"cf"` + `"default"`
    → customer app and TV board on the new system.

## Files

- `gl-backend-config.js` (new) — the go-live words (`GL_BACKEND_DEFAULT`, `GL_BACKEND_MODULES`) + `GL_BACKEND_PICK()`,
  `GL_BACKEND_SOURCE()`, `GL_BACKEND_MODULE_SETTING()`. Loaded with a plain `<script>` right before each page's guard.
- `gl-cf-client.js` — the client, `window.GLCF` (loaded only when on). New: `FUNCTION_ROUTES` / `FUNCTION_LINKS`
  (the one place to adjust server function paths), `functions.invoke`, `handleFunctionFetch`, `functionLink`,
  `guestPublic`, `handleSupabaseFetch(…, {anon})`, REST `or=`, browser-side 2nd `or()`, `enabled(module)`.
- `gl-cf-page.js` — glue (loaded only when on). New: functions → `GLCF.handleFunctionFetch`, `public` / `restAuth` /
  `module` / `pollMs` options, tag only on hand-switched devices, "sign in here" form on `hubLogin` pages,
  `GLCF_PAGE.functionLink()`.
- 47 pages — `<script src="gl-backend-config.js">` + one inline guard (after the first supabase-js tag; before
  `</head>` on index.html, grandlab-admin, grandlab-notify, grandlab-pos, q.html; `../` paths in GLboard/gl-board.html);
  a one-line `GLCF_PAGE.rewrap()` after a 2nd supabase-js tag (10 pages). Two guarded one-liners in page code (do
  nothing when off): gl-inspect.html share link, q.html staff token.
- `tests/gl-cf-client.test.mjs`, `tests/gl-switch.playwright.cjs`, `tests/gl-check-syntax.mjs` (skips `importmap`).
- Deploy note: no service-worker caching for these files (`sw.js` is push-only). GitHub Pages may cache up to ~10 min,
  so a go-live word change reaches phones within minutes (a page already open keeps its old answer until reloaded).
