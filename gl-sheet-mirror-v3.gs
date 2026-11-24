/**********************************************************************
 * GRANDLAB — Structured Sheet Mirror (v3.0)
 *
 * v3.0 CHANGE (backend switch, additive):
 *   - New Script Property BACKEND = "supabase" (default) | "cf"  ("cloudflare" = same as "cf").
 *     "supabase": EVERYTHING works exactly like v2.9d (same URLs, same keys,
 *                 same menu, same sheet writes).
 *     "cf":       the same reads go to the new Cloudflare backend (gl-api,
 *                 read-only route /gl/mirror/*) instead of Supabase.
 *   - Every database read goes through ONE function, glFetch_(). In "cf" mode
 *     it translates the Supabase URL into the gl-api JSON request (same
 *     table, columns, filters, order, limit) and hands back the same rows.
 *   - "cf" needs 2 more Script Properties: CF_API_BASE and CF_MIRROR_KEY
 *     (the key is read-only, never written in this file, never logged).
 *   - TEST_backend(): read-only connection check (logs row counts only).
 *   - setKey() no longer contains a key in the code (paste, run, clear).
 *   Nothing else changed: no new menu items, no new re-scan behaviour.
 *
 * v2.9d CHANGE (quota + layout):
 * v2.9d CHANGE (quota + layout):
 *   - OVERNIGHT PAUSE: the auto-sync now skips 12am-8am MYT (shop closed,
 *     nothing to sync) to rest the daily UrlFetch quota. The menu "Sync now"
 *     still forces a run anytime (syncNowMenu_). Trigger runs respect the pause.
 *   - HOURLY REFRESH (v2.9c): refreshRecentRows_ (per-plate model/balance
 *     fetches) now runs at most ONCE PER HOUR, not every minute. This was the
 *     main quota drain that stalled ALL syncing once exhausted.
 *   - fetchRows_ now catches the quota-exhausted throw and logs it clearly.
 *   - DEBUG_quota(): one-click test to confirm if the daily quota is the blocker.
 *   - FIX MONTH TOTAL POSITION: new menu item "⬇️ Fix MONTH TOTAL position"
 *     moves a misplaced MONTH TOTAL row back to the bottom (below the last day
 *     block). Also ensureMonthBuilt_ now won't rebuild a month that already has
 *     a MONTH TOTAL row even if the BUILT flag was cleared (prevents a
 *     duplicate day grid appended below the total).
 *
 * v2.9b CHANGE (quota fix):
 *   - Root cause of "nothing syncs today": Google daily UrlFetch quota was
 *     exhausted. Biggest drain = per-plate package-balance RPC firing once
 *     per job on every placement/refresh/re-scan.
 *   - Added a per-sync package cache (_PKG_CACHE): each unique plate/phone is
 *     fetched at most ONCE per run instead of 1-3x per job. Big fetch cut.
 *   - DEBUG_unpaid() helper added for diagnosing unpaid sync.
 *   NOTE: quota resets at midnight Pacific; after reset, normal sync works.
 *
 * v2.9a CHANGE (additive):
 *   - Unpaid self-heal: if an UNPAID record's job row is missing from the
 *     sheet (deleted or never placed), syncUnpaid_ now CREATES a workshop
 *     row from the unpaid record itself and marks it red. Fixes workshop
 *     washes marked unpaid in POS that didn't appear on the sheet.
 *   - New menu: "♻️ Re-scan unpaid (fix missing UNPAID)" to re-check all
 *     unpaid records (needed once to recover ones the marker already passed).
 *
 * v2.9 CHANGE:
 *   - REVERTED the v2.8 "collapse all days every sync". Empty slot rows on
 *     today + future are kept again (fixed slot grid restored as default).
 *     Past days still auto-compact once per day (v2.7 behaviour).
 *   - NEW menu: "🧱 Restore time slots (today + future)" — surgically
 *     re-inserts any MISSING slot times into today/future day blocks
 *     without wiping, to rebuild the grid on days that were emptied.
 *
 * v2.8 CHANGE (behavior change, requested):
 *   - Empty time-slot rows are now COLLAPSED on EVERY day (not just past
 *     days) on EVERY sync. Days show only filled rows for a tighter sheet.
 *     Trade-off: today's open slots disappear, so a new booking lands as a
 *     walk-in-style row (findSlotRow_ falls back to findWalkinRow_) rather
 *     than a fixed timed slot. Separators, DAY/DATE labels, and totals are
 *     preserved. Manual "Compact past days" menu item still available.
 *
 *
 * v2.2b CHANGE (additive only):
 *   - Fix cross-day total bleed: after backdated row moves / mid-run row
 *     inserts, a daily total could include the previous day's sales.
 *     New recomputeAllDayTotals_() runs at the end of every syncNow() and
 *     authoritatively rebuilds every day block's total from live values,
 *     bounded strictly by the red separator. Self-correcting.
 *   - New GrandLab menu: "🧮 Rebuild daily totals (this tab)".
 *
 * v2.2a CHANGE (additive only):
 *   - PAY BY (col N) now filled from gl_payments.method via prettyMethod_().
 *   - Bathe Essence / package balance remark now falls back to a live
 *     gl_walkin lookup by plate (walkinPkg_) when the job has no
 *     pkg_balance_after, e.g. "Balance Bathe Essence Package — 3 left".
 *   Nothing else changed.
 *
 * Builds formatted day blocks (fixed time slots), fills bookings into
 * matching slots, appends walk-ins below, draws red separators,
 * bold day headers, merged daily totals, and month totals at bottom.
 *
 * Reads from Supabase: gl_bookings + gl_jobs (workshop/showroom/WALK-IN)
 * + gl_payments (write-back of POS results).
 * Bound to the YEAR sheet (e.g. the 2026 spreadsheet).
 *
 * v2.1 CHANGE: walk-in job cards (cust_type='walkin') now also sync to
 * the sheet, placed in the walk-in area below the slots, using the real
 * customer name + contact. Workshop/showroom behaviour unchanged.
 *
 * v2.2 CHANGE: new syncPayments_() pass writes POS results onto the
 * already-placed job row:
 *   G  ATTENDEE  <- gl_payments.attendee (staff who served)
 *   M  TOTAL PAID -> "VOUCHER" when the sale was paid by a package (net 0)
 *   R  TUNAI    <- gl_payments.invoice_no      (the POS/GLIV code)
 *   S  INVOICE  <- gl_payments.sql_invoice_no  (keyed by reception later)
 *   T  PAYMENT  <- gl_payments.sql_payment_no  (keyed by reception later)
 * Rows are matched by plate within the payment's day block; falls back to
 * name if plate is blank. Nothing else changed.
 *
 * SETUP (run once):
 *   1. setKey()          - paste service_role key, run, then clear it
 *   2. setupTrigger()    - 1-min auto-sync
 * Manual: syncNow()
 * v3.0: after pasting this file do NOT run resetPaymentsMarker_() or any
 *   re-scan. The sync markers carry over as they are (both backends).
 *   cf setup: Script Properties BACKEND / CF_API_BASE / CF_MIRROR_KEY, then
 *   run TEST_backend() and read the log (see README-sheet-mirror-v3.md).
 **********************************************************************/

// ========================= CONFIG =========================
const SUPABASE_URL = "https://eychljpzorzmaveixlnu.supabase.co";
function svcKey_(){ return PropertiesService.getScriptProperties().getProperty("SUPABASE_SERVICE_KEY") || ""; }

// ========================= v3.0 DATA ACCESS LAYER =========================
// Script Properties (Project Settings -> Script Properties):
//   BACKEND        "supabase" (default when empty) or "cf" ("cloudflare" works too)
//   CF_API_BASE    e.g. https://gl-api.<account>.workers.dev   (cf only, no slash at end)
//   CF_MIRROR_KEY  the read-only sheet-mirror key                (cf only, SECRET)
// The rest of the script still builds Supabase REST URLs exactly as v2.9d.
// glFetch_() is the ONLY place that talks to a database:
//   supabase -> UrlFetchApp.fetch(url, opts) unchanged (byte-for-byte as v2.9d)
//   cf       -> URL translated to POST {CF_API_BASE}/gl/mirror/db (or /rpc/<name>)
//              and the answer turned back into the same rows Supabase returns.
// The cf route is READ-ONLY on the server (select only, fixed tables/columns).
// read the 3 settings once per execution (Script Properties reads have a daily quota)
var _BK_CACHE=null;
function bkCfg_(){
  if(!_BK_CACHE){
    const p=PropertiesService.getScriptProperties();
    _BK_CACHE={ b:p.getProperty("BACKEND"), base:p.getProperty("CF_API_BASE"), key:p.getProperty("CF_MIRROR_KEY") };
  }
  return _BK_CACHE;
}
function backend_(){
  const v=String(bkCfg_().b||"").trim().toLowerCase();
  if(v===""||v==="supabase") return "supabase";
  if(v==="cf"||v==="cloudflare") return "cf";   // "cloudflare" = same as "cf"
  return "invalid";
}
function cfBase_(){ return String(bkCfg_().base||"").trim().replace(/\/+$/,""); }
function cfKey_(){ return String(bkCfg_().key||"").trim(); }
function cfConfigOk_(){ return /^https:\/\/[^\/\s]+/.test(cfBase_()) && cfKey_().length>=32; }

/* Is the selected backend configured? Logs a plain reason when not (never the key). */
function backendReady_(){
  const b=backend_();
  if(b==="supabase"){
    if(!svcKey_()){ Logger.log("⚠️ No service key. Run setKey() first."); return false; }
    return true;
  }
  if(b==="cf"){
    if(!/^https:\/\/[^\/\s]+/.test(cfBase_())){ Logger.log("⚠️ BACKEND=cf but CF_API_BASE is missing or not https:// — sync skipped."); return false; }
    if(cfKey_().length<32){ Logger.log("⚠️ BACKEND=cf but CF_MIRROR_KEY is missing/too short — sync skipped."); return false; }
    return true;
  }
  Logger.log("⚠️ BACKEND Script Property must be \"supabase\" or \"cf\" (or \"cloudflare\") — sync skipped.");
  return false;
}

function glFetch_(url, opts){
  const b=backend_();
  if(b==="supabase") return UrlFetchApp.fetch(url, opts);
  if(b!=="cf" || !cfConfigOk_()) throw new Error("backend not configured (see BACKEND / CF_* Script Properties)");
  const req=restUrlToCf_(url, opts);
  // NOTE: opts.headers (Supabase key) are deliberately NOT forwarded.
  const res=UrlFetchApp.fetch(cfBase_()+req.path, {
    method:"post", contentType:"application/json",
    headers:{ "X-Mirror-Key": cfKey_() },
    payload:JSON.stringify(req.body),
    muteHttpExceptions:true
  });
  return cfAdapt_(res);
}

/* gl-api answers {data, error, count} with HTTP 200. Turn it into what the
   rest of the script expects from Supabase: HTTP 200 + JSON rows, or a
   non-200 code + error text (callers then skip, exactly like a Supabase error). */
function cfAdapt_(res){
  const code=res.getResponseCode();
  const text=String(res.getContentText()||"");
  const out=(c,t)=>({ getResponseCode:()=>c, getContentText:()=>t });
  if(code!==200) return out(code, "gl-api HTTP "+code+": "+text.slice(0,300));
  let j;
  try{ j=JSON.parse(text); }catch(e){ return out(502, "gl-api: answer was not JSON"); }
  if(!j || typeof j!=="object") return out(502, "gl-api: empty answer");
  if(j.error){
    const ec=String(j.error.code||"");
    const http = ec==="42501" ? 403 : (ec==="PGRST202" ? 404 : ((ec==="PGRST100"||ec==="22P02") ? 400 : 500));
    return out(http, "gl-api "+ec+": "+String(j.error.message||"").slice(0,300));
  }
  return out(200, JSON.stringify(j.data===undefined ? null : j.data));
}

/* Canonical timestamp for gl-api (D1 stores UTC text YYYY-MM-DDTHH:MM:SS.sssZ and
   compares it as text). Supabase-era markers look like 2026-11-21T10:00:00.123456+00:00;
   cut to milliseconds (same as the data load) so already-synced rows are NOT
   picked up again on switch day. Anything that is not a full timestamp is
   returned unchanged (dates, plates, numbers like gl_jobs.created_at). */
function cfTs_(v){
  const s=String(v);
  const m=s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/);
  if(!m) return v;
  const ms=parseInt(((m[7]||"")+"000").slice(0,3),10);
  let t=Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6], ms);
  const z=m[8]||"Z";
  if(z!=="Z"){
    const sign=z[0]==="-"?-1:1, d=z.slice(1).replace(":","");
    t-=sign*(parseInt(d.slice(0,2),10)*60+(parseInt(d.slice(2,4)||"0",10)))*60000;
  }
  const d=new Date(t);
  return isNaN(d.getTime()) ? v : d.toISOString();
}

/* PostgREST value -> gl-api filter value, per operator. */
function cfVal_(op, raw){
  if(op==="in"){
    if(!/^\(.*\)$/.test(raw)) throw new Error("cf: in() needs (a,b)");
    const inner=raw.slice(1,-1);
    return inner==="" ? [] : inner.split(",").map(x=>{ x=x.trim(); return (x.length>=2&&x[0]==='"'&&x[x.length-1]==='"')?x.slice(1,-1):x; });
  }
  if(op==="is"||op==="not.is"){
    const l=raw.toLowerCase();
    if(l==="null") return null; if(l==="true") return true; if(l==="false") return false;
    throw new Error("cf: is accepts null/true/false");
  }
  if(op==="like"||op==="ilike") return raw.replace(/\*/g,"%");
  if(raw==="true") return true;
  if(raw==="false") return false;
  return cfTs_(raw);
}
const CF_OPS_=["eq","neq","gt","gte","lt","lte","like","ilike","in","is","not.is"];
/* select=* is sent as an explicit column list, so a column the server does not
   allow makes the fetch FAIL (nothing written, marker not moved) instead of
   silently coming back empty. If this script starts reading another column of
   these tables, add it here AND to the server allow-list (gl-mirror-core.ts). */
const CF_STAR_COLS_={
  gl_jobs:"id,created_at,cust_type,services,pkg_balance_after,plate,hp,name,model,workshop_name,attendee,sent_by,dep_amt,dep_date,lead_source,referral_by_name,referral_by_ref,is_returning,slot_time,no_show,no_show_at",
  gl_bookings:"scheduled_at,created_at,notes,service_name,lead_source,amount_paid,referral_by_name,referral_by_ref,is_returning"
};
function cfSplitOp_(s){   // "gt.2026-..." -> ["gt","2026-..."]
  for(const op of ["not.is"].concat(CF_OPS_)){
    if(s.indexOf(op+".")===0) return [op, s.slice(op.length+1)];
  }
  throw new Error("cf: unsupported filter operator");
}

/* Translate one Supabase REST call (as built everywhere in this script) into
   a gl-api request. Supports exactly what the script uses: select, eq/gt/
   ilike/in (+ the other simple ops), or=(...), order=col.asc|desc, limit,
   offset, and POST /rpc/<name>. Anything else throws (=> treated as a failed
   fetch, nothing is written). */
