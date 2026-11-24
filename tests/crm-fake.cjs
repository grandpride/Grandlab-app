/* Fake Supabase client for gl-crm.html browser tests (no network). */
exports.STUB = `
window.__DB={gl_wa_chat:[],gl_wa_msg:[],gl_wa_outbox:[],gl_crm_task:[]};
window.__RPC={};window.__LOG=[];window.__CH=[];
function iso(t){return typeof t==='number'?new Date(t).toISOString():t}
function Q(table){
  const q={table,filters:[],ord:null,lim:null,op:'select',payload:null};
  const api={
    select(){ if(q.op==='select') q.op='select'; return api; },
    order(c,o){q.ord=[c,(o&&o.ascending)!==false];return api;},
    limit(n){q.lim=n;return api;},
    eq(c,v){q.filters.push(r=>String(r[c])===String(v));return api;},
    ilike(c,v){const needle=String(v).split('%').join('').toLowerCase();q.filters.push(r=>String(r[c]||'').toLowerCase().includes(needle));return api;},
    in(c,a){q.filters.push(r=>a.includes(r[c]));return api;},
    gt(c,v){q.filters.push(r=>r[c]&&new Date(r[c])>new Date(v));return api;},
    lte(c,v){q.filters.push(r=>r[c]&&new Date(r[c])<=new Date(v));return api;},
    gte(c,v){q.filters.push(r=>r[c]&&new Date(r[c])>=new Date(v));return api;},
    or(str){const parts=str.split(',').map(p=>{const m=/^(\\w+)\\.gt\\.(.+)$/.exec(p);return r=>r[m[1]]&&new Date(r[m[1]])>new Date(m[2]);});q.filters.push(r=>parts.some(f=>f(r)));return api;},
    insert(row){q.op='insert';q.payload=row;return api;},
    upsert(row){q.op='upsert';q.payload=row;return api;},
    update(row){q.op='update';q.payload=row;return api;},
    single(){q.single=true;return api;},
    maybeSingle(){q.single=true;return api;},
    then(res,rej){return run().then(res,rej);}
  };
  async function run(){
    window.__LOG.push({table,op:q.op,at:Date.now()});
    const delay=(window.__DELAY&&window.__DELAY[table])||0; if(delay) await new Promise(r=>setTimeout(r,delay));
    const t=window.__DB[table]||(window.__DB[table]=[]);
    if(q.op==='upsert'){ const r=q.payload; const ex=t.find(x=>x.key===r.key); if(ex) Object.assign(ex,r); else t.push(Object.assign({},r)); return {data:null,error:null}; }
    if(q.op==='insert'){ const made=[]; for(const r of (Array.isArray(q.payload)?q.payload:[q.payload])){ if(table==='gl_crm_autobook'&&t.find(x=>x.key===r.key)) return {data:null,error:{message:'duplicate key',code:'23505'}}; const row=Object.assign({id:t.length+1,status:'queued',created_at:new Date().toISOString()},r); t.push(row); made.push(row); } return {data:q.single?(made[0]||null):made,error:null}; }
    let rows=t.filter(r=>q.filters.every(f=>f(r)));
    if(q.op==='update'){ rows.forEach(r=>Object.assign(r,q.payload)); return {data:null,error:null}; }
    if(q.ord){const [c,asc]=q.ord;rows=rows.slice().sort((a,b)=>{const x=a[c]||'',y=b[c]||'';return (x<y?-1:x>y?1:0)*(asc?1:-1);});}
    if(q.lim!=null) rows=rows.slice(0,q.lim);
    rows=rows.map(r=>Object.assign({},r));
    return {data:q.single?(rows[0]||null):rows,error:null};
  }
  return api;
}
window.supabase={createClient(){return{
  from:Q,
  rpc:async(n,a)=>{window.__LOG.push({rpc:n,args:a,at:Date.now()});const f=window.__RPC[n];const d=f?await f(a):[];return {data:d,error:null};},
  auth:{getSession:async()=>({data:{session:{access_token:'t',user:{id:'9684de35-a49c-4630-b02b-a1deb8d52e6f'}}}}),signInWithPassword:async()=>({data:{},error:null}),onAuthStateChange(){return{data:{subscription:{unsubscribe(){}}}}}},
  channel(){const ch={on(a,b,cb){window.__CH.push({b,cb});return ch;},subscribe(cb){cb&&cb('SUBSCRIBED');return ch;}};return ch;},
  removeChannel(){},
  storage:{from(){return{createSignedUrl:async p=>({data:{signedUrl:'https://files.test/'+p+'?t=1'},error:null})};}}
};}};
`;
exports.setup = async function(page, htmlPath){
  await page.route('**/cdn.jsdelivr.net/**', r=>r.fulfill({contentType:'application/javascript',body:exports.STUB}));
  await page.route('**/fonts.googleapis.com/**', r=>r.fulfill({body:''}));
  await page.goto('file://'+htmlPath);
};
