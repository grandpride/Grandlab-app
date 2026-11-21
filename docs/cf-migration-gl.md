# Moving Grandlab apps to the new backend (Cloudflare) — the switch

The Grandlab apps still run on the self-hosted Supabase (`https://db.grandlab.com.my`). The new backend
(gl-api on Cloudflare Workers + D1, Better Auth login, tenant `gl`) is only used on a phone or PC where **the switch
is on**. With the switch off nothing changes: `gl-cf-client.js` and `gl-cf-page.js` are not even downloaded (each page
only has a small inline check of `localStorage.gl_backend`). Same design as the Grandpride Hub (`docs/cf-migration.md`
in grandpride-hub), adapted for Grandlab.

## Turn it on / off

| What | How |
|---|---|
| Turn ON (this browser only) | open any switched page with `?backend=cf`, e.g. `https://app.grandlab.com.my/gl-hub-v3.html?backend=cf` |
| Turn OFF | open any switched page with `?backend=sb` |
| Check | a blue **NEW SYSTEM · switch back** tag bottom-left; console shows `[gl-cf-page] … is using the NEW backend`; `localStorage.gl_backend` is `"cf"` |
| Manual | `localStorage.setItem('gl_backend','cf')` / `localStorage.removeItem('gl_backend')` |
| Test against a local Worker | `localStorage.setItem('gl_api_base','http://localhost:8787')` (remove it to go back to the default) |

- The switch is per browser (localStorage on `app.grandlab.com.my`). All Grandlab pages on that origin share it,
  including the pages `gl-hub-v3.html` shows in frames.
- Default API: `https://gl-api.jimmykuek94.workers.dev`, tenant `gl` (`/gl/auth/*`, `/gl/api/db`, `/gl/api/rpc/:name`,
  `/gl/api/storage/*`, and the new `/gl/public/db`, `/gl/public/rpc/:name` for guests — see "server needs").
- Everyone signs in once after switching on (sessions are not moved). The old logins are not touched:
  - **Staff** (reception login): old Supabase session stays in `gl_auth`; the new token is `gl_ba_token`. Switching back
    with `?backend=sb` finds the old `gl_auth` login still there.
  - **Customers** (PWA, SMS code): the new token is `gl_ba_token_cust` — a separate key so a customer login on a shop
    device never replaces the reception login (today the same split exists: `gl_session` vs `gl_auth`). The PWA keeps
    its session JSON in `gl_session`; when the switch is turned on, an old Supabase `gl_session` is put aside as
    `gl_session_sb`, and `?backend=sb` puts it back (the only thing the inline guard of `index.html` does when off, and
    only if `gl_session_sb` exists — it never exists unless the switch was used).

## Which pages follow the switch

| Page | Follows switch? | How |
|---|---|---|
| `gl-claim.html`, `gl-marketing.html`, `gl-ads.html`, `gl-mkt-calendar.html` | yes | own `supabase.createClient(...)`; the guard loads `gl-cf-client.js` + `gl-cf-page.js`, which make `createClient(<Grandlab URL>)` return the new client |
| `index.html` (customer PWA) | yes | direct `fetch` to Supabase REST / auth / storage; `gl-cf-page.js` answers those through `GLCF.handleSupabaseFetch` (no network to Supabase) |
| `gl-hub-v3.html`, `gl-platescan.html`, `gl-jobcard.html`, `gl-staff-appointment-FINAL.html`, `gl-customers.html`, `grandlab-pos-v2.html` | yes | as the first group. `gl-jobcard` and `gl-platescan` load supabase-js twice, so they have a 2nd one-line guard (`GLCF_PAGE.rewrap()`) after the 2nd `<script>` tag |
| all other pages (`gl-board`, `gl-tower*`, `gl-commission`, `gl-qc`, `gl-inspect*`, `gl-sa*`, `grandlab-admin`, …) | **no** — untouched | not in this step. Note: `gl-hub-v3` opens some of them in frames/tabs; they keep using Supabase (and their own old login) |