function restUrlToCf_(url, opts){
  const s=String(url);
  const at=s.indexOf("/rest/v1/");
  if(at<0) throw new Error("cf: not a Supabase REST url");
  const rest=s.slice(at+9);
  const qAt=rest.indexOf("?");
  const path=qAt<0?rest:rest.slice(0,qAt);
  const query=qAt<0?"":rest.slice(qAt+1);
  if(path.indexOf("rpc/")===0){
    const name=path.slice(4);
    if(!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("cf: bad rpc name");
    let args={};
    if(opts && opts.payload){ args=JSON.parse(opts.payload); }
    return { path:"/gl/mirror/rpc/"+name, body:args };
  }
  if(!/^[a-z_][a-z0-9_]*$/.test(path)) throw new Error("cf: bad table name");
  const body={ table:path, op:"select", columns:"*", filters:[], order:[] };
  if(query){
    query.split("&").forEach(part=>{
      if(!part) return;
      const eq=part.indexOf("=");
      if(eq<0) throw new Error("cf: bad query part");
      const k=decodeURIComponent(part.slice(0,eq));
      const v=decodeURIComponent(part.slice(eq+1));
      if(k==="select"){
        body.columns=v.replace(/\s+/g,"")||"*";
        if(!/^(\*|[a-z_][a-z0-9_]*(,[a-z_][a-z0-9_]*)*)$/.test(body.columns)) throw new Error("cf: unsupported select (no embeds)");
        return;
      }
      if(k==="limit"){ if(!/^\d+$/.test(v)) throw new Error("cf: bad limit"); body.limit=parseInt(v,10); return; }
      if(k==="offset"){ if(!/^\d+$/.test(v)) throw new Error("cf: bad offset"); body.offset=parseInt(v,10); return; }
      if(k==="order"){
        v.split(",").forEach(o=>{
          const p=o.split(".");
          const col=p[0], dir=(p[1]||"asc").toLowerCase(), nl=(p[2]||"").toLowerCase();
          if(!/^[a-z_][a-z0-9_]*$/.test(col) || (dir!=="asc"&&dir!=="desc") || (nl && nl!=="nullsfirst" && nl!=="nullslast") || p.length>3)
            throw new Error("cf: unsupported order");
          const spec={ ascending: dir==="asc" };
          if(nl) spec.nullsFirst=(nl==="nullsfirst");
          body.order.push([col, spec]);
        });
        return;
      }
      if(k==="or"){
        if(!/^\(.*\)$/.test(v)) throw new Error("cf: or needs (...)");
        const conds=v.slice(1,-1).split(",").map(c=>{
          const d1=c.indexOf(".");
          const col=c.slice(0,d1);
          if(!/^[a-z_][a-z0-9_]*$/.test(col)) throw new Error("cf: bad or column");
          const sp=cfSplitOp_(c.slice(d1+1));
          if(sp[0]==="in") throw new Error("cf: in() inside or is not supported");
          const val=cfVal_(sp[0], sp[1]);
          return col+"."+sp[0]+"."+(val===null?"null":String(val));
        });
        body.or=conds.join(",");
        return;
      }
      if(!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error("cf: unsupported query part");
      const sp=cfSplitOp_(v);
      body.filters.push([k, sp[0], cfVal_(sp[0], sp[1])]);
    });
  }
  if(body.columns==="*"){
    if(!CF_STAR_COLS_.hasOwnProperty(path)) throw new Error("cf: select=* not mapped for this table");
    body.columns=CF_STAR_COLS_[path];
  }
  return { path:"/gl/mirror/db", body:body };
}

/* Read-only connection check for switch day. Run from the editor; read the log.
   Never writes to the sheet, never logs the key. */
function TEST_backend(){
  Logger.log("BACKEND = "+backend_()+(backend_()==="cf" ? (" | CF_API_BASE = "+cfBase_()+" | CF_MIRROR_KEY set = "+(cfKey_().length>=32)) : ""));
  if(!backendReady_()) return;
  const checks=[
    ["settings", SUPABASE_URL+"/rest/v1/gl_settings?id=eq.booking&select=data"],
    ["jobs",     SUPABASE_URL+"/rest/v1/gl_jobs?select=id&limit=1"],
    ["payments", SUPABASE_URL+"/rest/v1/gl_payments?select=id,paid_at&order=paid_at.desc&limit=1"],
    ["unpaid",   SUPABASE_URL+"/rest/v1/gl_unpaid?select=id&limit=1"],
    ["walkin",   SUPABASE_URL+"/rest/v1/gl_walkin?select=model,phone&limit=1"]
  ];
  checks.forEach(c=>{
    const rows=fetchRows_(c[1]);
    Logger.log((rows===null?"❌ ":"✅ ")+c[0]+": "+(rows===null?"FAILED (see line above)":(rows.length+" row(s)")));
  });
}
const SYNC_MINUTES = 1;   // Apps Script minimum for time-based triggers
const HEADER_ROW   = 1;   // row 1 = column headers in each month tab

// HARD GUARD: never build or touch any month before this date (protects June + earlier).
const MIRROR_START = new Date(2026, 6, 1); // 1 July 2026 (month is 0-indexed)
function beforeStart_(when){ return when < MIRROR_START; }

const TZ = "Asia/Kuala_Lumpur";

let SLOTS = [
  { time:"9:00 AM",  n:2 }, { time:"10:00 AM", n:2 }, { time:"11:00 AM", n:2 },
  { time:"12:00 PM", n:2 }, { time:"2:00 PM",  n:2 }, { time:"3:00 PM",  n:2 },
  { time:"4:00 PM",  n:2 }, { time:"5:00 PM",  n:2 },
];
let CLOSED_WEEKDAYS = [0];   // 0 = Sunday
let CLOSED_DAYS = {};        // { "YYYY-MM-DD": "Holiday name" }

function loadBookingCfg_(){
  try{
    const url=SUPABASE_URL+"/rest/v1/gl_settings?id=eq.booking&select=data";
    const res=glFetch_(url,{method:"get",headers:{apikey:svcKey_(),Authorization:"Bearer "+svcKey_()},muteHttpExceptions:true});
    if(res.getResponseCode()!==200) return;
    const rows=JSON.parse(res.getContentText());
    if(!rows.length || !rows[0].data) return;
    const cfg=rows[0].data;
    const per=parseInt(cfg.slotsPerTime)||2;
    if(Array.isArray(cfg.times) && cfg.times.length){
      SLOTS = cfg.times.map(t=>({ time:String(t).trim(), n:per }));
    }
    if(Array.isArray(cfg.closedWeekdays)) CLOSED_WEEKDAYS = cfg.closedWeekdays;
    if(CLOSED_WEEKDAYS.indexOf(0)<0) CLOSED_WEEKDAYS.push(0); // Sunday always closed
    CLOSED_DAYS = {};
    (cfg.closedDays||[]).forEach(d=>{ CLOSED_DAYS[d]=(cfg.closedNames&&cfg.closedNames[d])||"Closed"; });
  }catch(e){ Logger.log("cfg load skipped: "+e); }
}

const COL = {
  DAY:1, DATE:2, TIME:3, NAME:4, CONTACT:5, CUST_WHERE:6, ATTENDEE:7,
  CAR:8, PLATE:9, FROM_PRICE:10, DEPOSIT:11, DEP_DATE:12, TOTAL_PAID:13,
  PAY_BY:14, TOTAL_SALES:15, DAILY_SALES:16, REMARK:17, TUNAI:18,
  INVOICE:19, PAYMENT:20, REFERRAL:21, RETURNING:22
};
const LAST_COL = 22;

const HEADERS = ["DAY","DATE","TIME","NAME","CONTACT NO","CUST FROM WHERE","ATTENDEE",
  "CAR MODEL","NO PLATE","FROM PRICE","DEPOSIT","DEPOSIT DATE","TOTAL PAID","PAY BY",
  "TOTAL SALES (COMM)","DAILY SALES","REMARK","TUNAI","INVOICE","PAYMENT",
  "REFERRAL BY","RETURNING"];

const MONEY_COLS = [11,13,16];

const RED_BG  = "#F4C7C3";
const DAY_BG  = "#FFFFFF";

const PROP_LAST_B = "gl_bookings_last_synced_at";
const PROP_LAST_TU = "gl_topups_last_synced_at";
const PROP_LAST_J = "gl_jobs_last_synced_at";
const PROP_LAST_P = "gl_payments_last_synced_at";
const PROP_LAST_U = "gl_unpaid_last_synced_at";

// ========================= SETUP =========================
// Adds a "GrandLab" menu to the sheet so you can Sync now on the spot.
function onOpen(){
  SpreadsheetApp.getUi()
    .createMenu('GrandLab')
    .addItem('🔄 Sync now', 'syncNowMenu_')
    .addItem('🩹 Re-sync recent app bookings', 'reSyncRecentBookings_')
    .addItem('🧹 Clear duplicate top-ups', 'cleanDuplicateTopups_')
    .addItem('♻️ Re-scan recent jobs', 'resetJobsMarker_')
    .addItem('♻️ Re-scan recent payments', 'resetPaymentsMarker_')
    .addItem('♻️ Re-scan unpaid (fix missing UNPAID)', 'resetUnpaidMarker_')
    .addItem('🅰️ Apply Arial 7 + center to this tab', 'applyFontThisTab_')
    .addItem('🧹 Clear duplicates (this tab)', 'dedupeThisTab_')
    .addItem('🧹 Clear cross-day duplicates', 'dedupeCrossDay_')
    .addItem('🗑️ Compact past days (delete empty slots)', 'compactPastDays_')
    .addItem('🧱 Restore time slots (today + future)', 'restoreSlotsThisTab_')
    .addItem('🎨 Clear stray red (non-UNPAID)', 'clearStrayRedThisTab_')
    .addItem('🚫 Refresh absent styling (this tab)', 'refreshAbsentThisTab_')
    .addItem('🧮 Rebuild daily totals (this tab)', 'rebuildTotalsThisTab_')
    .addItem('⬇️ Fix MONTH TOTAL position (this tab)', 'fixMonthTotalPosition_')
    .addItem('🔖 Refresh balances + models (this tab)', 'refreshBalancesThisTab_')
    .addItem('🎯 Refresh source/referral/returning (this tab)', 'refreshSourceThisTab_')
    .addItem('🔁 Wipe + rebuild current month (from DB)', 'rebuildCurrentMonthClean_')
    .addToUi();
}
/* Set Arial 7 + centered across the currently-active month tab (for already-built tabs). */
function applyFontThisTab_(){
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const lastRow=sheet.getLastRow(), lastCol=Math.max(LAST_COL, sheet.getLastColumn());
  if(lastRow<1) return;
  const rng=sheet.getRange(1,1,lastRow,lastCol);
  rng.setFontFamily("Arial").setFontSize(7);
  rng.setHorizontalAlignment("center").setVerticalAlignment("middle");
  SpreadsheetApp.getActiveSpreadsheet().toast("Applied Arial 7 + centered to "+sheet.getName());
}
function setKey(){
  // v3.0: the key is NOT kept in the code any more. Paste it here, run setKey
  // once, then put the placeholder back before saving/sharing the script.
  const KEY = "PASTE_SERVICE_ROLE_KEY_HERE";
  if(KEY==="PASTE_SERVICE_ROLE_KEY_HERE"){ Logger.log("⚠️ Paste your service_role key into setKey first."); return; }
  PropertiesService.getScriptProperties().setProperty("SUPABASE_SERVICE_KEY", KEY.trim());
  Logger.log("✅ Service key saved.");
}
function setupTrigger(){
  ScriptApp.getProjectTriggers().forEach(t=>{ if(t.getHandlerFunction()==="syncNow") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("syncNow").timeBased().everyMinutes(SYNC_MINUTES).create();
  Logger.log("✅ Auto-sync every "+SYNC_MINUTES+" min.");
  syncNowMenu_();  // force-run (bypass overnight pause)
}

// ========================= MAIN SYNC =========================
// Global time budget: Apps Script kills a run at ~6 min. We stop placing new
// rows at 4.5 min so the finishing passes (dedupe/totals) can run, and so the
// markers we saved incrementally let the next run continue the backlog.
var SYNC_START_MS = 0;
var TIME_BUDGET_MS = 270000; // 4.5 min for placement work
function timeLeft_(){ return TIME_BUDGET_MS - (Date.now()-SYNC_START_MS); }
function outOfTime_(){ return timeLeft_() <= 0; }

// v2.9d: overnight pause. The shop is closed 12am-8am MYT, so there's nothing
// to sync then. Skipping those ~480 empty runs saves the daily UrlFetch quota
// and gives it a clean overnight rest. Manual runs still work (a person at the
// sheet clicking Sync now bypasses the pause). Automatic (trigger) runs during
// the closed window just return early.
const PAUSE_FROM_HOUR = 0;   // 00:00 (midnight) MYT
const PAUSE_TO_HOUR   = 8;   // 08:00 MYT — sync resumes at 8am
function inQuietHours_(){
  const h=parseInt(Utilities.formatDate(new Date(), TZ, "H"), 10);
  return (h>=PAUSE_FROM_HOUR && h<PAUSE_TO_HOUR);
}

function syncNow(){ syncNow_(false); }        // TRIGGER entry point (respects pause)
function syncNowMenu_(){ syncNow_(true); }    // MENU entry point (always runs)
function syncNow_(force){
  if(!backendReady_()) return;   // v3.0: supabase -> same "No service key" check as before
  // overnight pause (auto runs only; a forced/manual call still proceeds)
  if(!force && inQuietHours_()){
    Logger.log("😴 Quiet hours ("+PAUSE_FROM_HOUR+":00–"+PAUSE_TO_HOUR+":00 MYT) — skipping sync.");
    return;
  }
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(20000)){ Logger.log("Another sync running."); return; }
  SYNC_START_MS = Date.now();
  resetPkgCache_();   // fresh package-balance cache each run (cuts duplicate fetches)
  try{
    loadBookingCfg_();
    const props=PropertiesService.getScriptProperties();
    syncBookings_(props);
    syncTopups_(props);     // APP wallet top-ups → sales row (money received today)
    syncJobs_(props);
    syncPayments_(props);   // v2.2: write POS results onto placed rows
    syncUnpaid_(props);     // v2.3: mark unpaid (workshop credit) rows red
    // finishing passes only if we didn't blow the budget placing rows
    if(!outOfTime_()){
      dedupeAllSheets_();     // v2.4: remove duplicate rows within each day block
      dedupeCrossDay_();      // v2.5: remove stale copies of the SAME job across days
      refreshRecentRowsHourly_(); // v2.9c: models+balances refresh at most once/hour
                                  // (was every minute — that drained the daily
                                  //  UrlFetch quota and stalled ALL syncing).
      compactPastDaysOncePerDay_(); // v2.7: after midnight, delete PAST days' empty slots (once/day)
      { const now=new Date();
        recomputeAllDayTotals_(getMonthSheet_(now));
        const prevName=Utilities.formatDate(new Date(now.getFullYear(),now.getMonth()-1,15),TZ,"MMM yyyy").toUpperCase();
        const ps=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(prevName);
        if(ps) recomputeAllDayTotals_(ps);
      }
    } else {
      Logger.log("⏳ Ran low on time — skipped dedupe/totals this run; next run will continue.");
    }
  }catch(e){ Logger.log("Sync failed: "+e); }
  finally{ lock.releaseLock(); }
}

/* v2.4: scan the current + relevant month tabs and remove duplicate customer
   rows within each day block (same plate, else same name). Keeps the FIRST
   occurrence (which has the earliest placement / any POS write-back), clears
   the later duplicate rows, then recomputes that day's total.
   Only clears content — never deletes sheet rows (keeps the slot grid intact). */
function dedupeAllSheets_(){
  const now=new Date();
  const prev=new Date(now.getFullYear(), now.getMonth()-1, 15); // mid of previous month
  const tabs=[getMonthSheet_(now)];
  // also dedupe the previous month tab if it exists (covers month-boundary
  // re-scans and late-keyed sales). getMonthSheet_ creates tabs, so only add
  // the previous tab when it already exists to avoid spawning empty months.
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const prevName=Utilities.formatDate(prev,TZ,"MMM yyyy").toUpperCase();
  const prevSheet=ss.getSheetByName(prevName);
  if(prevSheet) tabs.push(prevSheet);
  tabs.forEach(s=>{ try{ dedupeSheet_(s); }catch(e){ Logger.log("dedupe tab skipped: "+e); } });
}

/* v2.5: CROSS-DAY dedupe. When a job is backdated (e.g. keyed today but the
   sale moved to yesterday via sale_date), the original "today" row can be
   left behind as a stale copy. dedupeSheet_ only looks WITHIN a day block, so
   it misses this. Here we scan a tab for the SAME plate appearing in 2+ day
   blocks and keep the row that actually has payment/voucher info (TUNAI /
   INVOICE / PAYMENT / a TOTAL PAID like VOUCHER), clearing the empty stale
   copies. If none has payment info, we leave them alone (could be genuine
   repeat visits on different days).
   Only clears content — never deletes rows. */
function dedupeCrossDay_(){
  const now=new Date();
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const tabs=[getMonthSheet_(now)];
  const prevName=Utilities.formatDate(new Date(now.getFullYear(),now.getMonth()-1,15),TZ,"MMM yyyy").toUpperCase();
  const prevSheet=ss.getSheetByName(prevName);
  if(prevSheet) tabs.push(prevSheet);
  tabs.forEach(sheet=>{ try{ dedupeCrossDaySheet_(sheet); }catch(e){ Logger.log("cross-day dedupe skipped: "+e); } });
}
function dedupeCrossDaySheet_(sheet){
  const data=sheet.getDataRange().getValues();
  const clearCols=[COL.NAME,COL.CONTACT,COL.CUST_WHERE,COL.ATTENDEE,COL.CAR,COL.PLATE,
    COL.FROM_PRICE,COL.DEPOSIT,COL.DEP_DATE,COL.TOTAL_PAID,COL.PAY_BY,COL.REMARK,
    COL.TUNAI,COL.INVOICE,COL.PAYMENT];
  // gather every data row keyed by plate, noting its day + whether it's "paid"
  let curKey="", curDateStr="";
  const byPlate={};  // plate -> [{row, dateStr, paid}]
  const hasVal=(row,c)=>String(data[row][c-1]||"").trim()!=="";
  for(let i=HEADER_ROW; i<data.length; i++){
    const dval=data[i][COL.DATE-1];
    if(dval!==undefined && dval!==null && String(dval).trim()!==""){
      const k=dateKey_(dval);
      if(k){ curKey=k; curDateStr=String(dval).trim(); }
    }
    if(!curKey) continue;
    const plate=String(data[i][COL.PLATE-1]||"").trim().toUpperCase();
    if(!plate) continue;
    // Never treat APP BOOKING / APP TOPUP rows as stale cross-day duplicates —
    // they are legitimate distinct appointments, not copies of a walk-in job.
    const whereVal=String(data[i][COL.CUST_WHERE-1]||"").trim().toUpperCase();
    if(whereVal.indexOf("APP BOOKING")>=0 || whereVal.indexOf("APP TOPUP")>=0) continue;
    // "paid/resolved" = has any payment write-back OR a TOTAL PAID value
    // (VOUCHER counts) — i.e. this is the row the sale actually landed on.
    const paid = hasVal(i,COL.TUNAI) || hasVal(i,COL.INVOICE) || hasVal(i,COL.PAYMENT)
              || String(data[i][COL.TOTAL_PAID-1]||"").trim()!=="";
    (byPlate[plate]=byPlate[plate]||[]).push({row:i, dateKey:curKey, dateStr:curDateStr, paid:paid});
  }
  const daysTouched={};
  Object.keys(byPlate).forEach(plate=>{
    const rows=byPlate[plate];
    // only act when the SAME plate spans 2+ different day blocks
    const days=new Set(rows.map(r=>r.dateKey));
    if(days.size<2) return;
    // is there exactly one "paid" row? if so, keep it, clear the rest.
    const paidRows=rows.filter(r=>r.paid);
    if(paidRows.length!==1) return;   // ambiguous (0 or many paid) -> leave alone
    const keep=paidRows[0].row;
    rows.forEach(r=>{
      if(r.row===keep) return;
      if(r.paid) return;              // never clear another paid row
      clearCols.forEach(c=>sheet.getRange(r.row+1,c).clearContent());
      try{ sheet.getRange(r.row+1,COL.PAY_BY).setBackground(null); }catch(e){}
      daysTouched[r.dateStr]=true;
    });
  });
  Object.keys(daysTouched).forEach(ds=>recomputeDailyTotal_(sheet, ds));
}
function dedupeSheet_(sheet){
  const data=sheet.getDataRange().getValues();
  let curKey="", curDateStr="";
  const clearCols=[COL.NAME,COL.CONTACT,COL.CUST_WHERE,COL.ATTENDEE,COL.CAR,COL.PLATE,
    COL.FROM_PRICE,COL.DEPOSIT,COL.DEP_DATE,COL.TOTAL_PAID,COL.PAY_BY,COL.REMARK,
    COL.TUNAI,COL.INVOICE,COL.PAYMENT];
  // group rows by day + identity, then keep the "best" one per group
  const groups={};  // key: dayKey|id  ->  [rowIndexes]
  const rowMeta={}; // rowIndex -> {dateStr}
  for(let i=HEADER_ROW; i<data.length; i++){
    const dval=data[i][COL.DATE-1];
    if(dval!==undefined && dval!==null && String(dval).trim()!==""){
      const k=dateKey_(dval);
      if(k){ curKey=k; curDateStr=String(dval).trim(); }
    }
    if(!curKey) continue;
    const plate=String(data[i][COL.PLATE-1]||"").trim().toUpperCase();
    const name =String(data[i][COL.NAME-1]||"").trim().toUpperCase();
    if(!plate && !name) continue;
    // Skip APP BOOKING / APP TOPUP rows — keep them as distinct appointments.
    const whereVal=String(data[i][COL.CUST_WHERE-1]||"").trim().toUpperCase();
    if(whereVal.indexOf("APP BOOKING")>=0 || whereVal.indexOf("APP TOPUP")>=0) continue;
    const id = plate ? ("P:"+plate) : ("N:"+name);
    const gk = curKey+"|"+id;
    (groups[gk]=groups[gk]||[]).push(i);
    rowMeta[i]={dateStr:curDateStr};
  }
  const daysTouched={};
  Object.keys(groups).forEach(gk=>{
    const idxs=groups[gk];
    if(idxs.length<2) return; // no dup
    // score each row: more filled data cols = higher; prefer the keeper
    let keep=idxs[0], keepScore=-1;
    idxs.forEach(i=>{
      let score=0;
      [COL.ATTENDEE,COL.TUNAI,COL.INVOICE,COL.PAYMENT,COL.TOTAL_PAID,COL.CONTACT,COL.CAR,COL.FROM_PRICE].forEach(c=>{
        if(String(data[i][c-1]||"").trim()!=="") score++;
      });
      if(score>keepScore){ keepScore=score; keep=i; }
    });
    // clear all except the keeper
    idxs.forEach(i=>{
      if(i===keep) return;
      clearCols.forEach(c=>sheet.getRange(i+1,c).clearContent());
      try{ sheet.getRange(i+1,COL.PAY_BY).setBackground(null); }catch(e){}
      if(rowMeta[i]) daysTouched[rowMeta[i].dateStr]=true;
    });
  });
  Object.keys(daysTouched).forEach(ds=>recomputeDailyTotal_(sheet, ds));
}
function dedupeThisTab_(){
  const sheet=SpreadsheetApp.getActiveSheet();
  dedupeSheet_(sheet);
  SpreadsheetApp.getActive().toast("Duplicates cleared on "+sheet.getName());
}
function rebuildTotalsThisTab_(){
  const sheet=SpreadsheetApp.getActiveSheet();
  recomputeAllDayTotals_(sheet);
  SpreadsheetApp.getActive().toast("Daily totals rebuilt on "+sheet.getName());
}

/* Re-apply absent styling to the active tab, independent of the sync marker.
   Fetches all no_show=true jobs, then for each matching row on the sheet
   (by plate) sets the whole row red + PAY BY = "ABSENT". Use this when a job
   was marked absent AFTER the mirror already placed its row (so a normal Sync
   won't reprocess it). Also clears totals for touched days. */
function refreshAbsentThisTab_(){
  const sheet=SpreadsheetApp.getActiveSheet();
  // 1) get absent plates from gl_jobs (last 30 days is plenty)
  const since=new Date(Date.now()-30*24*60*60*1000).toISOString();
  const url=SUPABASE_URL+"/rest/v1/gl_jobs?select=plate,no_show,no_show_at&no_show=eq.true&no_show_at=gt."+encodeURIComponent(since);
  const rows=fetchRows_(url);
  if(rows===null){ SpreadsheetApp.getActive().toast("Couldn't fetch (quota?). Try again later."); return; }
  const absentPlates={};
  (rows||[]).forEach(r=>{ const p=String(r.plate||"").trim().toUpperCase().replace(/\s+/g,""); if(p) absentPlates[p]=true; });
  if(!Object.keys(absentPlates).length){ SpreadsheetApp.getActive().toast("No absent jobs found."); return; }

  // 2) scan the sheet; redden rows whose plate is absent
  const lastRow=sheet.getLastRow();
  if(lastRow<=HEADER_ROW){ return; }
  const data=sheet.getRange(1,1,lastRow,LAST_COL).getValues();
  let n=0; const days={};
  let curDateStr="";
  for(let i=HEADER_ROW;i<lastRow;i++){
    const dv=data[i][COL.DATE-1];
    if(dv!==undefined&&dv!==null&&String(dv).trim()!==""){ curDateStr=String(dv).trim(); }
    const plate=String(data[i][COL.PLATE-1]||"").trim().toUpperCase().replace(/\s+/g,"");
    if(!plate) continue;
    if(absentPlates[plate]){
      // first, clear any red that a previous run wrongly put on DAY/DATE/TIME
      // and the sales/total columns (they must stay black)
      sheet.getRange(i+1,COL.DAY,1,COL.TIME-COL.DAY+1).setFontColor(null);
      sheet.getRange(i+1,COL.TOTAL_SALES,1,COL.DAILY_SALES-COL.TOTAL_SALES+1).setFontColor(null);
      // now apply red to the customer's data only
      sheet.getRange(i+1,COL.NAME,1,COL.PAY_BY-COL.NAME+1).setFontColor("#C0392B");
      sheet.getRange(i+1,COL.REMARK).setFontColor("#C0392B");
      sheet.getRange(i+1,COL.NAME).setFontWeight("bold");
      sheet.getRange(i+1,COL.PAY_BY).setValue("ABSENT");
      if(curDateStr) days[curDateStr]=true;
      n++;
    }
  }
  Object.keys(days).forEach(ds=>{ try{ recomputeDailyTotal_(sheet, ds); }catch(e){} });
  SpreadsheetApp.getActive().toast("Absent styling applied to "+n+" row(s).");
}

/* Fix a misplaced MONTH TOTAL row. If any day block (a row with a DATE) sits
   BELOW the MONTH TOTAL row, the total is out of order — it must be the very
   last content. This moves the MONTH TOTAL label to the bottom, below the last
   day block, and clears the old misplaced one. Keeps all day blocks (incl. the
   31/07 slot grid) intact. Then recomputes totals. Safe to run anytime. */
function fixMonthTotalPosition_(){
  const sheet=SpreadsheetApp.getActiveSheet();
  const lastRow=sheet.getLastRow();
  if(lastRow<=HEADER_ROW){ SpreadsheetApp.getActive().toast("Nothing to fix."); return; }
  const data=sheet.getRange(1,1,lastRow,LAST_COL).getValues();

  // find the MONTH TOTAL row (1-indexed)
  let mtRow=-1;
  for(let i=HEADER_ROW;i<data.length;i++){
    if(String(data[i][COL.NAME-1]||"").trim().toUpperCase()==="MONTH TOTAL"){ mtRow=i+1; break; }
  }
  if(mtRow<0){ SpreadsheetApp.getActive().toast("No MONTH TOTAL row found."); return; }

  // is there any DATE row BELOW the MONTH TOTAL row? (that's the bug)
  let hasBlockBelow=false, lastContentRow=mtRow;
  for(let i=mtRow;i<data.length;i++){         // i is 0-indexed; mtRow is 1-indexed => rows after it
    const dval=data[i][COL.DATE-1];
    const nm=String(data[i][COL.NAME-1]||"").trim();
    const pl=String(data[i][COL.PLATE-1]||"").trim();
    const tm=String(data[i][COL.TIME-1]||"").trim();
    if((dval!==undefined&&dval!==null&&String(dval).trim()!=="") || nm || pl || tm){
      hasBlockBelow=true; lastContentRow=i+1;
    }
  }
  if(!hasBlockBelow){ SpreadsheetApp.getActive().toast("MONTH TOTAL is already at the bottom. ✓"); return; }

  // capture the MONTH TOTAL row's total values before clearing it
  const depVal   = data[mtRow-1][COL.DEPOSIT-1];
  const paidVal  = data[mtRow-1][COL.TOTAL_PAID-1];
  const dailyVal = data[mtRow-1][COL.DAILY_SALES-1];
  // ALSO capture any DAY+DATE that were sitting on the misplaced MONTH TOTAL row
  // (e.g. "FRIDAY 31/07/2026") — the day block below it needs these back.
  const orphanDay  = data[mtRow-1][COL.DAY-1];
  const orphanDate = data[mtRow-1][COL.DATE-1];

  // clear the misplaced MONTH TOTAL row entirely (it will be rewritten at bottom)
  sheet.getRange(mtRow,1,1,LAST_COL).clearContent();
  try{ sheet.getRange(mtRow,1,1,LAST_COL).setBackground(null); }catch(e){}

  // RESTORE the DAY+DATE onto the first row of the block below (the orphaned
  // day grid that lost its header when the MONTH TOTAL row was cleared).
  if((orphanDate!==undefined&&orphanDate!==null&&String(orphanDate).trim()!=="")){
    const firstBelow=mtRow+1; // 1-indexed row right after the old MONTH TOTAL
    if(firstBelow<=sheet.getLastRow()){
      const curDay =String(sheet.getRange(firstBelow,COL.DAY).getValue()||"").trim();
      const curDate=String(sheet.getRange(firstBelow,COL.DATE).getValue()||"").trim();
      if(!curDate){
        if(orphanDay) sheet.getRange(firstBelow,COL.DAY).setValue(orphanDay).setFontWeight("bold");
        sheet.getRange(firstBelow,COL.DATE).setValue(orphanDate);
      }
    }
  }

  // place MONTH TOTAL just below the last content row (with a red separator above it)
  const sepRow=lastContentRow+1;
  sheet.getRange(sepRow,1,1,LAST_COL).setBackground(RED_BG);
  try{ sheet.setRowHeight(sepRow,6); }catch(e){}
  const newMt=sepRow+1;
  sheet.getRange(newMt,COL.NAME).setValue("MONTH TOTAL").setFontWeight("bold");
  if(depVal!=="")   sheet.getRange(newMt,COL.DEPOSIT).setValue(depVal).setFontWeight("bold");
  if(paidVal!=="")  sheet.getRange(newMt,COL.TOTAL_PAID).setValue(paidVal).setFontWeight("bold");
  if(dailyVal!=="") sheet.getRange(newMt,COL.DAILY_SALES).setValue(dailyVal).setFontWeight("bold");
  try{ sheet.getRange(newMt,1,1,LAST_COL).setFontFamily("Arial").setFontSize(7); }catch(e){}

  // recompute so the moved total is authoritative
  recomputeAllDayTotals_(sheet);
  SpreadsheetApp.getActive().toast("MONTH TOTAL moved to the bottom on "+sheet.getName());
}

/* Refresh the package-balance text in REMARK for every customer row on the
   active tab, re-reading the live balance from gl_packages (walkinPkg_).
   Only rewrites the "— N left" suffix; keeps the rest of the remark.
   Fast: one gl_packages lookup per plate, updates REMARK only. Never moves
   rows or touches totals. Run from the GrandLab menu when old rows show a
   blank balance. Respects the time budget so it won't hit the 6-min limit. */
function refreshBalancesThisTab_(){
  const sheet=SpreadsheetApp.getActiveSheet();
  SYNC_START_MS=Date.now();
  const lastRow=sheet.getLastRow();
  if(lastRow<=HEADER_ROW){ SpreadsheetApp.getActive().toast("Nothing to refresh."); return; }
  const data=sheet.getRange(1,1,lastRow,LAST_COL).getValues();
  const seenR={};   // plate -> remark (cache)
  const seenM={};   // plate -> {model, phone} latest from gl_walkin (cache)
  let updated=0, modelUpd=0, checked=0;
  for(let i=HEADER_ROW; i<lastRow; i++){
    if(outOfTime_()){ Logger.log("refresh: stopped at row "+(i+1)+" (time budget)"); break; }
    const plate=String(data[i][COL.PLATE-1]||"").trim();
    const name =String(data[i][COL.NAME-1]||"").trim();
    if(!plate || !name) continue;          // only real customer rows
    // Skip APP BOOKING / APP TOPUP rows — keep their app-supplied remark.
    const whereVal=String(data[i][COL.CUST_WHERE-1]||"").trim().toUpperCase();
    if(whereVal.indexOf("APP BOOKING")>=0 || whereVal.indexOf("APP TOPUP")>=0) continue;
    const key=plate.toUpperCase();
    checked++;

    // latest model + phone for this plate (from gl_walkin — the scanner writes here)
    let m;
    if(key in seenM){ m=seenM[key]; }
    else { m=latestCarByPlate_(plate); seenM[key]=m; }

    // 1) refresh CAR/model column to the newest value from the scanner
    if(m && m.model){
      const cur=String(data[i][COL.CAR-1]||"").trim();
      if(cur!==m.model){ sheet.getRange(i+1,COL.CAR).setValue(m.model); modelUpd++; }
    }
    // 1b) backfill CONTACT if missing
    if(m && m.phone){
      const curPh=String(data[i][COL.CONTACT-1]||"").trim();
      if(!curPh){ sheet.getRange(i+1,COL.CONTACT).setValue(m.phone.replace(/^\+/,"")); }
    }

    // 2) refresh REMARK balance (customer-scoped via phone)
    let remark;
    if(key in seenR){ remark=seenR[key]; }
    else { remark=pkgRemark_(plate, m && m.phone); seenR[key]=remark; }
    if(remark && remark!==String(data[i][COL.REMARK-1]||"").trim()){
      sheet.getRange(i+1,COL.REMARK).setValue(remark); updated++;
    }
  }
  SpreadsheetApp.getActive().toast("Refreshed: "+updated+" balances, "+modelUpd+" models / "+checked+" rows on "+sheet.getName());
}

/* Re-read Cust-from-where / Referral / Returning from gl_jobs for existing rows.
   Run this after tagging sources in POS (edits don't bump created_at, so the
   normal sync won't re-pull them). Matches by plate to the newest job.
   Only touches cols CUST_WHERE(6), REFERRAL(21), RETURNING(22). Add-only. */
function refreshSourceThisTab_(){
  const sheet=SpreadsheetApp.getActiveSheet();
  SYNC_START_MS=Date.now();
  const lastRow=sheet.getLastRow();
  if(lastRow<=HEADER_ROW){ SpreadsheetApp.getActive().toast("Nothing to refresh."); return; }
  const data=sheet.getRange(1,1,lastRow,LAST_COL).getValues();
  const seen={}; // plate -> job fields
  let updated=0, checked=0;
  for(let i=HEADER_ROW; i<lastRow; i++){
    if(outOfTime_()){ Logger.log("refreshSource: stopped at row "+(i+1)); break; }
    const plate=String(data[i][COL.PLATE-1]||"").trim();
    const name =String(data[i][COL.NAME-1]||"").trim();
    if(!plate || !name) continue;
    const key=plate.toUpperCase();
    checked++;
    let j;
    if(key in seen){ j=seen[key]; }
    else {
      // newest job for this plate that carries a marketing tag
      const url=SUPABASE_URL+"/rest/v1/gl_jobs?select=cust_type,lead_source,is_returning,referral_by_name,referral_by_ref,created_at&plate=ilike."+encodeURIComponent(plate)+"&order=created_at.desc&limit=5";
      const rows=fetchRows_(url)||[];
      // skip trade jobs; prefer the newest row that has any tag
      j=rows.find(r=>{
        const ct=String(r.cust_type||"").toLowerCase();
        if(ct==="workshop"||ct==="showroom"||ct==="boss") return false;
        return r.lead_source || r.is_returning!=null || r.referral_by_name;
      }) || null;
      seen[key]=j;
    }
    if(!j) continue;
    // CUST FROM WHERE — keep APP BOOKING rows' label, else set from lead_source
    const whereVal=String(data[i][COL.CUST_WHERE-1]||"").trim().toUpperCase();
    if(whereVal.indexOf("APP BOOKING")<0 && whereVal.indexOf("APP TOPUP")<0){
      const lbl=leadSourceLabel_(j.lead_source);
      if(lbl && lbl!==String(data[i][COL.CUST_WHERE-1]||"").trim()){ sheet.getRange(i+1,COL.CUST_WHERE).setValue(lbl); updated++; }
    }
    // REFERRAL BY
    const refCell=referralCell_(j.referral_by_name, j.referral_by_ref);
    if(refCell && refCell!==String(data[i][COL.REFERRAL-1]||"").trim()){ sheet.getRange(i+1,COL.REFERRAL).setValue(refCell); updated++; }
    // RETURNING
    const retCell = j.is_returning===true ? "✓ Returning" : (j.is_returning===false ? "" : String(data[i][COL.RETURNING-1]||""));
    if(retCell!==String(data[i][COL.RETURNING-1]||"").trim()){ sheet.getRange(i+1,COL.RETURNING).setValue(retCell); updated++; }
  }
  SpreadsheetApp.getActive().toast("Source refresh: "+updated+" cells / "+checked+" rows on "+sheet.getName());
}

/* Latest car model + phone for a plate, from gl_walkin (the scanner's table).
   Prefers a row that has a model; returns {model, phone} or null. */
function latestCarByPlate_(plate){
  const pl=String(plate||"").trim();
  if(!pl) return null;
  try{
    const url=SUPABASE_URL+"/rest/v1/gl_walkin?select=model,phone&plate=ilike."+encodeURIComponent(pl)+"&limit=20";
    const rows=fetchRows_(url)||[];
    if(!rows.length) return null;
    // prefer a row that actually has a model, then one with a phone
    rows.sort((a,b)=>
      (b.model?1:0)-(a.model?1:0) || (String(b.phone||"").length)-(String(a.phone||"").length)
    );
    return { model:String(rows[0].model||"").trim(), phone:String(rows[0].phone||"").trim() };
  }catch(e){ Logger.log("latestCarByPlate_ err: "+e); return null; }
}

/* v2.9c: run refreshRecentRows_ at most ONCE PER HOUR, not every minute.
   The per-plate gl_walkin + package-RPC fetches in refreshRecentRows_ were
   firing every single sync (every minute) for the last 7 days of rows, which
   exhausted Google's daily UrlFetch quota — after which NOTHING synced
   (jobs, payments, unpaid all fail). Models/balances change rarely, so an
   hourly refresh is plenty. The essential syncs (bookings/jobs/payments/
   unpaid) still run every minute and are no longer starved of quota. */
function refreshRecentRowsHourly_(){
  const props=PropertiesService.getScriptProperties();
  const nowMs=Date.now();
  const lastMs=parseInt(props.getProperty("gl_recent_refresh_ms")||"0")||0;
  if(nowMs-lastMs < 60*60*1000) return;   // <1h since last refresh -> skip
  refreshRecentRows_(7);
  props.setProperty("gl_recent_refresh_ms", String(nowMs));
}

/* v2.6: light auto-refresh — keep the CAR/model + REMARK balance fresh for
   rows in the LAST `days` days only. Runs each sync (cheap: caches per-plate
   lookups, respects the time budget). Older rows refresh only via the manual
   "Refresh balances + models" menu item. */
function refreshRecentRows_(days){
  const sheet=getMonthSheet_(new Date());
  const lastRow=sheet.getLastRow();
  if(lastRow<=HEADER_ROW) return;
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-(days||7));
  const data=sheet.getRange(1,1,lastRow,LAST_COL).getValues();
  const seenR={}, seenM={};
  let curKey="", curInWindow=false;
  for(let i=HEADER_ROW; i<lastRow; i++){
    if(outOfTime_()) return;
    // track the current day block and whether it's within the window
    const dval=data[i][COL.DATE-1];
    if(dval!==undefined && dval!==null && String(dval).trim()!==""){
      const k=dateKey_(dval);
      if(k){
        curKey=k;
        const d=parseDateKey_(k);
        curInWindow = d ? (d>=cutoff) : false;
      }
    }
    if(!curInWindow) continue;
    const plate=String(data[i][COL.PLATE-1]||"").trim();
    const name =String(data[i][COL.NAME-1]||"").trim();
    if(!plate || !name) continue;
    // Don't touch APP BOOKING / APP TOPUP rows — their remark carries the
    // service name + wallet-spend note from the app; overwriting it with a
    // coating-balance lookup would wipe that.
    const whereVal=String(data[i][COL.CUST_WHERE-1]||"").trim().toUpperCase();
    if(whereVal.indexOf("APP BOOKING")>=0 || whereVal.indexOf("APP TOPUP")>=0) continue;
    const key=plate.toUpperCase();
    let m;
    if(key in seenM){ m=seenM[key]; } else { m=latestCarByPlate_(plate); seenM[key]=m; }
    if(m && m.model){
      const cur=String(data[i][COL.CAR-1]||"").trim();
      if(cur!==m.model) sheet.getRange(i+1,COL.CAR).setValue(m.model);
    }
    // backfill CONTACT if the row has no phone but gl_walkin does
    if(m && m.phone){
      const curPh=String(data[i][COL.CONTACT-1]||"").trim();
      if(!curPh){ sheet.getRange(i+1,COL.CONTACT).setValue(m.phone.replace(/^\+/,"")); }
    }
    let remark;
    if(key in seenR){ remark=seenR[key]; } else { remark=pkgRemark_(plate, m && m.phone); seenR[key]=remark; }
    if(remark && remark!==String(data[i][COL.REMARK-1]||"").trim()){
      sheet.getRange(i+1,COL.REMARK).setValue(remark);
    }
  }
}

/* Manual: clear red background on PAY_BY cells that aren't actually UNPAID,
   on the currently active tab (fixes old bleed without deleting anything). */
function clearStrayRedThisTab_(){
  const sheet=SpreadsheetApp.getActiveSheet();
  const lastRow=sheet.getLastRow();
  if(lastRow<=HEADER_ROW){ SpreadsheetApp.getActive().toast("Nothing to clear."); return; }
  const pb=sheet.getRange(1,COL.PAY_BY,lastRow,1).getValues();
  let cleared=0;
  for(let i=HEADER_ROW;i<lastRow;i++){
    const v=String(pb[i][0]||"").trim().toUpperCase();
    if(v!=="UNPAID"){
      let h=21; try{ h=sheet.getRowHeight(i+1); }catch(e){}
      if(h>10){ try{ sheet.getRange(i+1,COL.PAY_BY).setBackground(null); cleared++; }catch(e){} }
    }
  }
  SpreadsheetApp.getActive().toast("Cleared stray red on "+cleared+" cells.");
}

/* Parse a dateKey_ (yyyy-MM-dd) back into a Date at local noon. */
function parseDateKey_(k){
  const m=String(k||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return null;
  return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]), 12, 0, 0);
}

/* v2.9: RESTORE the fixed time-slot grid for TODAY + FUTURE day blocks that
   had their empty slots deleted. Inserts only the MISSING slot times into
   each such day (right after the day header), preserving every filled row.
   Past days are left as-is (they're meant to be compact). Run from the menu. */
function restoreSlotsThisTab_(){
  loadBookingCfg_(); // make sure SLOTS reflects the current booking config
  const sheet=SpreadsheetApp.getActiveSheet();
  const todayKey=dateKey_(Utilities.formatDate(new Date(),TZ,"d/M/yy"));
  const tParsed=parseDateKey_(todayKey);
  if(!tParsed){ SpreadsheetApp.getActive().toast("Could not resolve today's date."); return; }

  // desired slot times, in order, with how many rows each needs
  const wantSlots=[];
  SLOTS.forEach(s=>{ for(let k=0;k<s.n;k++) wantSlots.push(normTime_(s.time)); });

  let inserted=0, daysFixed=0;
  // iterate blocks from the BOTTOM up so inserting rows doesn't shift the
  // indexes of blocks we haven't processed yet.
  const blocks=scanDayBlocks_(sheet); // [{headerRow(1-idx), dateKey, endRow}]
  for(let bi=blocks.length-1; bi>=0; bi--){
    const b=blocks[bi];
    const d=parseDateKey_(b.dateKey);
    if(!d || d<tParsed) continue;          // skip past days
    // which slot times already exist in this block?
    const present={};
    for(let r=b.headerRow; r<=b.endRow; r++){
      const t=normTime_(sheet.getRange(r,COL.TIME).getValue());
      if(t) present[t]=(present[t]||0)+1;
    }
    // figure out which wanted slot-rows are missing (respect per-slot count)
    const need={};
    wantSlots.forEach(t=>{ need[t]=(need[t]||0)+1; });
    const toAdd=[];
    Object.keys(need).forEach(t=>{
      const have=present[t]||0;
      for(let i=have;i<need[t];i++) toAdd.push(t);
    });
    if(!toAdd.length) continue;
    // keep them in the SLOTS order
    toAdd.sort((a,b2)=>wantSlots.indexOf(a)-wantSlots.indexOf(b2));

    // insert the missing slot rows right after the header row
    const insertAt=b.headerRow+1;
    sheet.insertRowsAfter(b.headerRow, toAdd.length);
    for(let i=0;i<toAdd.length;i++){
      const r=insertAt+i;
      sheet.getRange(r,COL.TIME).setValue(prettyTime_(toAdd[i]));
    }
    try{ sheet.getRange(insertAt,1,toAdd.length,LAST_COL).setFontFamily("Arial").setFontSize(7); }catch(e){}
    inserted+=toAdd.length; daysFixed++;
  }
  recomputeAllDayTotals_(sheet);
  SpreadsheetApp.getActive().toast("Restored "+inserted+" slot rows across "+daysFixed+" day(s) on "+sheet.getName());
}