The **Grandpride access check** (`gp_staff.apps`, read with the anon key from `gpdb.grandlab.com.my` in gl-hub-v3,
gl-jobcard, gl-platescan) is NOT switched: `createClient(<Grandpride URL>)` still returns real supabase-js. It moves with
the Grandpride switch. It needs the staff email, which now comes from the new login (same email).

## Status per page (switch on, signed in on the new system)

| Page | Status | What does not work yet / notes |
|---|---|---|
| `gl-claim.html` | works (needs a Hub login first) | The page has its own claim users (`gl_claim_login` RPC) but **no Grandlab staff login**, and every `/gl/api/*` call needs one: sign in on gl-hub-v3 (reception) on the same device first; until then an orange bar says so. Receipts/PDF: storage bucket `gl-claims` (upload, remove, getPublicUrl → signed link, valid 7 days; the page's `?v=` cache-buster is kept harmless). |
| `gl-marketing.html` | works | needs composite `onConflict` `ym,bucket` and `campaign_name,period_start,period_end` on the server. |
| `gl-ads.html` | partial | **"Sync now"** (`functions.invoke('meta-sync')`) → "not supported" error. The hourly meta-sync cron must write the new DB (server side). `gl_wa_chat` / `gl_wa_msg` are written by the WhatsApp bridge, which must be re-pointed too. |
| `gl-mkt-calendar.html` | works | composite `onConflict` `ym,task_key`. |
| `index.html` (customer PWA) | partial | Works: SMS login (new customers are created by the server, same UUID for imported ones), profile, cars, packages, orders, check-in, bookings, referral, spin, rewards, wallet history, review-proof upload (`gl-review-proofs`). **Online payment (DOKU)** is blocked with a clear message ("Online payment is not on the new system yet. Please choose Pay at outlet…"): the DOKU function reads orders from the OLD database, so a payment would not be credited. **Push**: subscriptions are saved to the new `gl_push_subs`, but `push-send` still reads the old table, so no pushes reach a switched phone. WhatsApp OTP channel: not supported (the page uses SMS). |
| `gl-hub-v3.html` | works | dashboard counts + customer search. Pages it opens follow the switch only if they are in this list. |
| `gl-platescan.html` | works | embedded selects `gl_vehicles → gl_profiles(...)` / `gl_profiles → gl_vehicles(...)` are done by the client as a 2nd query. |
| `gl-jobcard.html` | works (realtime → polling) | `jobs-rt` realtime on `gl_jobs` becomes **polling: the job list reloads every 30 s while the page is visible** (and at once when it becomes visible again), instead of instantly. Embedded selects as platescan. |
| `gl-staff-appointment-FINAL.html` | works | embedded selects as platescan. |
| `gl-customers.html` | works | RPCs `gl_customer_list`, `gl_customer_detail`, `gl_due_by_plate`, `gl_mark_reminded`. |
| `grandlab-pos-v2.html` | works (data) | 14 RPCs (invoice numbers, wallet/points/package deduction, spin, membership). The Google Sheet mirror (Apps Script) still reads Supabase, so **sales made with the switch on do not reach the sheet** — do not use the POS for real sales with the switch on until the mirror is re-pointed (switch group G7). |

Not signed in on the new system: staff pages show an orange bar ("New system: not signed in — sign in again on this
page, or use the current system") and their own login gate, which now signs in on the new system. The PWA shows no bar
(guest mode is normal) but always shows the NEW SYSTEM tag.

**Important (data split):** with the switch on, everything is read from and written to the new database only. Until
the one-night switch-over (gl-app-usage.md, switch groups G1/G2/G7), use the switch for testing with test data.

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
| Edge functions | `functions.invoke()` → `CF_UNSUPPORTED`. `gl-cf-page.js` blocks direct `fetch` to `/functions/v1/*` on the Grandlab server with a 400 JSON error (DOKU: "Online payment is not on the new system yet…"). |

**Not supported yet (fails soft** — `{ data:null, error:{ code:'CF_UNSUPPORTED' } }` + one console warning, never a
partial query): realtime broadcast/presence; storage move/copy/signed upload URLs/FormData/list search;
other embeds, nested embeds, aliases, `!inner`; `contains`/`overlaps`/`textSearch`/`range*`/`*AllOf|AnyOf`, `not()`
other than `is`; more than one `or()`; `upsert({ignoreDuplicates})`; `csv/explain`; modifiers after `rpc()`;
`schema()`; `signUp`, WhatsApp OTP, phone+password, email links, `setSession`, admin API; REST `or=`/`and=` params,
`not.<op>` other than `not.is`, GET rpc, `fetch(Request)`. The list is `GLCF.UNSUPPORTED`.

Unsupported calls found in the switched pages today: **only** `gl-ads` `functions.invoke('meta-sync')` (checked
automatically over all 322 supabase-js calls and all 67 direct REST + 4 auth calls of index.html, see Tests).

## What the server (gl-api) must provide for these pages

General:
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

- `node --test tests/gl-cf-client.test.mjs` — no packages; fetch mocked. 70 tests: switch, phone normalisation,
  SMS login (send/verify/errors/no token/WhatsApp/customer key kept apart from staff key), staff login, exact JSON for
  ~27 shapes taken from every switched page, embeds (object/array/added join columns/errors/unsupported), polling
  realtime, storage (headers, signed link survives `?v=`, lazy sign, old links → keys), the PWA's `/auth/v1` and
  `/rest/v1` translation (anon → public route without token, user → `/api`), plus two automatic checks: **every
  supabase-js call in the 10 staff pages (322)** is evaluated against the client and must build a supported request
  (only `meta-sync` is not), and **every direct REST call in index.html (67, plus the 4 auth calls)** must be translated. A negative
  control checks the checker.
- `node tests/gl-check-syntax.mjs <files>` — `node --check` on the JS files and every inline script of the pages.
- `node tests/gl-switch.playwright.cjs <dir with the unchanged pages>` — headless Chromium, nothing on the network:
  - **Switch OFF**: 47 runs (11 pages × {all external blocked, supabase-js stub signed in} × {plain, `?backend=sb`}, plus
    index.html with a saved login, jobcard with `?plate=`): unchanged copy vs this copy give identical console messages,
    page errors, requested URLs, localStorage and page text; `gl-cf-*.js` never requested.
  - **Switch ON** (mocked Worker): each staff page uses the cf client, sends only `/gl/api/*` with the staff Bearer, never
    contacts Supabase, keeps `gl_auth`, shows the tag; Grandpride check still uses supabase-js; platescan search shows the
    embedded owner; jobcard `jobs-rt` polls; signed-out bars; PWA: old login put aside, guest reads public without token,
    SMS login through the page's own `sendOtp/verifyOtp`, profile read with the customer token, refresh, DOKU blocked,
    reload keeps the login, page logout ends the new session, `?backend=sb` restores the old login.

## Files

- `gl-cf-client.js` (new) — the client, `window.GLCF`. Loaded only when the switch is on.
- `gl-cf-page.js` (new) — glue: `createClient` → cf client (+ `rewrap()`), fetch adapter (REST/auth/storage, functions
  blocked), PWA login keep-aside, status tag/bar. Loaded only when the switch is on.
- 11 pages — one inline guard `<script>` each (right after the supabase-js tag; `index.html` before `</head>`);
  `gl-jobcard.html` and `gl-platescan.html` also one line after their 2nd supabase-js tag. Off = nothing else runs.
- `tests/gl-cf-client.test.mjs`, `tests/gl-switch.playwright.cjs`, `tests/gl-check-syntax.mjs` (new).
- Deploy note: no service-worker caching for these files (`sw.js` is push-only). GitHub Pages may cache up to ~10 min.