/* helper: list day blocks on a sheet as {headerRow(1-indexed), dateKey, endRow}.
   A block starts on a row with a DATE value and ends just before the next
   DATE row or the red separator. */
function scanDayBlocks_(sheet){
  const lastRow=sheet.getLastRow();
  const data=sheet.getRange(1,1,lastRow,LAST_COL).getValues();
  const bg=sheet.getRange(1,1,lastRow,1).getBackgrounds();
  const isSep=r0=>String(bg[r0][0]||"").toUpperCase()===RED_BG.toUpperCase();
  const blocks=[];
  let cur=null;
  for(let i=HEADER_ROW;i<lastRow;i++){
    const dval=data[i][COL.DATE-1];
    const isHeader=(dval!==undefined&&dval!==null&&String(dval).trim()!=="");
    if(isHeader){
      if(cur){ cur.endRow=i; blocks.push(cur); } // close previous (endRow = row before this, 1-indexed = i)
      const k=dateKey_(dval);
      cur={ headerRow:i+1, dateKey:k, endRow:i+1 };
    }
    if(isSep(i) && cur){ cur.endRow=i; blocks.push(cur); cur=null; } // separator closes block (endRow before sep)
  }
  if(cur){ cur.endRow=lastRow; blocks.push(cur); }
  return blocks;
}

/* normTime_ gives a compact key like "9:00AM"; prettyTime_ turns it back into
   the display form "9:00 AM" used in the TIME column. */
function prettyTime_(key){
  const m=String(key||"").match(/^(\d{1,2}):(\d{2})(AM|PM)$/i);
  if(!m) return key;
  return m[1]+":"+m[2]+" "+m[3].toUpperCase();
}

/* v2.7: compact PAST day blocks — delete empty slot rows (no NAME + no PLATE)
   so finished days show only real jobs, and clear any stray red background on
   non-UNPAID cells so the UNPAID colour never bleeds into blank rows.
   - Only touches days STRICTLY BEFORE today (today keeps its empty slots).
   - Keeps the day's header row (the one carrying the DATE) even if empty, so
     the date label survives.
   - Never deletes the thin red separator rows (row height ~6) between days.
   - Deletes bottom-up so row indices stay valid.
   Runs on the current + previous month tabs. */
function compactPastDays_(){
  const now=new Date();
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const tabs=[getMonthSheet_(now)];
  const prevName=Utilities.formatDate(new Date(now.getFullYear(),now.getMonth()-1,15),TZ,"MMM yyyy").toUpperCase();
  const prevSheet=ss.getSheetByName(prevName);
  if(prevSheet) tabs.push(prevSheet);
  tabs.forEach(sheet=>{ try{ compactPastDaysSheet_(sheet); }catch(e){ Logger.log("compact skipped: "+e); } });
}

/* v2.8: collapse empty slot rows on EVERY day (current + previous month tabs),
   run on every sync. compactPastDaysSheet_ now collapses all blocks, so this
   is the same routine — named separately for clarity in syncNow. */
function compactAllDays_(){ compactPastDays_(); }

/* Run compactPastDays_ at most ONCE per calendar day, so the auto-sync doesn't
   delete/rewrite rows every minute. The first sync after midnight cleans up the
   day that just ended; later syncs that day skip it. */
function compactPastDaysOncePerDay_(){
  const props=PropertiesService.getScriptProperties();
  const today=Utilities.formatDate(new Date(),TZ,"yyyy-MM-dd");
  if(props.getProperty("gl_compact_last_day")===today) return; // already ran today
  compactPastDays_();
  props.setProperty("gl_compact_last_day", today);
}

function compactPastDaysSheet_(sheet){
  const todayKey=dateKey_(Utilities.formatDate(new Date(),TZ,"d/M/yy"));
  const tParsed=parseDateKey_(todayKey);
  let lastRow=sheet.getLastRow();
  if(lastRow<=HEADER_ROW) return;
  let data=sheet.getRange(1,1,lastRow,LAST_COL).getValues();

  // ---- pass 1: group rows into day blocks, mark which are PAST ----
  // a "block" = header row (has DATE) + following rows until the next DATE.
  const blocks=[];           // {headerIdx, dayVal, dateVal, dateKey, isPast, rows:[idx...]}
  let cur=null;
  for(let i=HEADER_ROW; i<data.length; i++){
    const dval=data[i][COL.DATE-1];
    const isHeader = (dval!==undefined && dval!==null && String(dval).trim()!=="");
    if(isHeader){
      const k=dateKey_(dval);
      const d=parseDateKey_(k);
      cur={ headerIdx:i, dayVal:data[i][COL.DAY-1], dateVal:dval, dateKey:k,
            isPast:(d&&tParsed)?(d<tParsed):false, rows:[] };
      blocks.push(cur);
    }
    if(cur) cur.rows.push(i);
  }

  // ---- pass 2: for each PAST block, decide which rows to delete ----
  // keep any row with a NAME or PLATE (real job). Delete empty slot rows.
  // If deleting would remove the row that holds DAY+DATE, re-stamp DAY+DATE
  // onto the first surviving job row; if the whole day is empty, keep ONE row
  // carrying just DAY+DATE (so the date label survives).
  const toDelete=[];
  blocks.forEach(b=>{
    if(!b.isPast) return;   // only collapse PAST days; keep today+future slot grid
    const realRows=b.rows.filter(i=>{
      const name =String(data[i][COL.NAME-1]||"").trim();
      const plate=String(data[i][COL.PLATE-1]||"").trim();
      return name||plate;
    });
    // separators (thin height ~6) are never in b.rows as real; but guard anyway
    const isSep=i=>{ let h=21; try{h=sheet.getRowHeight(i+1);}catch(e){} return h<=10; };

    if(realRows.length>0){
      // ensure DAY+DATE live on the first surviving real row
      const keepHeader=realRows[0];
      if(keepHeader!==b.headerIdx){
        // will delete the old header row -> move DAY+DATE to keepHeader
        if(!String(data[keepHeader][COL.DAY-1]||"").trim())
          sheet.getRange(keepHeader+1,COL.DAY).setValue(b.dayVal);
        if(!String(data[keepHeader][COL.DATE-1]||"").trim())
          sheet.getRange(keepHeader+1,COL.DATE).setValue(b.dateVal);
      }
      // delete every empty (non-real) row in the block, except separators
      b.rows.forEach(i=>{
        if(realRows.indexOf(i)>=0) return;      // keep real jobs
        if(isSep(i)) return;                    // keep separator line
        toDelete.push(i);
      });
    } else {
      // whole day empty -> keep ONE row with DAY+DATE, delete the rest
      const keep=b.headerIdx;
      sheet.getRange(keep+1,COL.DAY).setValue(b.dayVal);
      sheet.getRange(keep+1,COL.DATE).setValue(b.dateVal);
      b.rows.forEach(i=>{
        if(i===keep) return;
        if(isSep(i)) return;
        toDelete.push(i);
      });
    }
  });

  // ---- delete bottom-up so indices stay valid ----
  toDelete.sort((a,b)=>a-b);
  for(let d=toDelete.length-1; d>=0; d--){
    try{ sheet.deleteRow(toDelete[d]+1); }catch(e){ Logger.log("delRow err: "+e); }
  }

  // ---- clear stray red on PAY_BY cells that are NOT "UNPAID" ----
  const lr2=sheet.getLastRow();
  if(lr2>HEADER_ROW){
    const pb=sheet.getRange(1,COL.PAY_BY,lr2,1).getValues();
    for(let i=HEADER_ROW;i<lr2;i++){
      const v=String(pb[i][0]||"").trim().toUpperCase();
      if(v!=="UNPAID"){
        try{
          let h=21; try{ h=sheet.getRowHeight(i+1); }catch(e){}
          if(h>10) sheet.getRange(i+1,COL.PAY_BY).setBackground(null);
        }catch(e){}
      }
    }
  }
}

function syncBookings_(props){
  const last=props.getProperty(PROP_LAST_B) || "1970-01-01T00:00:00Z";
  const url=SUPABASE_URL+"/rest/v1/gl_bookings?select=*&created_at=gt."+encodeURIComponent(last)+"&order=created_at.asc";
  const rows=fetchRows_(url);
  if(rows===null) return;
  if(!rows.length){ Logger.log("No new bookings."); return; }
  let newest=last, count=0;
  for(let bi=0; bi<rows.length; bi++){
    if(outOfTime_()){ Logger.log("⏳ bookings: stopped at "+count+"/"+rows.length+" (time budget)"); break; }
    const b=rows[bi];
    try{
      const when = b.scheduled_at ? new Date(b.scheduled_at) : new Date();
      if(beforeStart_(when)){ if(b.created_at>newest){ newest=b.created_at; props.setProperty(PROP_LAST_B,newest); } continue; }
      const sheet=getMonthSheet_(when);
      ensureMonthBuilt_(sheet, when);
      placeBooking_(sheet, b, when);
      count++;
    }catch(e){ Logger.log("booking err: "+e); }
    if(b.created_at>newest){ newest=b.created_at; props.setProperty(PROP_LAST_B,newest); } // save after each so next run continues
  }
  props.setProperty(PROP_LAST_B,newest);
  Logger.log("✅ Bookings synced: "+count);
}

/* APP wallet TOP-UPS → sales row.
   A top-up is real money received today, so it counts in daily sales.
   Reads paid gl_orders where status='topup', places one row per top-up on
   its paid_at date, with TOTAL PAID = topup_amount and PAY BY = the method. */
function syncTopups_(props){
  const last=props.getProperty(PROP_LAST_TU) || "1970-01-01T00:00:00Z";
  const url=SUPABASE_URL+"/rest/v1/gl_orders?select=order_ref,amount,topup_amount,topup_bonus,payment_status,payment_method,status,paid_at,owner_id&status=eq.topup&payment_status=eq.paid&paid_at=gt."+encodeURIComponent(last)+"&order=paid_at.asc";
  const rows=fetchRows_(url);
  if(rows===null) return;
  if(!rows.length){ Logger.log("No new top-ups."); return; }
  let newest=last, count=0;
  for(let ti=0; ti<rows.length; ti++){
    if(outOfTime_()){ Logger.log("⏳ topups: stopped at "+count+"/"+rows.length+" (budget)"); break; }
    const o=rows[ti];
    try{
      const when = o.paid_at ? new Date(o.paid_at) : new Date();
      if(beforeStart_(when)){ if(o.paid_at>newest){ newest=o.paid_at; props.setProperty(PROP_LAST_TU,newest); } continue; }
      const sheet=getMonthSheet_(when);
      ensureMonthBuilt_(sheet, when);
      placeTopup_(sheet, o, when);
      count++;
    }catch(e){ Logger.log("topup err: "+e); }
    if(o.paid_at>newest){ newest=o.paid_at; props.setProperty(PROP_LAST_TU,newest); }
  }
  props.setProperty(PROP_LAST_TU,newest);
  Logger.log("✅ Top-ups synced: "+count);
}

function placeTopup_(sheet, o, when){
  const tz=TZ;
  const dateStr=Utilities.formatDate(when,tz,"d/M/yy");
  // look up the customer's name/phone from gl_profiles (best effort)
  let nm="", ph="";
  try{
    if(o.owner_id){
      const purl=SUPABASE_URL+"/rest/v1/gl_profiles?select=name,phone&id=eq."+encodeURIComponent(o.owner_id)+"&limit=1";
      const pr=fetchRows_(purl);
      if(pr&&pr.length){ nm=pr[0].name||""; ph=pr[0].phone||""; }
    }
  }catch(e){}
  // TOTAL PAID = the actual money the customer paid (topup_amount only).
  // The bonus is a reward we give (added to their wallet), NOT revenue —
  // so it must NOT inflate daily sales. Bonus is noted in the remark only.
  const paidAmt = (o.topup_amount!=null? Number(o.topup_amount):0);
  const pm = String(o.payment_method||"").toLowerCase();
  const payBy = pm ? pm.toUpperCase() : "SENANGPAY";
  const data = {
    name: nm, contact: ph,
    where: "APP TOPUP",
    attendee:"",
    car:"", plate:"",
    service:"Wallet Top-Up",
    deposit:"", depDate:"",
    totalPaid: paidAmt || "", payBy: payBy,
    remark: "Wallet top-up (RM"+Number(o.topup_amount||0).toFixed(2)+(Number(o.topup_bonus||0)>0?" + RM"+Number(o.topup_bonus).toFixed(2)+" bonus":"")+") ·ref:"+(o.order_ref||"")
  };
  // DEDUPE: if a row for this order_ref already exists anywhere in this tab,
  // update it in place instead of adding a new one (so re-syncs don't duplicate).
  const existing=findRowByRef_(sheet, o.order_ref);
  const targetRow = existing>0 ? existing : findWalkinRow_(sheet, dateStr, "");
  writeRow_(sheet, targetRow, data, false);
  recomputeDailyTotal_(sheet, dateStr);
}

/* Find a row anywhere in the tab whose REMARK carries "·ref:<orderRef>".
   Used to keep APP TOPUP / APP rows unique across re-syncs. */
function findRowByRef_(sheet, ref){
  if(!ref) return -1;
  const data=sheet.getDataRange().getValues();
  const needle="·ref:"+String(ref);
  for(let i=HEADER_ROW; i<data.length; i++){
    const rem=String(data[i][COL.REMARK-1]||"");
    if(rem.indexOf(needle)>=0) return i+1;
  }
  return -1;
}

/* v2.1: now includes 'walkin' alongside workshop/showroom. */
function syncJobs_(props){
  const last=props.getProperty(PROP_LAST_J) || "0";
  const url=SUPABASE_URL+"/rest/v1/gl_jobs?select=*&cust_type=in.(workshop,showroom,walkin,boss)&created_at=gt."+encodeURIComponent(last)+"&order=created_at.asc";
  const jobs=fetchRows_(url);
  if(jobs===null) return;
  if(!jobs.length){ Logger.log("No new jobs."); return; }
  let newest=last, count=0;
  for(let ji=0; ji<jobs.length; ji++){
    if(outOfTime_()){ Logger.log("⏳ jobs: stopped at "+count+"/"+jobs.length+" (time budget)"); break; }
    const j=jobs[ji];
    try{
      const when = j.created_at ? new Date(Number(j.created_at)) : new Date();
      if(beforeStart_(when)){ const ca=String(j.created_at||"0"); if(ca>newest){ newest=ca; props.setProperty(PROP_LAST_J,newest); } continue; }
      const sheet=getMonthSheet_(when);
      ensureMonthBuilt_(sheet, when);
      placeJob_(sheet, j, when);
      count++;
    }catch(e){ Logger.log("job err: "+e); }
    const ca=String(j.created_at||"0");
    if(ca>newest){ newest=ca; props.setProperty(PROP_LAST_J,newest); } // save after each
  }
  props.setProperty(PROP_LAST_J,newest);
  Logger.log("✅ Jobs synced (workshop/showroom/walk-in): "+count);
}

/* v2.2: POS payment write-back.
   Pulls new/updated gl_payments and stamps the matching sheet row with
   attendee (G), TUNAI/GLIV (R), SQL invoice (S), SQL payment (T), and
   sets TOTAL PAID (M) to "VOUCHER" when the sale was package-paid (net 0).
   Uses updated_at so later SQL-keying edits re-sync the same row.       */
function syncPayments_(props){
  const last=props.getProperty(PROP_LAST_P) || "1970-01-01T00:00:00Z";
  // order by a timestamp that also moves when reception keys SQL nos.
  // gl_payments has paid_at (created) and sql_keyed_at (later). We scan by
  // greatest of the two via a view-less trick: fetch by paid_at OR sql_keyed_at.
  const url=SUPABASE_URL+"/rest/v1/gl_payments?select=id,invoice_no,customer_name,plate,net_paid,method,package_used,attendee,sql_invoice_no,sql_payment_no,sql_keyed_at,paid_at,sale_date,voided,voided_at&order=paid_at.asc&or=(paid_at.gt."+encodeURIComponent(last)+",sql_keyed_at.gt."+encodeURIComponent(last)+",voided_at.gt."+encodeURIComponent(last)+")";
  const rows=fetchRows_(url);
  if(rows===null) return;
  if(!rows.length){ Logger.log("No new/updated payments."); return; }
  let newest=last, count=0;
  for(let pi=0; pi<rows.length; pi++){
    if(outOfTime_()){ Logger.log("⏳ payments: stopped at "+count+"/"+rows.length+" (time budget)"); break; }
    const p=rows[pi];
    try{
      // the sale counts for its sale_date (backdated if keyed late); fall back to paid_at
      const when = p.sale_date ? new Date(p.sale_date+"T12:00:00") : (p.paid_at ? new Date(p.paid_at) : new Date());
      const stamp = maxIso_(maxIso_(p.paid_at, p.sql_keyed_at), p.voided_at);
      if(beforeStart_(when)){ if(stamp>newest){ newest=stamp; props.setProperty(PROP_LAST_P,newest); } continue; }
      const sheet=getMonthSheet_(when);
      ensureMonthBuilt_(sheet, when);
      stampPayment_(sheet, p, when);
      count++;
    }catch(e){ Logger.log("payment err: "+e); }
    const stamp = maxIso_(maxIso_(p.paid_at, p.sql_keyed_at), p.voided_at);
    if(stamp>newest){ newest=stamp; props.setProperty(PROP_LAST_P,newest); } // save after each
  }
  props.setProperty(PROP_LAST_P,newest);
  Logger.log("✅ Payments written back: "+count);
}

/* v2.3: mark UNPAID (workshop credit) rows red on the sheet.
   Reads gl_unpaid; for each unsettled record, finds the job's row by
   plate/date and sets PAY_BY = "UNPAID" (red) + puts the owed amount in
   TOTAL PAID so it's clearly outstanding. When settled, clears the red. */
function syncUnpaid_(props){
  const last=props.getProperty(PROP_LAST_U) || "1970-01-01T00:00:00Z";
  const url=SUPABASE_URL+"/rest/v1/gl_unpaid?select=id,invoice_no,customer_name,plate,amount_owed,gross,settled,created_at,settled_at&or=(created_at.gt."+encodeURIComponent(last)+",settled_at.gt."+encodeURIComponent(last)+")&order=created_at.asc";
  const rows=fetchRows_(url);
  if(rows===null) return;
  if(!rows.length){ Logger.log("No new/updated unpaid."); return; }
  let newest=last, count=0;
  rows.forEach(u=>{
    try{
      const when=u.created_at?new Date(u.created_at):new Date();
      const stamp=maxIso_(u.created_at,u.settled_at);
      if(beforeStart_(when)){ if(stamp>newest) newest=stamp; return; }
      const sheet=getMonthSheet_(when);
      ensureMonthBuilt_(sheet, when);
      const dateStr=Utilities.formatDate(when,TZ,"d/M/yy");
      let row=findRowForPayment_(sheet, dateStr, u);
      // SELF-HEAL: if the job row was never placed (common for workshop batches
      // keyed straight to unpaid), create a row from the unpaid record itself.
      if(row<0 && u.settled!==true){
        row=createUnpaidRow_(sheet, dateStr, u);
      }
      if(row<0){ Logger.log("unpaid: no row for "+(u.plate||u.customer_name)); }
      else if(u.settled===true){
        // settled now — clear the red UNPAID flag
        sheet.getRange(row,COL.PAY_BY).clearContent().setBackground(null);
      }else{
        // outstanding — mark red UNPAID and show owed amount
        sheet.getRange(row,COL.PAY_BY).setValue("UNPAID").setBackground(RED_BG);
        const owed=parseFloat(u.amount_owed);
        if(!isNaN(owed)) sheet.getRange(row,COL.TOTAL_PAID).setValue(owed);
        recomputeDailyTotal_(sheet, dateStr);
      }
      count++;
    }catch(e){ Logger.log("unpaid err: "+e); }
    const stamp=maxIso_(u.created_at,u.settled_at);
    if(stamp>newest) newest=stamp;
  });
  props.setProperty(PROP_LAST_U,newest);
  Logger.log("✅ Unpaid marked: "+count);
}

function maxIso_(a,b){ a=a||""; b=b||""; return (a>b)?a:b; }

function fetchRows_(url){
  var res;
  try{
    res=glFetch_(url,{method:"get",headers:{apikey:svcKey_(),Authorization:"Bearer "+svcKey_()},muteHttpExceptions:true});
  }catch(err){
    // UrlFetchApp throws (not returns) when the daily quota is exhausted.
    Logger.log("⚠️ fetch threw (likely daily UrlFetch quota exhausted): "+err+
      "\n   Quota resets ~midnight Pacific (~3-4pm MYT). Avoid ♻️ Re-scan items today.");
    return null;
  }
  if(res.getResponseCode()!==200){ Logger.log("Fetch err "+res.getResponseCode()+": "+res.getContentText()); return null; }
  return JSON.parse(res.getContentText());
}

// ========================= MONTH TEMPLATE =========================
function ensureMonthBuilt_(sheet, anyDate){
  const flag = sheet.getRange(1, LAST_COL+2);
  if(flag.getValue()==="BUILT") return;
  // SAFETY: even if the BUILT flag cell was cleared (manual edit, column delete,
  // etc.), don't rebuild a month that already has content — that would append a
  // duplicate day grid BELOW the existing MONTH TOTAL and scramble the layout.
  // If a MONTH TOTAL row already exists, treat the month as built and re-set flag.
  try{
    const lastRow=sheet.getLastRow();
    if(lastRow>HEADER_ROW){
      const names=sheet.getRange(HEADER_ROW+1, COL.NAME, lastRow-HEADER_ROW, 1).getValues();
      for(let i=0;i<names.length;i++){
        if(String(names[i][0]||"").trim().toUpperCase()==="MONTH TOTAL"){
          flag.setValue("BUILT");   // restore the flag; do NOT rebuild
          return;
        }
      }
    }
  }catch(e){ Logger.log("built-check guard skipped: "+e); }

  const tz=TZ;
  const y=parseInt(Utilities.formatDate(anyDate,tz,"yyyy"));
  const m=parseInt(Utilities.formatDate(anyDate,tz,"M"))-1;
  const daysInMonth=new Date(y, m+1, 0).getDate();

  try{ sheet.getRange(HEADER_ROW+1, COL.TIME, daysInMonth*12, 1).setNumberFormat("@"); }catch(e){}
  try{ sheet.getRange(HEADER_ROW+1, COL.DATE, daysInMonth*12, 1).setNumberFormat("@"); }catch(e){}

  let row=HEADER_ROW+1;
  for(let d=1; d<=daysInMonth; d++){
    const date=new Date(Date.UTC(y, m, d, 4, 0, 0));
    const dayName=Utilities.formatDate(date,tz,"EEEE").toUpperCase();
    const dateStr=Utilities.formatDate(date,tz,"dd/MM/yyyy");
    const isoDate=Utilities.formatDate(date,tz,"yyyy-MM-dd");
    const weekday=parseInt(Utilities.formatDate(date,tz,"u"))%7;
    const isClosedWeekday = CLOSED_WEEKDAYS.indexOf(weekday)>=0;
    const holidayName = CLOSED_DAYS[isoDate];
    const isClosed = isClosedWeekday || !!holidayName;

    if(isClosed){
      sheet.getRange(row,COL.DAY).setValue(dayName).setFontWeight("bold");
      sheet.getRange(row,COL.DATE).setValue(dateStr);
      const label = holidayName ? ("CLOSED — "+holidayName) : "CLOSED";
      sheet.getRange(row,COL.NAME).setValue(label).setFontWeight("bold").setFontColor("#C0392B");
      row++;
    }else{
      let first=true;
      SLOTS.forEach(s=>{
        for(let k=0;k<s.n;k++){
          if(first){
            sheet.getRange(row,COL.DAY).setValue(dayName).setFontWeight("bold");
            sheet.getRange(row,COL.DATE).setValue(dateStr);
            first=false;
          }
          sheet.getRange(row,COL.TIME).setValue(s.time);
          row++;
        }
      });
      row+=3; // spare rows for walk-ins
    }

    sheet.getRange(row, 1, 1, LAST_COL).setBackground(RED_BG);
    sheet.setRowHeight(row, 6);
    row++;
  }

  sheet.getRange(row, COL.NAME).setValue("MONTH TOTAL").setFontWeight("bold");

  const fmt='"RM"#,##0.00';
  MONEY_COLS.forEach(c=>{
    try{ sheet.getRange(HEADER_ROW+1, c, row-HEADER_ROW, 1).setNumberFormat(fmt); }catch(e){}
  });

  // font: Arial 7 across the whole month block (header row through month total)
  try{
    sheet.getRange(HEADER_ROW, 1, row-HEADER_ROW+1, LAST_COL)
      .setFontFamily("Arial").setFontSize(7);
  }catch(e){ Logger.log("font set skipped: "+e); }

  flag.setValue("BUILT");
  recomputeMonthTotals_(sheet);
}

// ========================= PLACEMENT =========================
function placeBooking_(sheet, b, when){
  const tz=TZ;
  const time = slotFromNotes_(b.notes) || Utilities.formatDate(when,tz,"h:mm a");
  const rawService = b.service_name || "";
  const balAfter = noteField_(b.notes,"CoatingBalance");
  const staffRemark = noteField_(b.notes,"Remark");            // staff-typed internal remark
  const svcList = allServicesFromNotes_(b.notes, rawService);  // all services (main + extras)
  const svcCell = svcList.join("\n");                          // stacked in the SERVICE column

  // --- APP payment accounting ---------------------------------------------
  // Look up the linked gl_orders row (Ref in notes) to know how it was paid.
  // Rules:
  //   • paid online / at outlet  -> TOTAL PAID = amount, PAY BY = method (counts in daily sales)
  //   • paid by G Wallet         -> PAY BY = "PAID (wallet)", TOTAL PAID empty (NOT counted;
  //                                  money was already taken at top-up time)
  //   • not paid yet             -> leave blank (pending)
  let appTotalPaid="", appPayBy="", walletSpent=0;
  try{
    const ref = noteField_(b.notes,"Ref");
    if(ref){
      const ord = appOrderByRef_(ref);
      if(ord && String(ord.payment_status||"").toLowerCase()==="paid"){
        const pm = String(ord.payment_method||"").toLowerCase();
        if(pm==="wallet"){
          appPayBy = "PAID (wallet)";       // no sales amount — already counted at top-up
          appTotalPaid = "";
          walletSpent = (ord.amount!=null ? Number(ord.amount) : 0);  // for the remark note
        } else {
          appTotalPaid = (ord.amount!=null ? ord.amount : "");
          // pm is now like "senangpay-tng"/"senangpay-fpx" — show it uppercase.
          appPayBy = pm ? pm.toUpperCase() : "PAID";
        }
      }
    }
  }catch(e){ Logger.log("app pay lookup err: "+e); }

  // Build remark; if wallet-paid, append "· RMx (wallet)" so the spend is
  // visible for records WITHOUT counting in daily sales (TOTAL PAID stays empty).
  let remarkText = buildRemark_(rawService, balAfter);
  if(walletSpent>0) remarkText = remarkText + " · RM" + walletSpent.toFixed(2) + " (wallet)";
  // staff-typed remark goes on TOP, then the service — balance line below.
  if(staffRemark) remarkText = staffRemark + "\n" + remarkText;

  const data = {
    name:   b.name || noteField_(b.notes,"Name"),
    contact:b.contact || noteField_(b.notes,"Phone"),
    where:  leadSourceLabel_(b.lead_source) ? ("APP BOOKING · "+leadSourceLabel_(b.lead_source)) : "APP BOOKING",
    attendee:"",
    car:    b.car_model || noteField_(b.notes,"Car"),
    plate:  b.plate || noteField_(b.notes,"Plate"),
    service:svcCell,
    deposit:(b.amount_paid!=null ? b.amount_paid : noteField_(b.notes,"Deposit")),
    depDate:noteField_(b.notes,"DepDate"),
    totalPaid:appTotalPaid, payBy:appPayBy,
    remark: remarkText,
    referral: referralCell_(b.referral_by_name, b.referral_by_ref),
    returning: b.is_returning===true ? "✓ Returning" : ""
  };
  const dateStr=Utilities.formatDate(when,tz,"d/M/yy");
  // DEDUPE: skip if this booking is already placed in this day block
  let targetRow=findExistingRowInDay_(sheet, dateStr, data.plate, data.name);
  if(targetRow<0) targetRow=findSlotRow_(sheet, dateStr, time);
  writeRow_(sheet, targetRow, data, false);
  recomputeDailyTotal_(sheet, dateStr);
}

/* v2.1: handles workshop/showroom (unchanged) AND walk-in (new).
   Walk-ins use the real customer name + contact, labelled WALK-IN,
   and are NOT marked UNPAID (paid at counter). */
function placeJob_(sheet, j, when){
  const tz=TZ;
  const time=Utilities.formatDate(when,tz,"h:mm a");
  const svcs=Array.isArray(j.services)?j.services:[];
  const svcText=svcs.map(s=>s.desc).filter(Boolean).join(", ");
  const price=svcs.reduce((a,s)=>a+(parseFloat(s.price)||0),0);

  // auto-fill balance in the remark. Prefer the job's own pkg_balance_after
  // (single number for the service just used); else show ALL live package
  // balances for this plate from gl_packages (e.g. coating + bathe essence).
  let remarkText;
  if(j.pkg_balance_after!=null && j.pkg_balance_after!=="" && !isNaN(parseInt(j.pkg_balance_after))){
    remarkText = svcText+" — "+parseInt(j.pkg_balance_after)+" left";
  } else {
    const pkgTxt = pkgRemark_(j.plate, j.hp);
    remarkText = pkgTxt || svcText;
  }

  const isTrade = (j.cust_type==="workshop" || j.cust_type==="showroom");
  const isBoss  = (j.cust_type==="boss");

  let data;
  if(isBoss){
    // boss / company car — RM0, no charge. Show the boss/company name.
    data={
      name: j.workshop_name||j.name||"",
      contact:"",
      where:"BOSS.CO"+((j.workshop_name||j.name)?(" · "+(j.workshop_name||j.name)):""),
      attendee:j.attendee||"",
      car:j.model||"", plate:j.plate||"", service:svcText,
      deposit:"", depDate:"", totalPaid:"", payBy:"", remark:remarkText
    };
  } else if(isTrade){
    data={
      name: j.workshop_name||"",
      contact:"",
      where:(j.cust_type==="workshop"?"WORKSHOP":"SHOWROOM")+(j.workshop_name?" · "+j.workshop_name:""),
      attendee:j.attendee||j.sent_by||"",
      car:j.model||"", plate:j.plate||"", service:svcText,
      deposit:"", depDate:"", totalPaid:price||"", payBy:"", remark:remarkText
    };
  } else {
    // walk-in
    let ph=(j.hp||"").toString().replace(/^\+/,"");
    // if the job carried no phone, look it up from gl_walkin by plate
    if(!ph && j.plate){
      try{
        const url=SUPABASE_URL+"/rest/v1/gl_walkin?select=phone&plate=ilike."+encodeURIComponent(j.plate)+"&limit=5";
        const wk=fetchRows_(url)||[];
        const hit=wk.find(r=>String(r.phone||"").replace(/\D/g,"").length>=7);
        if(hit) ph=String(hit.phone||"").replace(/^\+/,"");
      }catch(e){}
    }
    data={
      name: j.name||"",
      contact: ph,
      where: leadSourceLabel_(j.lead_source) || "WALK-IN",
      attendee:j.attendee||"",
      car:j.model||"", plate:j.plate||"", service:svcText,
      deposit:(j.dep_amt!=null?j.dep_amt:""), depDate:j.dep_date||"",
      totalPaid: price||"", payBy:"", remark:remarkText,
      referral: referralCell_(j.referral_by_name, j.referral_by_ref),
      returning: j.is_returning===true ? "✓ Returning" : ""
    };
  }

  const dateStr=Utilities.formatDate(when,tz,"d/M/yy");
  // the picked time slot decides placement:
  //  - a standard slot time (9:00 AM..5:00 PM) -> fill that booking slot
  //  - custom/"others" time or empty -> walk-in area below the slots
  const slot=String(j.slot_time||"").trim();
  const isStdSlot = slot && SLOTS.some(s=>normTime_(s.time)===normTime_(slot));
  // if a custom time was given, show it in the TIME column of the walk-in row
  if(slot && !isStdSlot) data.time=slot;

  // DEDUPE: if this customer is already placed in this day block, update that row
  let targetRow=findExistingRowInDay_(sheet, dateStr, data.plate, data.name);
  if(targetRow<0){
    targetRow = isStdSlot ? findSlotRow_(sheet, dateStr, slot)
                          : findWalkinRow_(sheet, dateStr, time);
  }
  writeRow_(sheet, targetRow, data, isTrade); // UNPAID red only for trade jobs
  // absent / no-show -> whole row red text + "ABSENT" in PAY BY
  if(targetRow>0){
    try{
      if(j.no_show===true){
        // red only the customer's data: NAME..PAY_BY and REMARK.
        // Skip DAY/DATE/TIME (1-3) and the sales/total columns (15,16).
        sheet.getRange(targetRow, COL.NAME, 1, COL.PAY_BY-COL.NAME+1).setFontColor("#C0392B");
        sheet.getRange(targetRow, COL.REMARK).setFontColor("#C0392B");
        sheet.getRange(targetRow, COL.NAME).setFontWeight("bold");
        // mark the payment column as ABSENT
        sheet.getRange(targetRow, COL.PAY_BY).setValue("ABSENT");
      } else {
        // reset when the flag is removed
        sheet.getRange(targetRow, COL.NAME, 1, COL.PAY_BY-COL.NAME+1).setFontColor(null);
        sheet.getRange(targetRow, COL.REMARK).setFontColor(null);
        sheet.getRange(targetRow, COL.NAME).setFontWeight("normal");
        const pb=String(sheet.getRange(targetRow, COL.PAY_BY).getValue()||"").trim().toUpperCase();
        if(pb==="ABSENT") sheet.getRange(targetRow, COL.PAY_BY).clearContent();
      }
    }catch(e){}
  }
  recomputeDailyTotal_(sheet, dateStr);
}

/* find an already-placed row for this customer within one day block
   (match by plate first, then name). Returns row number or -1.
   Carries the day key down across blank-DATE rows so it finds copies
   sitting anywhere in the block (slot rows AND walk-in rows).          */
function findExistingRowInDay_(sheet, dateStr, plate, name){
  const data=sheet.getDataRange().getValues();
  const pl=String(plate||"").trim().toUpperCase();
  const nm=String(name||"").trim().toUpperCase();
  if(!pl && !nm) return -1;
  const targetKey=dateKey_(dateStr);
  let curKey="";
  for(let i=HEADER_ROW; i<data.length; i++){
    const dval=data[i][COL.DATE-1];
    if(dval!==undefined && dval!==null && String(dval).trim()!==""){
      const k=dateKey_(dval);
      if(k) curKey=k;
    }
    if(curKey!==targetKey) continue;      // only rows within the target day
    const rp=String(data[i][COL.PLATE-1]||"").trim().toUpperCase();
    const rn=String(data[i][COL.NAME-1]||"").trim().toUpperCase();
    if(pl && rp===pl) return i+1;
    if(!pl && nm && rn===nm) return i+1;
  }
  return -1;
}

/* v2.4: stamp POS results onto the customer's row. If the sale was
   backdated (sale_date differs from where the row currently sits), MOVE
   the row to the correct day block first, then stamp.                 */
function stampPayment_(sheet, p, when){
  const tz=TZ;
  const dateStr=Utilities.formatDate(when,tz,"d/M/yy");
  const targetKey=dateKey_(dateStr);

  // 1) is the row already correctly in the target day block?
  let row=findRowForPayment_(sheet, dateStr, p);

  // 2) not in the target block — look for it in ANY other day block and move it
  if(row<0 && p.voided!==true){
    const found=findRowAnyBlock_(sheet, p); // {row, dateKey} or null
    if(found && found.dateKey!==targetKey){
      const moved=moveRowToDay_(sheet, found.row, dateStr);
      if(moved>0) row=moved;
      recomputeDailyTotal_(sheet, found.oldDateStr);
    } else if(found){
      row=found.row;
    }
  }

  // 2b) if the row is correctly in the target block, clear any STRAY copies
  //     of this same customer sitting in OTHER day blocks (from an earlier
  //     placement before the sale was backdated).
  if(row>0 && p.voided!==true){
    clearStrayCopies_(sheet, p, targetKey, row);
  }

  if(row<0){ Logger.log("payment: no matching row for "+(p.plate||p.customer_name)+" on "+dateStr); return; }

  // VOIDED (deleted in POS): clear this row's payment write-back so it can be redone
  if(p.voided===true){
    sheet.getRange(row,COL.TUNAI).clearContent();      // R
    sheet.getRange(row,COL.INVOICE).clearContent();    // S
    sheet.getRange(row,COL.PAYMENT).clearContent();    // T
    const tp=String(sheet.getRange(row,COL.TOTAL_PAID).getValue()||"");
    if(tp.toUpperCase()==="VOUCHER") sheet.getRange(row,COL.TOTAL_PAID).clearContent();
    recomputeDailyTotal_(sheet, dateStr);
    return;
  }

  // G — attendee
  if(p.attendee) sheet.getRange(row,COL.ATTENDEE).setValue(p.attendee);
  // R — TUNAI / GLIV (the POS invoice number)
  if(p.invoice_no) sheet.getRange(row,COL.TUNAI).setValue(p.invoice_no);
  // S — SQL invoice number (blank until reception keys it)
  if(p.sql_invoice_no) sheet.getRange(row,COL.INVOICE).setValue(p.sql_invoice_no);
  // T — SQL customer payment / knock-off number
  if(p.sql_payment_no) sheet.getRange(row,COL.PAYMENT).setValue(p.sql_payment_no);
  // N — PAY BY: the payment method used at POS (cash/tng/mae/grabpay/etc.)
  if(p.method) sheet.getRange(row,COL.PAY_BY).setValue(prettyMethod_(p.method));
  // M — TOTAL PAID: "VOUCHER" when a package covered the sale (net 0);
  //     otherwise the actual net paid (reflects amount edits in POS).
  const net=parseFloat(p.net_paid)||0;
  if(p.package_used && net===0){
    sheet.getRange(row,COL.TOTAL_PAID).setValue("VOUCHER");
  } else if(net>0){
    // don't overwrite an UNPAID red flag with a paid amount
    const payByNow=String(sheet.getRange(row,COL.PAY_BY).getValue()||"").trim().toUpperCase();
    if(payByNow!=="UNPAID") sheet.getRange(row,COL.TOTAL_PAID).setValue(net);
  }

  recomputeDailyTotal_(sheet, dateStr);
}

/* find a customer's row in ANY day block (by plate, fallback name).
   Returns {row, dateKey, oldDateStr} or null. */
function findRowAnyBlock_(sheet, p){
  const data=sheet.getDataRange().getValues();
  const plate=String(p.plate||"").trim().toUpperCase();
  const name =String(p.customer_name||"").trim().toUpperCase();
  let curDateStr="", curKey="";
  let plateHit=null, nameHit=null;
  for(let i=HEADER_ROW; i<data.length; i++){
    const dval=data[i][COL.DATE-1];
    if(dval!==undefined && dval!==null && String(dval).trim()!==""){
      const k=dateKey_(dval);
      if(k){ curKey=k; curDateStr=String(dval).trim(); }
    }
    const rowPlate=String(data[i][COL.PLATE-1]||"").trim().toUpperCase();
    const rowName =String(data[i][COL.NAME-1]||"").trim().toUpperCase();
    if(plate && rowPlate===plate && !plateHit) plateHit={row:i+1, dateKey:curKey, oldDateStr:curDateStr};
    if(name && rowName===name && !nameHit) nameHit={row:i+1, dateKey:curKey, oldDateStr:curDateStr};
  }
  return plateHit || nameHit || null;
}

/* move a full row's data from its current position into the target day
   block's walk-in area, clear the old row, return the new row number. */
function moveRowToDay_(sheet, oldRow, targetDateStr){
  const vals=sheet.getRange(oldRow,1,1,LAST_COL).getValues()[0];
  // capture the meaningful fields (skip DAY/DATE/TIME/sales-total cols)
  const carry={
    name:vals[COL.NAME-1], contact:vals[COL.CONTACT-1], where:vals[COL.CUST_WHERE-1],
    attendee:vals[COL.ATTENDEE-1], car:vals[COL.CAR-1], plate:vals[COL.PLATE-1],
    service:vals[COL.FROM_PRICE-1], deposit:vals[COL.DEPOSIT-1], depDate:vals[COL.DEP_DATE-1],
    totalPaid:vals[COL.TOTAL_PAID-1], payBy:vals[COL.PAY_BY-1], remark:vals[COL.REMARK-1],
    tunai:vals[COL.TUNAI-1], invoice:vals[COL.INVOICE-1], payment:vals[COL.PAYMENT-1]
  };
  // clear the old row (data cols only; keep DAY/DATE/TIME grid intact)
  const clearCols=[COL.NAME,COL.CONTACT,COL.CUST_WHERE,COL.ATTENDEE,COL.CAR,COL.PLATE,
    COL.FROM_PRICE,COL.DEPOSIT,COL.DEP_DATE,COL.TOTAL_PAID,COL.PAY_BY,COL.REMARK,
    COL.TUNAI,COL.INVOICE,COL.PAYMENT];
  clearCols.forEach(c=>sheet.getRange(oldRow,c).clearContent());
  // reset any red UNPAID background on pay-by cell
  try{ sheet.getRange(oldRow,COL.PAY_BY).setBackground(null); }catch(e){}

  // place into target day walk-in area
  const newRow=findWalkinRow_(sheet, targetDateStr, "");
  sheet.getRange(newRow,COL.NAME).setValue((carry.name||"").toString().toUpperCase());
  sheet.getRange(newRow,COL.CONTACT).setValue(carry.contact||"");
  sheet.getRange(newRow,COL.CUST_WHERE).setValue(carry.where||"");
  sheet.getRange(newRow,COL.ATTENDEE).setValue(carry.attendee||"");
  sheet.getRange(newRow,COL.CAR).setValue(carry.car||"");
  sheet.getRange(newRow,COL.PLATE).setValue(carry.plate||"");
  sheet.getRange(newRow,COL.FROM_PRICE).setValue(carry.service||"");
  sheet.getRange(newRow,COL.DEPOSIT).setValue(carry.deposit||"");
  sheet.getRange(newRow,COL.DEP_DATE).setValue(carry.depDate||"");
  sheet.getRange(newRow,COL.TOTAL_PAID).setValue(carry.totalPaid||"");
  if(carry.payBy) sheet.getRange(newRow,COL.PAY_BY).setValue(carry.payBy);
  sheet.getRange(newRow,COL.REMARK).setValue(carry.remark||"");
  if(carry.tunai) sheet.getRange(newRow,COL.TUNAI).setValue(carry.tunai);
  if(carry.invoice) sheet.getRange(newRow,COL.INVOICE).setValue(carry.invoice);
  if(carry.payment) sheet.getRange(newRow,COL.PAYMENT).setValue(carry.payment);
  try{ sheet.getRange(newRow,1,1,LAST_COL).setFontFamily("Arial").setFontSize(7); }catch(e){}
  return newRow;
}

/* SELF-HEAL: build a sheet row for an unpaid record whose job row is missing
   (deleted, or never placed). Places it in the day's walk-in area, labelled
   WORKSHOP, marks it UNPAID red with the owed amount, and stamps the invoice
   (GLIV) into the TUNAI column. Returns the new row number, or -1 on failure. */
function createUnpaidRow_(sheet, dateStr, u){
  try{
    const row=findWalkinRow_(sheet, dateStr, "");
    if(row<0) return -1;
    const name=String(u.customer_name||"").trim() || "WORKSHOP";
    const data={
      name: name,
      contact:"",
      where:"WORKSHOP",
      attendee:"",
      car:"", plate:(u.plate||""),
      service:"", deposit:"", depDate:"",
      totalPaid:"", payBy:"", remark:""
    };
    writeRow_(sheet, row, data, true); // unpaid=true -> PAY_BY red "UNPAID"
    // owed amount into TOTAL PAID so it shows as outstanding
    const owed=parseFloat(u.amount_owed);
    if(!isNaN(owed)) sheet.getRange(row,COL.TOTAL_PAID).setValue(owed);
    // invoice (GLIV) into TUNAI column
    if(u.invoice_no) sheet.getRange(row,COL.TUNAI).setValue(u.invoice_no);
    Logger.log("unpaid self-heal: created row "+row+" for "+(u.plate||name)+" on "+dateStr);
    return row;
  }catch(e){ Logger.log("createUnpaidRow_ err: "+e); return -1; }
}

function writeRow_(sheet, row, d, unpaid){
  sheet.getRange(row,COL.TIME).setValue(d.time||sheet.getRange(row,COL.TIME).getValue());
  sheet.getRange(row,COL.NAME).setValue((d.name||"").toString().toUpperCase());
  sheet.getRange(row,COL.CONTACT).setValue(d.contact||"");
  sheet.getRange(row,COL.CUST_WHERE).setValue(d.where||"");
  sheet.getRange(row,COL.ATTENDEE).setValue(d.attendee||"");
  sheet.getRange(row,COL.CAR).setValue(d.car||"");
  sheet.getRange(row,COL.PLATE).setValue(d.plate||"");
  sheet.getRange(row,COL.FROM_PRICE).setValue(d.service||"").setWrap(true);
  sheet.getRange(row,COL.DEPOSIT).setValue(d.deposit||"");
  sheet.getRange(row,COL.DEP_DATE).setValue(d.depDate||"");
  sheet.getRange(row,COL.TOTAL_PAID).setValue(d.totalPaid||"");
  sheet.getRange(row,COL.REMARK).setValue(d.remark||"").setWrap(true);
  // referral introducer (name · phone) + returning-customer flag
  sheet.getRange(row,COL.REFERRAL).setValue(d.referral||"");
  sheet.getRange(row,COL.RETURNING).setValue(d.returning||"");
  if(unpaid) sheet.getRange(row,COL.PAY_BY).setBackground(RED_BG).setValue("UNPAID");
  else if(d.payBy) sheet.getRange(row,COL.PAY_BY).setValue(d.payBy);
  // keep the font consistent on this row (covers newly-inserted walk-in rows)
  try{ sheet.getRange(row,1,1,LAST_COL).setFontFamily("Arial").setFontSize(7); }catch(e){}
}

// ========================= ROW FINDERS =========================
function findSlotRow_(sheet, dateStr, time){
  const data=sheet.getDataRange().getValues();
  for(let i=HEADER_ROW; i<data.length; i++){
    let dval=data[i][COL.DATE-1];
    if(dateKey_(dval)===dateKey_(dateStr)){
      for(let r=i; r<data.length; r++){
        const tcellRaw=data[r][COL.TIME-1];
        const nameCell=String(data[r][COL.NAME-1]||"").trim();
        const sepBg = isSeparator_(sheet, r+1);
        if(sepBg) break;
        if(normTime_(tcellRaw)===normTime_(time) && !nameCell) return r+1;
      }
      return findWalkinRow_(sheet, dateStr, time);
    }
  }
  return findWalkinRow_(sheet, dateStr, time);
}

function findWalkinRow_(sheet, dateStr, time){
  const data=sheet.getDataRange().getValues();
  for(let i=HEADER_ROW; i<data.length; i++){
    let dval=data[i][COL.DATE-1];
    if(dateKey_(dval)===dateKey_(dateStr)){
      let lastBlockRow=i;
      for(let r=i; r<data.length; r++){
        if(isSeparator_(sheet, r+1)){ lastBlockRow=r-1; break; }
        lastBlockRow=r;
      }
      // walk-ins go BELOW the booking slots: only use rows with NO time value
      // (slot rows carry a TIME like "9:00 AM"; walk-in spare rows have empty TIME).
      for(let r=i; r<=lastBlockRow; r++){
        const timeCell=String(data[r][COL.TIME-1]||"").trim();
        const nameCell=String(data[r][COL.NAME-1]||"").trim();
        if(!timeCell && !nameCell) return r+1;   // empty walk-in row (no slot time)
      }
      // no free walk-in row -> insert one just above the separator
      sheet.insertRowAfter(lastBlockRow+1);
      return lastBlockRow+2;
    }
  }
  return sheet.getLastRow()+1;
}

/* v2.2: find the already-placed row for a payment within its day block.
   Priority: exact plate match; else exact name match. Returns -1 if none. */
function findRowForPayment_(sheet, dateStr, p){
  const data=sheet.getDataRange().getValues();
  const plate=String(p.plate||"").trim().toUpperCase();
  const name =String(p.customer_name||"").trim().toUpperCase();
  for(let i=HEADER_ROW; i<data.length; i++){
    let dval=data[i][COL.DATE-1];
    if(dateKey_(dval)!==dateKey_(dateStr)) continue;
    // scan this day's block until the red separator
    let plateHit=-1, nameHit=-1;
    for(let r=i; r<data.length; r++){
      if(isSeparator_(sheet, r+1)) break;
      const rowPlate=String(data[r][COL.PLATE-1]||"").trim().toUpperCase();
      const rowName =String(data[r][COL.NAME-1]||"").trim().toUpperCase();
      if(plate && rowPlate===plate && plateHit<0) plateHit=r+1;
      if(name && rowName===name && nameHit<0) nameHit=r+1;
    }
    if(plateHit>0) return plateHit;
    if(nameHit>0)  return nameHit;
    return -1; // right day, no match
  }
  return -1;
}

function isSeparator_(sheet, rowNum){
  if(rowNum<1 || rowNum>sheet.getLastRow()) return false;
  const bg=sheet.getRange(rowNum,1).getBackground().toUpperCase();
  return bg===RED_BG.toUpperCase();
}
function dateKey_(v){
  if(v instanceof Date) return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  var s=String(v||"").trim(); if(!s) return "";
  var m=s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if(m){ var d=parseInt(m[1]),mo=parseInt(m[2]),y=parseInt(m[3]); if(y<100)y+=2000;
    return y+"-"+("0"+mo).slice(-2)+"-"+("0"+d).slice(-2); }
  return s;
}
function normTime_(t){
  if(t instanceof Date){
    let h=t.getHours(), m=t.getMinutes();
    const ap=h>=12?"PM":"AM"; h=h%12||12;
    t=h+":"+String(m).padStart(2,"0")+" "+ap;
  }
  return String(t||"").replace(/\s+/g,"").toUpperCase();
}

// ========================= TOTALS =========================
function recomputeDailyTotal_(sheet, dateStr){
  const data=sheet.getDataRange().getValues();
  let start=-1, end=-1;
  for(let i=HEADER_ROW; i<data.length; i++){
    let dval=data[i][COL.DATE-1];
    if(dateKey_(dval)===dateKey_(dateStr)){ start=i; break; }
  }
  if(start<0) return;
  for(let r=start; r<data.length; r++){
    if(isSeparator_(sheet, r+1)){ end=r-1; break; }
    end=r;
  }
  let sum=0;
  for(let r=start; r<=end; r++){
    // skip rows marked UNPAID — they're owed, not collected sales
    const payBy=String(data[r][COL.PAY_BY-1]||"").trim().toUpperCase();
    if(payBy==="UNPAID"||payBy==="ABSENT") continue;
    sum += parseFloat(data[r][COL.TOTAL_PAID-1])||0;
  }
  try{
    const topRow=start+1, botRow=end+1;               // 1-indexed sheet rows
    const range=sheet.getRange(topRow, COL.DAILY_SALES, botRow-topRow+1, 1);
    // un-merge first (rows may have been inserted since last run), then re-merge cleanly
    try{ range.breakApart(); }catch(e){}
    // clear any stale values in the block, write the total to the top cell
    range.clearContent();
    sheet.getRange(topRow, COL.DAILY_SALES).setValue(sum);
    if(botRow>topRow){
      range.mergeVertically();
      range.setVerticalAlignment("middle").setHorizontalAlignment("center");
    }
  }catch(e){ Logger.log("daily total write/merge skipped: "+e); }
  recomputeMonthTotals_(sheet);
}

/* v2.2b: authoritative rebuild of EVERY day block's daily total in a tab.
   Reads live sheet values, bounds each block strictly by the red separator,
   sums TOTAL PAID (skipping UNPAID rows), and writes+merges the DAILY SALES
   cell for that block. Self-correcting: fixes any cross-day bleed left by
   backdated row moves or mid-run row inserts. Never moves/clears data rows. */
function recomputeAllDayTotals_(sheet){
  const lastRow=sheet.getLastRow();
  if(lastRow<=HEADER_ROW) return;
  const data=sheet.getRange(1,1,lastRow,LAST_COL).getValues();
  const bgCol=sheet.getRange(1,1,lastRow,1).getBackgrounds();
  const isSep=r=>{ // r is 0-indexed into data
    if(r<0||r>=lastRow) return false;
    return String(bgCol[r][0]||"").toUpperCase()===RED_BG.toUpperCase();
  };
  // FIRST: wipe every DAILY SALES cell in the data range (break any old merges
  // + clear stale values) so a leftover total on a now-empty day can't survive.
  // We skip the MONTH TOTAL row (handled by recomputeMonthTotals_).
  try{
    let monthTotalRow=-1;
    for(let r=lastRow-1;r>=HEADER_ROW;r--){ if(String(data[r][COL.NAME-1]||"").trim()==="MONTH TOTAL"){ monthTotalRow=r; break; } }
    const wipeEnd = (monthTotalRow>HEADER_ROW? monthTotalRow : lastRow);
    const wipe=sheet.getRange(HEADER_ROW+1, COL.DAILY_SALES, wipeEnd-HEADER_ROW, 1);
    try{ wipe.breakApart(); }catch(e){}
    wipe.clearContent();
  }catch(e){ Logger.log("daily wipe skipped: "+e); }
  let i=HEADER_ROW; // 0-indexed; skip header
  // also clear any stray TOTAL PAID / DAILY value sitting on an EMPTY row
  // (no name + no plate) — these are leftovers that inflate/confuse totals.
  try{
    for(let r=HEADER_ROW; r<lastRow; r++){
      const rn=String(data[r][COL.NAME-1]||"").trim();
      const rp=String(data[r][COL.PLATE-1]||"").trim();
      if(rn==="MONTH TOTAL") continue;
      if(!rn && !rp){
        const tp=String(data[r][COL.TOTAL_PAID-1]||"").trim();
        if(tp!=="" && tp.toUpperCase()!=="VOUCHER"){
          try{ sheet.getRange(r+1,COL.TOTAL_PAID).clearContent(); }catch(e){}
        }
      }
    }
  }catch(e){ Logger.log("stray clear skipped: "+e); }
  while(i<lastRow){
    const dval=data[i][COL.DATE-1];
    if(dval===undefined||dval===null||String(dval).trim()===""){ i++; continue; }
    const startIdx=i;
    let endIdx=startIdx;
    for(let r=startIdx; r<lastRow; r++){
      if(isSep(r)){ endIdx=r-1; break; }
      if(r>startIdx){
        const dv2=data[r][COL.DATE-1];
        if(dv2!==undefined&&dv2!==null&&String(dv2).trim()!==""){ endIdx=r-1; break; }
      }
      endIdx=r;
    }
    let sum=0;
    for(let r=startIdx; r<=endIdx; r++){
      const payBy=String(data[r][COL.PAY_BY-1]||"").trim().toUpperCase();
      if(payBy==="UNPAID"||payBy==="ABSENT") continue;
      // only count rows that are actual jobs (have a name or plate) — this
      // ignores stray values left in TOTAL PAID on empty slot rows.
      const rn=String(data[r][COL.NAME-1]||"").trim();
      const rp=String(data[r][COL.PLATE-1]||"").trim();
      if(!rn && !rp) continue;
      sum += parseFloat(data[r][COL.TOTAL_PAID-1])||0;
    }
    try{
      const topRow=startIdx+1, botRow=endIdx+1;
      const range=sheet.getRange(topRow, COL.DAILY_SALES, botRow-topRow+1, 1);
      try{ range.breakApart(); }catch(e){}
      range.clearContent();
      sheet.getRange(topRow, COL.DAILY_SALES).setValue(sum);
      if(botRow>topRow){
        range.mergeVertically();
        range.setVerticalAlignment("middle").setHorizontalAlignment("center");
      }
    }catch(e){ Logger.log("recomputeAll block skipped: "+e); }
    i=endIdx+1;
    while(i<lastRow && isSep(i)) i++;
  }
  recomputeMonthTotals_(sheet);
}

/* DIAGNOSTIC: dump the DAILY SALES column + DATE + separator flags around a
   given row range on the active tab, so we can see why a stale total survives.
   Edit FROM/TO to the row numbers you see in the sheet (1-based), run, read log. */
function DEBUG_daily_sales(){
  const sheet=SpreadsheetApp.getActiveSheet();
  const FROM=300, TO=325;          // <-- adjust to the rows around 31/7
  const lastRow=Math.min(TO, sheet.getLastRow());
  const bg=sheet.getRange(1,1,lastRow,1).getBackgrounds();
  for(let r=FROM; r<=lastRow; r++){
    const date=sheet.getRange(r,COL.DATE).getValue();
    const name=sheet.getRange(r,COL.NAME).getValue();
    const paid=sheet.getRange(r,COL.TOTAL_PAID).getValue();
    const daily=sheet.getRange(r,COL.DAILY_SALES).getValue();
    const isSep=String(bg[r-1][0]||"").toUpperCase()===RED_BG.toUpperCase();
    const merged=sheet.getRange(r,COL.DAILY_SALES).isPartOfMerge();
    Logger.log("row "+r+" | date="+date+" | name="+name+" | paid="+paid+" | DAILY="+daily+" | sep="+isSep+" | merged="+merged);
  }
}

function recomputeMonthTotals_(sheet){
  const lastRow=sheet.getLastRow();
  if(lastRow<=HEADER_ROW) return;
  const data=sheet.getRange(1,1,lastRow,LAST_COL).getValues();
  let totalRow=-1;
  for(let i=data.length-1; i>=HEADER_ROW; i--){
    if(String(data[i][COL.NAME-1]||"").trim()==="MONTH TOTAL"){ totalRow=i+1; break; }
  }
  if(totalRow<0) return;
  // ROBUST: sum TOTAL PAID directly from every real data row (skip UNPAID and
  // the MONTH TOTAL row itself). This can't be inflated by shifted day-block
  // boundaries after compact/dedupe — it counts each row's paid amount once.
  let dep=0, paid=0;
  for(let i=HEADER_ROW; i<lastRow; i++){
    if((i+1)===totalRow) continue;
    const nm=String(data[i][COL.NAME-1]||"").trim();
    if(nm.toUpperCase()==="MONTH TOTAL") continue;
    const payBy=String(data[i][COL.PAY_BY-1]||"").trim().toUpperCase();
    if(payBy==="UNPAID"||payBy==="ABSENT") continue;                 // owed, not collected
    // only real job rows (name or plate) — ignore stray amounts on empty rows
    const rp=String(data[i][COL.PLATE-1]||"").trim();
    if(!nm && !rp) continue;
    paid += parseFloat(data[i][COL.TOTAL_PAID-1])||0;
    dep  += parseFloat(data[i][COL.DEPOSIT-1])||0;
  }
  sheet.getRange(totalRow, COL.DEPOSIT).setValue(dep).setFontWeight("bold");
  sheet.getRange(totalRow, COL.TOTAL_PAID).setValue(paid).setFontWeight("bold");
  sheet.getRange(totalRow, COL.DAILY_SALES).setValue(paid).setFontWeight("bold");
}

// ========================= HELPERS =========================
function noteField_(notes,key){ if(!notes) return ""; const m=notes.match(new RegExp(key+":\\s*([^|\\[]+)")); return m?m[1].trim():""; }

/* Map the stored lead_source code to a readable sheet label. */
function leadSourceLabel_(src){
  if(!src) return "";
  const map={ ads:"FB/IG Ads", referral:"REFERRAL", walkin:"WALK-IN",
    app_booking:"APP BOOKING", workshop:"WORKSHOP", showroom:"SHOWROOM" };
  return map[String(src).toLowerCase()] || "";
}
/* Referral cell = "NAME · phone" so same-name customers are distinguishable. */
function referralCell_(name, ref){
  const n=(name||"").toString().trim();
  if(!n) return "";
  const p=(ref||"").toString().replace(/\D/g,"");
  return p ? (n+" · "+p) : n;
}

/* Full list of services for a booking. The staff app packs extra services into
   notes as "Services: A;;B;;C" (';;' survives the ' | ' note split). Falls back
   to the single service_name when there's no multi-service note. Returns a
   cleaned, deduped array in order. */
function allServicesFromNotes_(notes, fallbackName){
  const raw = noteField_(notes,"Services");
  let list = [];
  if(raw){ list = raw.split(";;").map(function(s){ return cleanService_(s); }).filter(Boolean); }
  if(!list.length){ const one=cleanService_(fallbackName||""); if(one) list=[one]; }
  // dedupe, keep order
  const seen={}, out=[];
  list.forEach(function(s){ const k=s.toLowerCase(); if(!seen[k]){ seen[k]=1; out.push(s); } });
  return out;
}
// Fetch a single gl_orders row by its order_ref (for APP payment accounting).
function appOrderByRef_(ref){
  try{
    const url=SUPABASE_URL+"/rest/v1/gl_orders?select=amount,payment_status,payment_method,status&order_ref=eq."+encodeURIComponent(ref)+"&limit=1";
    const rows=fetchRows_(url);
    return (rows&&rows.length)?rows[0]:null;
  }catch(e){ return null; }
}
function slotFromNotes_(notes){ if(!notes) return ""; const m=notes.match(/\[slot:([^\]]+)\]/); return m?m[1].trim():""; }

/* Map POS method codes to readable PAY BY labels. Unknown codes upper-cased. */
function prettyMethod_(m){
  const map={cash:"CASH",credit_card:"CREDIT CARD",debit_card:"DEBIT CARD",
    cc_installment:"CC INSTALLMENT",tng:"TNG",mae:"MAE",grabpay:"GRABPAY",
    shopeepay:"SHOPEEPAY",atome:"ATOME",app_credit:"APP CREDIT",app_points:"APP POINTS",
    voucher:"VOUCHER / PACKAGE",split:"SPLIT","boss.co":"BOSS.CO"};
  const k=String(m||"").trim().toLowerCase();
  return map[k] || String(m||"").toUpperCase();
}

/* Look up a package balance for a plate.
   Source of truth is gl_packages (what the plate scanner / POS / job card
   write, keyed by vehicle_label = plate). Falls back to the legacy
   gl_walkin.pkg_* fields for old imported balances.
   Returns {name, left} for the package with the most remaining, else null.
   (Kept for backward-compat; new code uses walkinPkgAll_ + pkgRemark_.) */
function walkinPkg_(plate){
  const all=walkinPkgAll_(plate);
  return all.length ? all[0] : null;
}

// per-sync cache: same plate/phone won't hit the RPC twice in one run.
// Cleared at the start of each syncNow via resetPkgCache_().
var _PKG_CACHE = {};
function resetPkgCache_(){ _PKG_CACHE = {}; }

/* Return ALL active packages for a plate as [{name,left}, ...] (highest
   balance first). Reads gl_packages (source of truth); if none, falls back
   to the single legacy gl_walkin.pkg_* record. Empty array if none. */
function walkinPkgAll_(plate, phone){
  const pl=String(plate||"").trim();
  const ph=String(phone||"").trim();
  const ckey=pl.toUpperCase()+"|"+ph;
  if(_PKG_CACHE.hasOwnProperty(ckey)) return _PKG_CACHE[ckey]; // cached this run
  const res=_walkinPkgAllUncached_(pl, ph);
  _PKG_CACHE[ckey]=res;
  return res;
}
function _walkinPkgAllUncached_(pl, ph){
  const out=[];
  // 1) PRIMARY: customer-scoped RPC (coating per-car, Bathe Essence shared by
  //    phone). This matches what the scanner + job card show, so a shared
  //    balance appears even when the job's plate has no own package row.
  if(pl || ph){
    try{
      const url=SUPABASE_URL+"/rest/v1/rpc/gl_customer_packages";
      const res=glFetch_(url,{
        method:"post", contentType:"application/json",
        headers:{ apikey:svcKey_(), Authorization:"Bearer "+svcKey_() },
        payload:JSON.stringify({ p_phone:ph, p_plate:pl }),
        muteHttpExceptions:true
      });
      if(res.getResponseCode()<300){
        const rows=JSON.parse(res.getContentText()||"[]");
        (rows||[]).forEach(r=>{
          const left=parseInt(r.out_balance);
          if(!isNaN(left) && left>0){ out.push({ name:pkgCleanName_(r.out_service_name), left:left }); }
        });
      }
    }catch(e){ Logger.log("pkg(rpc) err: "+e); }
    if(out.length){ out.sort((a,b)=>b.left-a.left); return out; }
  }
  if(!pl) return out;
  // 2) fallback: gl_packages by plate (active) — if the RPC returned nothing
  try{
    const enc=encodeURIComponent(pl);
    const url=SUPABASE_URL+"/rest/v1/gl_packages?select=service_name,total_uses,used_uses&status=eq.active&vehicle_label=ilike."+enc;
    const rows=fetchRows_(url);
    if(rows && rows.length){
      rows.forEach(r=>{
        const total=parseInt(r.total_uses), used=parseInt(r.used_uses)||0;
        if(isNaN(total)) return;
        const left=total-used;
        if(left<=0) return;
        out.push({ name:pkgCleanName_(r.service_name), left:left });
      });
    }
  }catch(e){ Logger.log("pkg(gl_packages) err: "+e); }
  if(out.length){ out.sort((a,b)=>b.left-a.left); return out; }
  // 3) legacy fallback: gl_walkin.pkg_*
  try{
    const url=SUPABASE_URL+"/rest/v1/gl_walkin?select=pkg_name,pkg_total,pkg_used&plate=eq."+encodeURIComponent(pl)+"&limit=1";
    const rows=fetchRows_(url);
    if(rows && rows.length){
      const r=rows[0];
      const total=parseInt(r.pkg_total), used=parseInt(r.pkg_used)||0;
      if(!isNaN(total) && (total-used)>0){
        out.push({ name:pkgCleanName_(r.pkg_name), left:total-used });
      }
    }
  }catch(e){ Logger.log("pkg(gl_walkin) err: "+e); }
  return out;
}

/* Clean a package name for display: strip a trailing "Package", strip an
   embedded "(N left)" the plate scanner sometimes stores, and drop a
   leading "Balance " so we don't end up with "Balance Balance ...". */
function pkgCleanName_(s){
  let n=String(s||"").trim();
  n=n.replace(/\s*\(\s*\d+\s*left\s*\)/ig,"").trim(); // remove "(5 left)"
  n=n.replace(/\s*package\s*$/i,"").trim();            // trailing "Package"
  n=n.replace(/^balance\s+/i,"").trim();               // leading "Balance "
  return n;
}

/* Build the REMARK balance text for a plate. One package ->
   "Balance Bathe Essence Package — 8 left". Multiple ->
   "Balance: Mohs Maintenance 3 left · Bathe Essence 8 left".
   Returns "" when there is no balance. */
function pkgRemark_(plate, phone){
  const all=walkinPkgAll_(plate, phone);
  if(!all.length) return "";
  if(all.length===1){
    return "Balance "+all[0].name+" Package — "+all[0].left+" left";
  }
  return "Balance: "+all.map(p=>p.name+" "+p.left+" left").join(" · ");
}

function cleanService_(name){
  if(!name) return "";
  const orig=String(name).trim();
  let s=orig;
  // did the original look like the PACKAGE product? (has a count like "10 times"
  // or literally says "package"). A plain "Bathe Essence" is a single wash.
  const looksPackage = /package/i.test(orig) || /^\s*\d+\s*x?\s*(times?)?/i.test(orig);
  s=s.replace(/^\s*\d+\s*x?\s*(times?\s*)?/i,"").trim();
  if(/bathe\s*essence/i.test(s) && !/package/i.test(s) && looksPackage) s=s+" Package";
  return s;
}

function buildRemark_(name, balanceAfter){
  const clean=cleanService_(name);
  if(balanceAfter==="" || balanceAfter===null || balanceAfter===undefined) return clean;
  const n=parseInt(balanceAfter);
  if(isNaN(n)) return clean;
  return clean+" — "+n+" left";
}

function getMonthSheet_(when){
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const tz=TZ;
  const tabName=Utilities.formatDate(when,tz,"MMM yyyy").toUpperCase();
  let sheet=ss.getSheetByName(tabName);
  if(!sheet){ sheet=ss.insertSheet(tabName); }
  sheet.getRange(HEADER_ROW,1,1,LAST_COL).setValues([HEADERS]).setFontWeight("bold");
  return sheet;
}

function resetSyncMarkers(){
  PropertiesService.getScriptProperties().deleteProperty(PROP_LAST_B);
  PropertiesService.getScriptProperties().deleteProperty(PROP_LAST_J);
  PropertiesService.getScriptProperties().deleteProperty(PROP_LAST_P);
  PropertiesService.getScriptProperties().deleteProperty(PROP_LAST_U);
  Logger.log("Markers reset.");
}

/* Re-scan unpaid records: clears the unpaid marker so the next sync re-checks
   every gl_unpaid row and (with self-heal) creates any missing UNPAID rows. */
function resetUnpaidMarker_(){
  PropertiesService.getScriptProperties().deleteProperty(PROP_LAST_U);
  Logger.log("Unpaid marker reset — next syncNow() re-scans all unpaid.");
  syncNowMenu_();  // force-run (bypass overnight pause)
  SpreadsheetApp.getActive().toast("Re-scanned unpaid records.");
}

/* ONE-SHOT CLEAN REBUILD of the CURRENT month tab.
   Deletes the tab entirely, resets all sync markers, then re-runs syncNow()
   so the month is rebuilt fresh from the database (bookings + jobs + payments).
   Use when a tab has malformed/duplicated rows you want gone.
   NOTE: only rebuilds data dated >= MIRROR_START (1 Jul 2026). Anything the
   database doesn't contain will not reappear. Run from the GrandLab menu. */
function rebuildCurrentMonthClean_(){
  const ui=SpreadsheetApp.getUi();
  const now=new Date();
  const tabName=Utilities.formatDate(now,TZ,"MMM yyyy").toUpperCase();
  const resp=ui.alert("Rebuild "+tabName+"?",
    "This DELETES the entire "+tabName+" tab and rebuilds it from the database "
    +"(bookings, jobs, payments). Manual edits on this tab will be lost.\n\nContinue?",
    ui.ButtonSet.YES_NO);
  if(resp!==ui.Button.YES){ ui.alert("Cancelled."); return; }
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sheet=ss.getSheetByName(tabName);
  if(sheet) ss.deleteSheet(sheet);
  // reset markers so syncNow re-fetches everything from the start
  resetSyncMarkers();
  // rebuild — one pass (stops at the time budget; may need a few more runs)
  syncNowMenu_();  // force-run (bypass overnight pause)
  ui.alert("Started rebuilding "+tabName+".\n\nThe rebuild runs in batches to stay "
    +"under Google's time limit. Run GrandLab → 🔄 Sync now a few more times "
    +"(or wait for the auto-sync) until the tab stops changing. "
    +"The Executions log shows progress.");
}

/* Run ONCE after updating this file so walk-in jobs created earlier get picked up. */
function resetJobsMarker_(){
  PropertiesService.getScriptProperties().deleteProperty(PROP_LAST_J);
  Logger.log("Jobs marker reset — next syncNow() re-scans recent jobs.");
}

/* Run ONCE after updating this file so recent payments get written back. */
/* remove copies of this customer (by plate, else name) that sit in day
   blocks OTHER than the target day. Keeps keepRow; clears the rest and
   recomputes the totals of the affected days. */
function clearStrayCopies_(sheet, p, targetKey, keepRow){
  const data=sheet.getDataRange().getValues();
  const plate=String(p.plate||"").trim().toUpperCase();
  const name =String(p.customer_name||"").trim().toUpperCase();
  if(!plate && !name) return;
  const clearCols=[COL.NAME,COL.CONTACT,COL.CUST_WHERE,COL.ATTENDEE,COL.CAR,COL.PLATE,
    COL.FROM_PRICE,COL.DEPOSIT,COL.DEP_DATE,COL.TOTAL_PAID,COL.PAY_BY,COL.REMARK,
    COL.TUNAI,COL.INVOICE,COL.PAYMENT];
  let curKey="", curDateStr="";
  const daysTouched={};
  for(let i=HEADER_ROW; i<data.length; i++){
    const dval=data[i][COL.DATE-1];
    if(dval!==undefined && dval!==null && String(dval).trim()!==""){
      const k=dateKey_(dval);
      if(k){ curKey=k; curDateStr=String(dval).trim(); }
    }
    if((i+1)===keepRow) continue;              // never clear the keeper
    if(curKey===targetKey) continue;           // keep everything in target day
    const rp=String(data[i][COL.PLATE-1]||"").trim().toUpperCase();
    const rn=String(data[i][COL.NAME-1]||"").trim().toUpperCase();
    const match = plate ? (rp===plate) : (rn===name);
    if(match){
      clearCols.forEach(c=>sheet.getRange(i+1,c).clearContent());
      try{ sheet.getRange(i+1,COL.PAY_BY).setBackground(null); }catch(e){}
      daysTouched[curDateStr]=true;
    }
  }
  Object.keys(daysTouched).forEach(ds=>recomputeDailyTotal_(sheet, ds));
}

function resetPaymentsMarker_(){
  PropertiesService.getScriptProperties().deleteProperty(PROP_LAST_P);
  Logger.log("Payments marker reset — next syncNow() re-scans recent payments.");
}

/* SAFE: remove duplicate APP TOPUP rows (same amount+name+day), keeping one.
   Clears the row content (doesn't delete the row) so slot structure stays. */
function cleanDuplicateTopups_(){
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sheet=getMonthSheet_(new Date());
  const data=sheet.getDataRange().getValues();
  const clearCols=[COL.NAME,COL.CONTACT,COL.CUST_WHERE,COL.ATTENDEE,COL.CAR,COL.PLATE,
    COL.FROM_PRICE,COL.DEPOSIT,COL.DEP_DATE,COL.TOTAL_PAID,COL.PAY_BY,COL.REMARK,
    COL.TUNAI,COL.INVOICE,COL.PAYMENT];
  let curKey="", curDateStr="";
  const seen={};  // key: dayKey|name|amount -> true (first one kept)
  let cleared=0;
  const daysTouched={};
  for(let i=HEADER_ROW; i<data.length; i++){
    const dval=data[i][COL.DATE-1];
    if(dval!==undefined && dval!==null && String(dval).trim()!==""){
      const k=dateKey_(dval); if(k){ curKey=k; curDateStr=String(dval).trim(); }
    }
    const where=String(data[i][COL.CUST_WHERE-1]||"").trim().toUpperCase();
    if(where.indexOf("APP TOPUP")<0) continue;   // only touch topup rows
    const name=String(data[i][COL.NAME-1]||"").trim().toUpperCase();
    const amt=String(data[i][COL.TOTAL_PAID-1]||"").trim();
    const key=curKey+"|"+name+"|"+amt;
    if(seen[key]){
      clearCols.forEach(c=>sheet.getRange(i+1,c).clearContent());
      try{ sheet.getRange(i+1,COL.PAY_BY).setBackground(null); }catch(e){}
      cleared++; daysTouched[curDateStr]=true;
    } else {
      seen[key]=true;
    }
  }
  Object.keys(daysTouched).forEach(ds=>recomputeDailyTotal_(sheet, ds));
  SpreadsheetApp.getActive().toast("Cleared "+cleared+" duplicate top-up row(s).");
}

/* SAFE: re-check recent APP bookings + top-ups only (last 3 days). Rewinds the
   booking/topup markers a little so the next sync re-places recent app
   bookings that may have been missed. Does NOT touch payments or jobs, so it
   won't wipe rows or create the duplicates the payment/job re-scans can. */
function reSyncRecentBookings_(){
  const props=PropertiesService.getScriptProperties();
  const threeDaysAgo=new Date(Date.now()-3*24*60*60*1000).toISOString();
  props.setProperty(PROP_LAST_B, threeDaysAgo);
  props.setProperty(PROP_LAST_TU, threeDaysAgo);
  Logger.log("Booking + top-up markers rewound to "+threeDaysAgo+" — running sync…");
  syncNowMenu_();
  SpreadsheetApp.getActive().toast("Re-synced recent app bookings & top-ups.");
}

/* Diagnostic: trace where a plate currently sits and where its payment
   thinks it should go. Edit PLATE below, run, read the log. */
function DEBUG_trace_plate(){
  const PLATE="A636A";                 // <-- change to the plate you're testing
  const sheet=getMonthSheet_(new Date());
  Logger.log("Tab: "+sheet.getName());

  // 1) fetch the payment for this plate
  const url=SUPABASE_URL+"/rest/v1/gl_payments?select=id,customer_name,plate,net_paid,sale_date,paid_at,sql_keyed_at,voided&plate=eq."+encodeURIComponent(PLATE);
  const rows=fetchRows_(url)||[];
  Logger.log("Payments found: "+rows.length);
  rows.forEach(p=>{
    Logger.log(" pay: name="+p.customer_name+" sale_date="+p.sale_date+" paid_at="+p.paid_at+" voided="+p.voided);
    const when = p.sale_date ? new Date(p.sale_date+"T12:00:00") : new Date(p.paid_at);
    const dateStr=Utilities.formatDate(when,TZ,"d/M/yy");
    Logger.log("  -> target day block: "+dateStr+" (key "+dateKey_(dateStr)+")");
    const inTarget=findRowForPayment_(sheet, dateStr, p);
    Logger.log("  -> found in target block row: "+inTarget);
    const any=findRowAnyBlock_(sheet, p);
    Logger.log("  -> found anywhere: "+(any?("row "+any.row+" in dayKey "+any.dateKey+" ("+any.oldDateStr+")"):"NONE"));
  });
}

/* Force-move a plate's row to the date its payment's sale_date says.
   Edit PLATE below, run once, then check the sheet. */
function DEBUG_force_move_plate(){
  const PLATE="A636A";                 // <-- change to the plate you're testing
  const sheet=getMonthSheet_(new Date());
  const url=SUPABASE_URL+"/rest/v1/gl_payments?select=id,customer_name,plate,net_paid,package_used,attendee,invoice_no,sql_invoice_no,sql_payment_no,sale_date,paid_at,voided&plate=eq."+encodeURIComponent(PLATE);
  const rows=fetchRows_(url)||[];
  if(!rows.length){ Logger.log("No payment for "+PLATE); return; }
  rows.forEach(p=>{
    const when = p.sale_date ? new Date(p.sale_date+"T12:00:00") : new Date(p.paid_at);
    ensureMonthBuilt_(sheet, when);
    stampPayment_(sheet, p, when);
    Logger.log("Processed "+PLATE+" -> "+Utilities.formatDate(when,TZ,"d/M/yy"));
  });
}

function DEBUG_dates(){
  const tz=TZ;
  Logger.log("Script project TZ: "+Session.getScriptTimeZone()+" | TZ const: "+tz);
  const b=new Date("2026-07-04T01:00:00+00:00");
  const bDateStr=Utilities.formatDate(b,tz,"d/M/yy");
  Logger.log("GINO scheduled_at -> dateStr: "+bDateStr+" | dateKey: "+dateKey_(bDateStr));
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sheet=ss.getSheetByName("JUL 2026");
  if(!sheet){ Logger.log("No 'JUL 2026' tab! Tabs: "+ss.getSheets().map(s=>s.getName()).join(", ")); return; }
  const data=sheet.getDataRange().getValues();
  Logger.log("Looking for a row whose DATE dateKey = "+dateKey_(bDateStr));
  let shown=0, found=false;
  for(let i=HEADER_ROW;i<data.length;i++){
    let dval=data[i][COL.DATE-1];
    if(dval==="" || dval==null) continue;
    const k=dateKey_(dval);
    const isDate=(dval instanceof Date);
    if(shown<10){ Logger.log("Row "+(i+1)+" DATE raw="+(isDate?Utilities.formatDate(dval,tz,'d/M/yy')+'(Date)':String(dval)+'(text)')+" -> dateKey="+k); shown++; }
    if(k===dateKey_(bDateStr)){ found=true; Logger.log(">>> MATCH at row "+(i+1)); }
  }
  if(!found) Logger.log("!!! NO row matched GINO's date key.");
}

/* DEBUG: dump every row of the active tab grouped exactly as dedupeSheet_ sees
   it, so we can find why two copies of a plate aren't grouping. Open the tab
   with the doubles, run this, read the log. */
function DEBUG_dedupe_view(){
  const sheet=SpreadsheetApp.getActiveSheet();
  const data=sheet.getDataRange().getValues();
  let curKey="";
  const groups={};
  for(let i=HEADER_ROW; i<data.length; i++){
    const dval=data[i][COL.DATE-1];
    if(dval!==undefined && dval!==null && String(dval).trim()!==""){
      const k=dateKey_(dval); if(k) curKey=k;
    }
    const plate=String(data[i][COL.PLATE-1]||"").trim().toUpperCase();
    const name =String(data[i][COL.NAME-1]||"").trim().toUpperCase();
    if(!plate && !name) continue;
    const id = plate ? ("P:"+plate) : ("N:"+name);
    const gk = curKey+"|"+id;
    (groups[gk]=groups[gk]||[]).push(i+1);
    // show first ~30 identity rows with their exact key + plate bytes
    if(i<40){
      Logger.log("row "+(i+1)+" key="+curKey+" plate=["+plate+"] name=["+name+"] sep@next="+isSeparator_(sheet,i+2));
    }
  }
  Logger.log("---- groups with 2+ rows (these SHOULD dedupe) ----");
  Object.keys(groups).forEach(gk=>{
    if(groups[gk].length>=2) Logger.log(gk+" -> rows "+groups[gk].join(","));
  });
}

/* DEBUG: force a dedupe pass on the active tab and log how many rows cleared. */
function DEBUG_force_dedupe_active(){
  const sheet=SpreadsheetApp.getActiveSheet();
  dedupeSheet_(sheet);
  recomputeAllDayTotals_(sheet);
  SpreadsheetApp.getActive().toast("Force dedupe + rebuild done on "+sheet.getName());
}

/* DEBUG: dump the raw gl_unpaid fetch so we can see if records come back and
   what fields they carry. Run this, then read the Executions log. */
/* DEBUG: single tiny fetch to confirm whether the daily UrlFetch quota is the
   blocker. If this THROWS or logs a quota message, you're quota-blocked and
   must wait for the reset (~midnight Pacific / ~3-4pm MYT). If it logs a row
   count, fetching works and the problem is elsewhere. */
function DEBUG_quota(){
  try{
    const res=glFetch_(SUPABASE_URL+"/rest/v1/gl_jobs?select=id&limit=1",
      {method:"get",headers:{apikey:svcKey_(),Authorization:"Bearer "+svcKey_()},muteHttpExceptions:true});
    Logger.log("✅ Fetch OK — HTTP "+res.getResponseCode()+" — quota is NOT the problem.");
  }catch(e){
    Logger.log("⛔ Fetch THREW: "+e+"\n   => Daily UrlFetch quota is exhausted. Wait for reset (~3-4pm MYT).");
  }
}

function DEBUG_unpaid(){
  // fetch ALL unpaid regardless of marker
  const url=SUPABASE_URL+"/rest/v1/gl_unpaid?select=id,invoice_no,customer_name,plate,amount_owed,gross,settled,created_at,settled_at,workshop_name,job_id&order=created_at.desc&limit=30";
  const rows=fetchRows_(url);
  if(rows===null){ Logger.log("DEBUG_unpaid: FETCH FAILED (null) — check service key / RLS."); return; }
  Logger.log("DEBUG_unpaid: fetched "+rows.length+" rows");
  rows.forEach(u=>{
    Logger.log(" id="+u.id+" name=["+(u.customer_name||"")+"] plate=["+(u.plate||"")+"] owed="+u.amount_owed
      +" settled="+u.settled+" created_at="+u.created_at+" inv="+u.invoice_no+" ws=["+(u.workshop_name||"")+"]");
  });
  // also show what the current marker is
  const last=PropertiesService.getScriptProperties().getProperty("gl_unpaid_last_synced_at");
  Logger.log("current gl_unpaid marker = "+last);
  // and today's date key the mirror would use
  const now=new Date();
  Logger.log("today d/M/yy = "+Utilities.formatDate(now,TZ,"d/M/yy")+" | MIRROR_START = "+MIRROR_START);
}