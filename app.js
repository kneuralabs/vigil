/* ============================================================
   VIGIL — live monitoring logic (crt.sh + Google DoH + agent)
   Shell redesigned; data plane preserved & extended with viz.
   ============================================================ */

/* ---------- clock ---------- */
function tick(){
  const d=new Date();
  document.getElementById('clock').textContent=d.toUTCString().replace('GMT','UTC');
}
setInterval(tick,1000);tick();

function ts(){return new Date().toTimeString().slice(0,8);}

let PUBLIC_DOMAIN='kneuralabs.com';

/* Subdomains auto-enumerated from crt.sh CT data on each scan.
   { host: {expiry:Date|null, daysLeft:number|null} } — the single source of
   truth for the subdomain surface sweep, so no list is ever maintained by hand. */
let DISCOVERED_SUBS={};
/* Cap the live reachability sweep so a domain with hundreds of CT entries
   doesn't fire hundreds of concurrent probes from the browser. */
const MAX_SUBDOMAIN_PROBES=60;

/* Build the host -> latest-cert map from crt.sh rows (common_name + SANs),
   restricted to the current apex domain, wildcards/dupes removed. */
function buildSubdomains(certs){
  const map={};
  certs.forEach(c=>{
    const names=[];
    if(c.common_name)names.push(c.common_name);
    if(c.name_value)String(c.name_value).split('\n').forEach(n=>names.push(n));
    const exp=new Date(c.not_after);
    names.forEach(raw=>{
      let h=String(raw||'').trim().toLowerCase().replace(/\.$/,'');
      if(!h||h.indexOf('*')>=0||h.indexOf(' ')>=0)return;
      if(h!==PUBLIC_DOMAIN&&!h.endsWith('.'+PUBLIC_DOMAIN))return;
      const cur=map[h];
      if(!cur||(!isNaN(exp)&&exp>cur.expiry)){map[h]={expiry:isNaN(exp)?null:exp};}
    });
  });
  const now=Date.now();
  Object.keys(map).forEach(h=>{
    const e=map[h].expiry;
    map[h].daysLeft=e?Math.floor((e-now)/864e5):null;
  });
  return map;
}

function hostFromUrl(raw){
  let h=raw.trim();
  try{h=new URL(h).host;}catch(_){h=h.replace(/^[a-z]+:\/\//i,'').split('/')[0];}
  return h.replace(/^www\./i,'');
}

function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function copyText(text,btn){
  const done=function(){if(btn){const o=btn.textContent;btn.textContent='Copied';setTimeout(function(){btn.textContent=o;},1200);}};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,done);}
  else{const t=document.createElement('textarea');t.value=text;document.body.appendChild(t);t.select();try{document.execCommand('copy');}catch(_){}t.remove();done();}
}

/* ---------- intranet services (clean mono tags, no emoji) ---------- */
const INTRANET_SERVICES=[
  {name:'Intranet Root',     path:'',          tag:'ROOT'},
  {name:'SSO / Auth Portal', path:'/auth',     tag:'SSO'},
  {name:'HR System',         path:'/hr',       tag:'HR'},
  {name:'Dev Tools',         path:'/dev',      tag:'DEV'},
  {name:'File Storage',      path:'/files',    tag:'FS'},
  {name:'Analytics',         path:'/analytics',tag:'ANL'},
  {name:'VPN Gateway',       path:'/vpn',      tag:'VPN'},
  {name:'API Gateway',       path:'/api',      tag:'API'}
];
/* Active probe list. Defaults to the hardcoded set above; replaced by the
   agent's /config service list once an agent connects, so the agent's
   config.json is the single source of truth when one is available. */
let intranetServices=INTRANET_SERVICES;
function makeTag(name){
  const m=INTRANET_SERVICES.find(s=>s.name===name);
  if(m)return m.tag;
  return String(name||'SVC').replace(/[^A-Za-z]/g,'').slice(0,4).toUpperCase()||'SVC';
}
async function fetchAgentServices(configUrl){
  try{
    const r=await fetch(configUrl,{cache:'no-store'});
    if(!r.ok)return;
    const c=await r.json();
    if(!c||typeof c!=='object'||!Array.isArray(c.services))return;
    const list=c.services
      .filter(s=>s&&typeof s==='object'&&s.name&&s.url)
      .map(s=>({name:String(s.name),url:String(s.url),tag:makeTag(s.name)}));
    if(list.length){
      intranetServices=list;
      addEvent('info','Agent Config','Probe list synced from agent: '+list.length+' service(s).');
    }
  }catch(_){/* /config endpoint optional — keep hardcoded defaults */}
}
let agentConnected=false;
let scanning=false;          /* re-entrancy guard so auto-refresh never overlaps a run */
let autoRefreshTimer=null;   /* periodic re-scan keeps the public data live, not a snapshot */
let lastRefresh=0;           /* timestamp of the last completed/started scan (manual or auto) */

/* ---------- localStorage cache for public API results (5-minute TTL) ---------- */
const API_CACHE_TTL_MS=5*60*1000;
function cacheKey(check,domain){return 'vigil.cache.'+check+'.'+domain;}
function cacheGet(check,domain){
  try{
    const raw=localStorage.getItem(cacheKey(check,domain));
    if(!raw)return null;
    const obj=JSON.parse(raw);
    if(!obj||typeof obj!=='object'||(Date.now()-obj.t)>API_CACHE_TTL_MS)return null;
    return obj.d;
  }catch(_){return null;}
}
function cacheSet(check,domain,data){
  try{localStorage.setItem(cacheKey(check,domain),JSON.stringify({t:Date.now(),d:data}));}catch(_){}
}

/* ---------- count-up animation for KPI numbers ---------- */
function animateCount(el,to,suffix,dur){
  if(el.__raf)cancelAnimationFrame(el.__raf);
  const from=parseFloat(String(el.textContent).replace(/[^\d.-]/g,''))||0;
  const target=Number(to);if(!isFinite(target)){el.textContent=to+(suffix||'');return;}
  const t0=performance.now();dur=dur||650;
  function step(now){
    const k=Math.min(1,(now-t0)/dur);
    const e=1-Math.pow(1-k,3);
    const v=Math.round(from+(target-from)*e);
    el.textContent=v+(suffix||'');
    if(k<1)el.__raf=requestAnimationFrame(step);
  }
  el.__raf=requestAnimationFrame(step);
}

/* ---------- staggered bar fill (reads data-w width% or data-h height%) ---------- */
function animateBars(selector,prop){
  setTimeout(function(){
    var bars=[].slice.call(document.querySelectorAll(selector));
    bars.forEach(function(b,i){
      var v=b.getAttribute('data-'+(prop==='height'?'h':'w'));
      if(v==null)return;
      b.style.transitionDelay=(i*35)+'ms';
      b.style[prop]=v+'%';
    });
  },60);
}

/* ---------- KPI card setter (number animates; track fills) ---------- */
function setCard(id,cls,val,sub,opts){
  const c=document.getElementById('card-'+id);
  if(c)c.className='stat-card '+cls;
  const v=document.getElementById('val-'+id);
  if(v){
    opts=opts||{};
    if(opts.count&&/^\d+/.test(String(val))){
      const m=String(val).match(/^(\d+)(.*)$/);
      animateCount(v,parseInt(m[1],10),m[2]);
    }else{
      v.innerHTML=val;
    }
  }
  const s=document.getElementById('sub-'+id);
  if(s)s.textContent=sub;
  const track=document.getElementById('track-'+id);
  if(track){
    const pct=(opts&&opts.pct!=null)?Math.max(4,Math.min(100,opts.pct)):(cls==='ok'?100:cls==='warn'?55:cls==='crit'?22:0);
    requestAnimationFrame(()=>{track.style.width=pct+'%';});
  }
}

/* ---------- event feed (streaming) ---------- */
function addEvent(type,title,msg){
  const feed=document.getElementById('event-feed');
  if(feed.querySelector('div[style]'))feed.innerHTML='';
  const div=document.createElement('div');
  div.className='event '+type;
  div.innerHTML='<span class="event-time">'+ts()+'</span><div class="event-body"><strong>'+title+'</strong><p>'+msg+'</p></div>';
  feed.insertBefore(div,feed.firstChild);
  if(feed.children.length>30)feed.removeChild(feed.lastChild);
}

/* ---------- intranet service row ---------- */
function intranetRow(tag,name,sub,cls,label,latPct){
  const lat=latPct!=null?'<div class="lat"><i class="'+cls+'" data-w="'+latPct+'"></i></div>':'';
  return '<div class="alarm"><span class="alarm-icon">'+esc(tag)+'</span>'+
    '<div class="alarm-body"><strong>'+esc(name)+'</strong><p>'+sub+'</p>'+lat+'</div>'+
    '<span class="badge '+cls+'">'+label+'</span></div>';
}

/* ---------- DNS existence check (Google DoH) ----------
   CT logs keep every hostname ever issued a cert, including ones whose DNS
   record was long ago removed. Those hosts no longer exist, so probing them
   only produces phantom "DOWN" rows. Resolve each candidate first and treat a
   definitive NXDOMAIN as "does not exist" so it can be dropped from the sweep.
   Returns 'yes' (resolves), 'no' (NXDOMAIN — gone), or 'unknown' (DoH failed —
   keep it and let the live probe decide, so we never hide a real host). */
async function dohResolves(host){
  try{
    let d=cacheGet('doh-sub-A',host);
    if(!d){
      const r=await fetch('https://dns.google/resolve?name='+encodeURIComponent(host)+'&type=A');
      d=await r.json();
      cacheSet('doh-sub-A',host,d);
    }
    if(d&&Array.isArray(d.Answer)&&d.Answer.length)return 'yes';
    if(d&&d.Status===3)return 'no';   /* NXDOMAIN — the name does not exist */
    return 'unknown';
  }catch(_){return 'unknown';}
}

/* ---------- no-cors reachability probe ---------- */
async function probeOne(url,timeoutMs){
  const start=performance.now();
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(),timeoutMs||6000);
  try{
    await fetch(url,{mode:'no-cors',cache:'no-store',signal:ctrl.signal});
    clearTimeout(t);
    return {ok:true,ms:Math.round(performance.now()-start)};
  }catch(e){
    clearTimeout(t);
    return {ok:false,ms:Math.round(performance.now()-start),why:e.name==='AbortError'?'timeout':'unreachable'};
  }
}

/* ============================================================
   SSL / CT — live crt.sh, with validity timeline + histogram
   ============================================================ */
async function checkSSLandCT(force){
  try{
    let data=force?null:cacheGet('crtsh',PUBLIC_DOMAIN);
    if(data){
      addEvent('info','SSL &amp; CT Scan','Using cached crt.sh data for '+PUBLIC_DOMAIN+' (≤5 min old)');
    }else{
      addEvent('info','SSL &amp; CT Scan','Querying crt.sh for '+PUBLIC_DOMAIN+'…');
      const r=await fetch('https://crt.sh/?q='+encodeURIComponent(PUBLIC_DOMAIN)+'&output=json');
      if(!r.ok)throw new Error('crt.sh HTTP '+r.status);
      data=await r.json();
      cacheSet('crtsh',PUBLIC_DOMAIN,data);
    }
    if(!data||!data.length){setCard('ssl','warn','None','No certs in CT log');return;}

    const sorted=data.slice().sort((a,b)=>new Date(b.not_after)-new Date(a.not_after));
    DISCOVERED_SUBS=buildSubdomains(sorted);
    const latest=sorted[0];
    const notBefore=new Date(latest.not_before);
    const expiry=new Date(latest.not_after);
    const now=new Date();
    const daysLeft=Math.floor((expiry-now)/864e5);
    const totalDays=Math.max(1,Math.round((expiry-notBefore)/864e5));
    const elapsedPct=Math.max(0,Math.min(100,Math.round(((now-notBefore)/(expiry-notBefore))*100)));
    const issuerMatch=(latest.issuer_name||'').match(/O=([^,]+)/);
    const issuer=issuerMatch?issuerMatch[1].trim():(latest.issuer_name||'Unknown').slice(0,24);
    const cls=daysLeft>60?'ok':daysLeft>20?'warn':'crit';
    const lifePct=Math.max(4,Math.min(100,Math.round((daysLeft/totalDays)*100)));

    setCard('ssl',cls,daysLeft+'d','Expires '+expiry.toDateString().slice(4,15),{count:true,pct:lifePct});
    setCard('certs','ok',String(data.length),'Certs in CT log',{count:true,pct:100});
    setCard('issuer','ok',esc(issuer.split(' ')[0]),issuer,{pct:100});

    const sb=document.getElementById('ssl-badge');
    sb.className='badge '+cls;
    sb.textContent=daysLeft>60?'VALID':daysLeft>20?'EXPIRING SOON':'CRITICAL';

    document.getElementById('ssl-details').innerHTML=
      '<div class="timeline">'+
        '<div class="timeline-meta"><span>Validity window</span><span>'+totalDays+'d total · '+elapsedPct+'% elapsed</span></div>'+
        '<div class="timeline-bar"><i id="tl-fill"></i><span class="timeline-now" id="tl-now"></span></div>'+
        '<div class="timeline-labels">'+
          '<div><b>'+notBefore.toDateString().slice(4,11)+'</b><span>issued</span></div>'+
          '<div style="text-align:right"><b class="'+(cls==='ok'?'':'')+'" style="color:var(--'+cls+')">'+daysLeft+'d left</b><span>'+expiry.toDateString().slice(4,11)+'</span></div>'+
        '</div>'+
      '</div>'+
      '<div class="cert-info">'+
      '<div class="cert-row"><span class="cert-key">Common Name</span><span class="cert-val ok">'+esc(latest.common_name||PUBLIC_DOMAIN)+'</span></div>'+
      '<div class="cert-row"><span class="cert-key">Issuer</span><span class="cert-val">'+esc(issuer)+'</span></div>'+
      '<div class="cert-row"><span class="cert-key">Valid From</span><span class="cert-val">'+notBefore.toDateString().slice(4)+'</span></div>'+
      '<div class="cert-row"><span class="cert-key">Valid Until</span><span class="cert-val '+cls+'">'+expiry.toDateString().slice(4)+'</span></div>'+
      '<div class="cert-row"><span class="cert-key">CT Entry ID</span><span class="cert-val">'+esc(latest.id)+'</span></div>'+
      '</div>';
    requestAnimationFrame(()=>{
      const f=document.getElementById('tl-fill'),n=document.getElementById('tl-now');
      if(f)f.style.width=elapsedPct+'%';
      if(n)n.style.left='calc('+elapsedPct+'% - 1px)';
    });
    animateBars('#ct-histo .bar','height');
    /* CT panel: issuance histogram by month from real not_before dates */
    const buckets={};
    sorted.forEach(c=>{
      const d=new Date(c.not_before);if(isNaN(d))return;
      const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
      buckets[k]=(buckets[k]||0)+1;
    });
    const keys=Object.keys(buckets).sort().slice(-12);
    const maxB=Math.max(1,...keys.map(k=>buckets[k]));
    const sans=[...new Set(sorted.slice(0,8).map(c=>c.common_name).filter(Boolean))];

    document.getElementById('crt-badge').className='badge ok';
    document.getElementById('crt-badge').textContent=data.length+' ENTRIES';
    document.getElementById('crt-details').innerHTML=
      (keys.length?(
        '<div class="histo" id="ct-histo">'+
          keys.map(k=>'<div class="bar" data-c="'+buckets[k]+'" data-h="'+Math.round((buckets[k]/maxB)*100)+'"></div>').join('')+
        '</div>'+
        '<div class="histo-axis"><span>'+keys[0]+'</span><span>issuance / month</span><span>'+keys[keys.length-1]+'</span></div>'
      ):'')+
      '<div class="cert-info">'+
      '<div class="cert-row"><span class="cert-key">Total CT Entries</span><span class="cert-val ok">'+data.length+'</span></div>'+
      '<div class="cert-row"><span class="cert-key">Latest Issuance</span><span class="cert-val">'+notBefore.toDateString().slice(4)+'</span></div>'+
      '<div style="margin:8px 2px 5px" class="sub-head">Domains seen in CT log</div>'+
      sans.map(n=>'<div class="cert-row"><span class="cert-key">SAN</span><span class="cert-val">'+esc(n)+'</span></div>').join('')+
      '</div>';

    addEvent('ok','SSL Cert Live','Expires in '+daysLeft+' days · Issuer '+issuer+' · '+data.length+' CT entries');
  }catch(e){
    setCard('ssl','crit','ERR','crt.sh: '+e.message.slice(0,28));
    setCard('certs','warn','&#x2014;','crt.sh unreachable',{pct:30});
    setCard('issuer','warn','&#x2014;','crt.sh unreachable',{pct:30});
    document.getElementById('ssl-badge').className='badge crit';
    document.getElementById('ssl-badge').textContent='UNREACHABLE';
    document.getElementById('crt-badge').className='badge crit';
    document.getElementById('crt-badge').textContent='UNREACHABLE';
    addEvent('crit','SSL Check Failed',e.message);
    document.getElementById('ssl-details').innerHTML='<div class="cors-note">Error: '+esc(e.message)+'</div>';
    document.getElementById('crt-details').innerHTML='<div class="cors-note">Could not reach crt.sh</div>';
  }
}

/* ============================================================
   DNS — live Google DoH
   ============================================================ */
async function checkDNS(force){
  const types=[{t:'A',code:1},{t:'AAAA',code:28},{t:'MX',code:15},{t:'NS',code:2},{t:'TXT',code:16},{t:'CAA',code:257}];
  const rows=[];
  let hasMX=false;
  try{
    addEvent('info','DNS Probe','Google DoH resolving '+PUBLIC_DOMAIN+' records…');
    for(const {t,code} of types){
      try{
        let d=force?null:cacheGet('doh-'+t,PUBLIC_DOMAIN);
        if(!d){
          const r=await fetch('https://dns.google/resolve?name='+encodeURIComponent(PUBLIC_DOMAIN)+'&type='+code);
          d=await r.json();
          cacheSet('doh-'+t,PUBLIC_DOMAIN,d);
        }
        if(d.Answer){
          d.Answer.forEach(a=>{rows.push({type:t,val:a.data});});
          if(t==='MX'){hasMX=true;setCard('mx','ok','MX','Mail configured',{pct:100});}
        }
      }catch(_){}
    }
    if(!hasMX)setCard('mx','warn','None','No MX record',{pct:50});

    if(rows.length){
      setCard('dns','ok','OK',rows.length+' records',{pct:100});
      document.getElementById('dns-badge').className='badge ok';
      document.getElementById('dns-badge').textContent='RESOLVED';
      document.getElementById('dns-details').innerHTML=
        rows.slice(0,14).map(r=>'<div class="dns-row"><span class="dns-type">'+r.type+'</span><span class="dns-val">'+esc(r.val)+'</span></div>').join('');
      addEvent('ok','DNS Resolved',rows.length+' records fetched via Google DoH');
    }else{
      setCard('dns','warn','?','No records',{pct:30});
      addEvent('warn','DNS Empty',PUBLIC_DOMAIN+' returned no DNS records');
    }
  }catch(e){
    setCard('dns','crit','ERR','DoH failed');
    addEvent('crit','DNS Failed',e.message);
  }
}

/* ============================================================
   INTRANET — live browser reachability sweep (with latency bars)
   ============================================================ */
/* Best-effort intranet target derived from the public surface domain, e.g.
   kneuralabs.com -> https://intranet.kneuralabs.com. Lets the sweep always
   run against something sensible with no separate manual URL entry. */
function intranetDefaultFromPublic(){
  const pub=(document.getElementById('public-url')||{}).value||'';
  const host=hostFromUrl((pub||PUBLIC_DOMAIN||'').trim());
  if(!host)return '';
  if(/^intranet\./i.test(host))return 'https://'+host;
  return 'https://intranet.'+host;
}
async function checkIntranet(){
  if(agentConnected){
    addEvent('info','Intranet','Agent connected — rows reflect live HTTP status from the /status feed.');
    return;
  }
  const probe=document.getElementById('intranet-probe');
  let raw=document.getElementById('intranet-url-input').value.trim();
  const titleEl=document.getElementById('intranet-probe-title');
  const noteEl=document.getElementById('intranet-probe-note');
  const badge=document.getElementById('agent-badge');
  const radar=document.getElementById('probe-radar');
  /* No intranet URL typed in? Derive one from the public surface domain and
     fill it back in, so the sweep always has a target without manual entry. */
  if(!raw){
    raw=intranetDefaultFromPublic();
    const box=document.getElementById('intranet-url-input');
    if(box&&raw)box.value=raw;
  }
  if(!raw){
    probe.innerHTML='<div style="color:var(--muted);font-size:.68rem;padding:8px 10px;font-family:var(--font-mono)">No intranet URL entered.</div>';
    setCard('intranet','warn','&#x2014;','No URL');
    if(!agentConnected){badge.className='badge warn';badge.textContent='NO URL';}
    return;
  }
  const host=hostFromUrl(raw);
  document.getElementById('intranet-domain-label').textContent=host;
  let base;
  try{base=new URL(raw).origin;}
  catch(_){try{base=new URL('https://'+raw).origin;}catch(__){base='https://'+host;}}

  titleEl.textContent='Probing '+intranetServices.length+' services…';titleEl.style.color='var(--info)';
  if(radar)radar.classList.add('live');
  noteEl.innerHTML='Running live reachability probes against <strong>'+esc(host)+'</strong> endpoints from your browser…';
  probe.innerHTML='<div style="color:var(--muted);font-size:.68rem;padding:8px 10px;font-family:var(--font-mono)"><span class="spinner"></span> Sweeping '+intranetServices.length+' endpoints…</div>';
  if(!agentConnected){badge.className='badge info';badge.textContent='SCANNING…';}
  addEvent('info','Intranet Sweep','Probing '+intranetServices.length+' '+host+' endpoints from your browser…');

  const results=await Promise.all(intranetServices.map(async svc=>{
    const url=svc.url?svc.url:base+svc.path;
    const r=await probeOne(url,6000);
    return Object.assign({url:url},svc,r);
  }));

  let up=0;
  const maxMs=Math.max(1,...results.map(r=>r.ms||0));
  const rows=results.map(r=>{
    const path=r.url.replace(/^https?:\/\//i,'');
    const latPct=Math.max(6,Math.min(100,Math.round((r.ms/maxMs)*100)));
    if(r.ok){
      up++;
      const slow=r.ms>1500;
      return intranetRow(r.tag,r.name,path+' &middot; '+r.ms+' ms',slow?'warn':'ok',slow?'SLOW':'REACHABLE',latPct);
    }
    return intranetRow(r.tag,r.name,path+' &middot; '+(r.why==='timeout'?'timed out (6s)':'no response')+' &middot; '+r.ms+' ms','crit',r.why==='timeout'?'TIMEOUT':'DOWN',latPct);
  }).join('');
  probe.innerHTML=rows;
  animateBars('#intranet-probe .lat i','width');

  const total=results.length;
  const cls=up===total?'ok':(up===0?'crit':'warn');
  titleEl.textContent=up+' / '+total+' endpoints reachable';
  titleEl.style.color='var(--'+cls+')';
  noteEl.innerHTML='Live browser probe of <strong>'+esc(host)+'</strong>. "Reachable" means the endpoint answered (status &amp; body are opaque cross-origin). For status codes, per-route latency and logs, connect the agent.';
  setCard('intranet',cls,up+'/'+total,up+' reachable',{pct:Math.round((up/total)*100)});

  if(!agentConnected){
    badge.className='badge '+cls;
    badge.textContent='LIVE PROBE · '+up+'/'+total+' UP';
  }
  addEvent(cls,'Intranet Sweep Done',up+' of '+total+' '+host+' endpoints reachable');
}

/* ============================================================
   SUBDOMAINS — auto-enumerated from CT log, live reachability sweep
   ============================================================ */
function rankSub(h){
  /* apex first, then www, then shallow names, then the rest alphabetically */
  if(h===PUBLIC_DOMAIN)return '0';
  if(h==='www.'+PUBLIC_DOMAIN)return '1';
  return '2'+String(h.split('.').length)+h;
}
async function checkSubdomains(){
  const list=document.getElementById('subdomain-list');
  const titleEl=document.getElementById('subs-title');
  const noteEl=document.getElementById('subs-note');
  const badge=document.getElementById('subs-badge');
  const radar=document.getElementById('subs-radar');
  const lbl=document.getElementById('subdomain-domain-label');
  if(lbl)lbl.textContent='*.'+PUBLIC_DOMAIN;

  let hosts=Object.keys(DISCOVERED_SUBS).sort((a,b)=>rankSub(a)<rankSub(b)?-1:1);
  if(!hosts.length){
    setCard('subs','warn','0','None in CT log',{pct:20});
    badge.className='badge warn';badge.textContent='NONE FOUND';
    titleEl.textContent='No subdomains in CT log';titleEl.style.color='var(--warn)';
    noteEl.textContent='crt.sh returned no certificates for this domain, so there is nothing to enumerate.';
    list.innerHTML='<div style="color:var(--muted);font-size:.68rem;padding:8px 10px;font-family:var(--font-mono)">No subdomains discovered.</div>';
    return;
  }
  const total=hosts.length;
  const candidates=hosts.slice(0,MAX_SUBDOMAIN_PROBES);

  if(radar)radar.classList.add('live');
  badge.className='badge info';badge.textContent='RESOLVING…';
  titleEl.textContent='Resolving '+candidates.length+' of '+total+' subdomains…';titleEl.style.color='var(--info)';
  list.innerHTML='<div style="color:var(--muted);font-size:.68rem;padding:8px 10px;font-family:var(--font-mono)"><span class="spinner"></span> Resolving '+candidates.length+' subdomains via DNS…</div>';
  addEvent('info','Subdomain Enumeration',total+' subdomain(s) found in CT log · checking which still resolve…');

  /* Drop stale CT entries that no longer resolve (NXDOMAIN) so they never show
     up as phantom "DOWN" hosts — they simply don't exist anymore. */
  const states=await Promise.all(candidates.map(dohResolves));
  const probed=candidates.filter((h,i)=>states[i]!=='no');
  const retired=candidates.length-probed.length;
  if(retired)addEvent('info','Stale Hosts Skipped',retired+' CT hostname'+(retired>1?'s':'')+' no longer resolve (NXDOMAIN) — excluded from the reachability sweep');

  if(!probed.length){
    if(radar)radar.classList.remove('live');
    setCard('subs','warn','0/0','None resolve · '+retired+' retired',{pct:20});
    badge.className='badge warn';badge.textContent='NONE RESOLVE';
    titleEl.textContent='No live subdomains';titleEl.style.color='var(--warn)';
    noteEl.innerHTML='All '+total+' hostname'+(total>1?'s':'')+' found in the Certificate Transparency log for <strong>'+esc(PUBLIC_DOMAIN)+'</strong> resolve to NXDOMAIN — they were certificated once but no longer exist in DNS.';
    list.innerHTML='<div style="color:var(--muted);font-size:.68rem;padding:8px 10px;font-family:var(--font-mono)">No live subdomains to probe.</div>';
    addEvent('warn','Subdomain Sweep Done','0 live subdomains · '+retired+' retired CT host'+(retired>1?'s':'')+' skipped');
    return;
  }

  badge.className='badge info';badge.textContent='PROBING '+probed.length+'…';
  titleEl.textContent='Probing '+probed.length+' live subdomain'+(probed.length>1?'s':'')+'…';titleEl.style.color='var(--info)';
  list.innerHTML='<div style="color:var(--muted);font-size:.68rem;padding:8px 10px;font-family:var(--font-mono)"><span class="spinner"></span> Sweeping '+probed.length+' subdomains…</div>';

  const results=await Promise.all(probed.map(async h=>{
    const r=await probeOne('https://'+h,6000);
    return Object.assign({host:h},DISCOVERED_SUBS[h],r);
  }));

  let up=0;
  const maxMs=Math.max(1,...results.map(r=>r.ms||0));
  const rows=results.map(r=>{
    const latPct=Math.max(6,Math.min(100,Math.round((r.ms/maxMs)*100)));
    const tag=r.host===PUBLIC_DOMAIN?'APEX':(r.host.split('.')[0]||'SUB').slice(0,4).toUpperCase();
    let cert='';
    if(r.daysLeft!=null){
      const cc=r.daysLeft>20?'ok':r.daysLeft>0?'warn':'crit';
      cert=' &middot; <span style="color:var(--'+cc+')">cert '+r.daysLeft+'d</span>';
    }
    if(r.ok){
      up++;
      const slow=r.ms>1500;
      return intranetRow(tag,r.host,r.ms+' ms'+cert,slow?'warn':'ok',slow?'SLOW':'REACHABLE',latPct);
    }
    return intranetRow(tag,r.host,(r.why==='timeout'?'timed out (6s)':'no response')+cert,'crit',r.why==='timeout'?'TIMEOUT':'DOWN',latPct);
  }).join('');
  list.innerHTML=rows;
  animateBars('#subdomain-list .lat i','width');

  const capped=total>candidates.length;
  const cls=up===probed.length?'ok':(up===0?'crit':'warn');
  setCard('subs',cls,up+'/'+probed.length,up+' reachable'+(retired?' · '+retired+' retired':'')+(capped?' · '+candidates.length+' probed':''),{pct:Math.round((up/probed.length)*100)});
  badge.className='badge '+cls;badge.textContent=up+'/'+probed.length+' UP';
  titleEl.textContent=up+' / '+probed.length+' live subdomains reachable'+(total>probed.length?' ('+total+' in CT log)':'');
  titleEl.style.color='var(--'+cls+')';
  noteEl.innerHTML='Auto-enumerated from the Certificate Transparency log for <strong>'+esc(PUBLIC_DOMAIN)+'</strong> and probed live from your browser. '+(retired?'<strong>'+retired+'</strong> stale CT hostname'+(retired>1?'s that no longer resolve were':' that no longer resolves was')+' excluded. ':'')+(capped?'Showing the first '+candidates.length+' of '+total+' (capped for performance). ':'')+'Reachability is opaque cross-origin; cert days come from CT.';
  addEvent(cls,'Subdomain Sweep Done',up+' of '+probed.length+' live subdomains reachable'+(retired?' · '+retired+' retired host'+(retired>1?'s':'')+' skipped':'')+' ('+total+' in CT log)');
}

/* ============================================================
   Orchestration
   ============================================================ */
async function runAllChecks(opts){
  const force=!!(opts&&opts.force);   /* manual user-triggered refresh bypasses the cache */
  const btn=document.getElementById('refresh-btn');
  const scanBtn=document.getElementById('scan-btn');
  const pub=document.getElementById('public-url').value.trim();
  if(!pub){alert('Please enter a Public Surface URL');return;}
  if(scanning)return;            /* a run is already in flight — let it finish */
  scanning=true;
  lastRefresh=Date.now();
  PUBLIC_DOMAIN=hostFromUrl(pub);
  document.getElementById('public-domain-label').textContent=PUBLIC_DOMAIN;

  /* keep the manual-verify links pointed at the current target */
  const l1=document.getElementById('sh-link1'),l2=document.getElementById('sh-link2'),cu=document.getElementById('sh-curl');
  if(l1)l1.href='https://securityheaders.com/?q=https://'+PUBLIC_DOMAIN+'&followRedirects=on';
  if(l2)l2.href='https://observatory.mozilla.org/analyze/'+PUBLIC_DOMAIN;
  if(cu)cu.textContent='curl -I https://'+PUBLIC_DOMAIN;

  btn.disabled=true;btn.innerHTML='<span class="ico">&#x21BB;</span>Scanning…';
  if(scanBtn){scanBtn.disabled=true;scanBtn.innerHTML='<span class="ico">&#x25B6;</span>Scanning…';}

  ['ssl','dns','certs','issuer','mx','subs'].forEach(id=>setCard(id,'loading','…','Checking…'));
  setCard('intranet','loading','…','Probing…');
  document.getElementById('event-feed').innerHTML='';
  addEvent('info','Scan Started','Live checks on '+PUBLIC_DOMAIN+' via crt.sh + Google DoH (100% free, no API key)');

  /* crt.sh must finish first — it populates the subdomain list the sweep probes. */
  await Promise.all([checkSSLandCT(force),checkDNS(force),checkIntranet()]);
  await checkSubdomains();

  addEvent('ok','Scan Complete','Public surface, '+Object.keys(DISCOVERED_SUBS).length+' subdomains, and intranet probe done. Connect the agent for live internal events.');
  btn.disabled=false;btn.innerHTML='<span class="ico">&#x21BB;</span>Refresh';
  if(scanBtn){scanBtn.disabled=false;scanBtn.innerHTML='<span class="ico">&#x25B6;</span>Run Scan';}
  scanning=false;
}

/* ============================================================
   Agent webhook (live polling) — unchanged contract
   ============================================================ */
let webhookInterval=null;
let seenEventKeys=new Set();
let autoConnectTimer=null;       /* background watcher that connects the moment an agent appears */
let userDisconnected=false;      /* set when the user clicks Stop, so we don't auto-reconnect over them */

/* Where to remember a known-good agent endpoint across visits. */
const AGENT_STORE_KEY='vigil.agentUrl';

/* Candidate endpoints we try with zero user input, in priority order:
   1) a remembered endpoint from a previous successful connection,
   2) a local agent on the conventional port (same-machine / localhost case). */
function agentCandidates(){
  const list=[];
  let saved=null;
  try{saved=localStorage.getItem(AGENT_STORE_KEY);}catch(_){}
  if(saved&&/^https?:\/\//i.test(saved))list.push(saved);
  /* The agent listens on :8787 and serves /events with CORS enabled. */
  ['http://localhost:8787/events','http://127.0.0.1:8787/events'].forEach(u=>{
    if(list.indexOf(u)<0)list.push(u);
  });
  return list;
}

function rememberAgent(url){try{localStorage.setItem(AGENT_STORE_KEY,url);}catch(_){}}
function forgetAgent(){try{localStorage.removeItem(AGENT_STORE_KEY);}catch(_){}}

/* Probe a single candidate /events URL. Resolves to the URL if it answers
   with valid JSON, else null. Kept short-timeout so the sweep stays snappy. */
async function tryAgent(url){
  try{
    const ctrl=new AbortController();
    const t=setTimeout(()=>ctrl.abort(),2500);
    const r=await fetch(url,{cache:'no-store',signal:ctrl.signal});
    clearTimeout(t);
    if(!r.ok)return null;
    await r.json();           /* must be valid JSON to count as a real agent */
    return url;
  }catch(_){return null;}
}

/* Fully automated connect: discover an agent from the candidate list and
   connect to the first that responds — no typing, no button required. */
async function autoConnectAgent(){
  if(agentConnected||userDisconnected)return;
  const cands=agentCandidates();
  for(const url of cands){
    const found=await tryAgent(url);
    if(found){
      const box=document.getElementById('webhook-url');
      if(box)box.value=found;
      connectWebhook(found);
      return;
    }
  }
}

/* Background watcher: keep looking for an agent until one connects, so the
   user never has to do anything even if they open the agent afterwards. */
function startAutoConnectWatch(){
  if(autoConnectTimer)clearInterval(autoConnectTimer);
  autoConnectAgent();
  autoConnectTimer=setInterval(()=>{
    if(agentConnected||userDisconnected){clearInterval(autoConnectTimer);autoConnectTimer=null;return;}
    autoConnectAgent();
  },15000);
}

function tagForService(name){
  const m=intranetServices.find(s=>s.name===name);
  return m?m.tag:makeTag(name);
}

function renderAgentStatus(s){
  if(!s||typeof s!=='object'||!Array.isArray(s.services))return false;   /* defensive: malformed /status payload */
  const probe=document.getElementById('intranet-probe');
  const titleEl=document.getElementById('intranet-probe-title');
  const noteEl=document.getElementById('intranet-probe-note');
  let healthy=0;const total=s.services.length;
  const cats=['ok','info','warn','crit'];
  const maxLat=Math.max(1,...s.services.map(x=>parseInt(x.latency_ms,10)||0));
  const rows=s.services.map(svc=>{
    const cat=cats.indexOf(svc.category)>=0?svc.category:'info';
    if(cat==='ok')healthy++;
    const flags=Array.isArray(svc.flags)?svc.flags:[];
    let sub=esc(String(svc.url||svc.name||'').replace(/^https?:\/\//i,''));
    let latPct=null;
    if(svc.latency_ms!=null){const ms=parseInt(svc.latency_ms,10)||0;sub+=' &middot; '+ms+' ms';latPct=Math.max(6,Math.round((ms/maxLat)*100));}
    if(flags.length)sub+=' &middot; <span style="color:var(--crit)">'+flags.map(esc).join('; ')+'</span>';
    let label=esc(svc.code?(''+svc.code):'DOWN');
    let cls=cat;
    if(flags.length){label='&#x26A0; '+label;cls='crit';}
    return intranetRow(tagForService(svc.name),svc.name,sub,cls,label,latPct);
  }).join('');
  probe.innerHTML=rows;
  animateBars('#intranet-probe .lat i','width');
  const alerts=Array.isArray(s.alerts)?s.alerts:[];
  const cls=alerts.length?'crit':(healthy===total?'ok':'warn');
  titleEl.textContent='Agent live · '+healthy+'/'+total+' healthy'+(alerts.length?' · '+alerts.length+' alert(s)':'');
  titleEl.style.color='var(--'+cls+')';
  if(alerts.length){
    noteEl.innerHTML='<strong style="color:var(--crit)">&#x26A0; '+alerts.length+' active flag(s):</strong> '+alerts.map(esc).join(' &middot; ');
  }else{
    noteEl.innerHTML='Live HTTP status codes &amp; latency from the connected agent. No anomalies flagged.';
  }
  setCard('intranet',cls,healthy+'/'+total,alerts.length?alerts.length+' alert(s)':healthy+' healthy',{pct:Math.round((healthy/total)*100)});
  return true;
}

function setConnStatus(msg,color){
  const el=document.getElementById('agent-conn-status');
  if(el){el.innerHTML=msg;el.style.color=color||'var(--muted)';}
}
function setAgentBadge(cls,text){
  const b=document.getElementById('agent-badge');
  b.className='badge '+cls;b.textContent=text;
}

function disconnectWebhook(){
  if(webhookInterval){clearInterval(webhookInterval);webhookInterval=null;}
  if(autoConnectTimer){clearInterval(autoConnectTimer);autoConnectTimer=null;}
  agentConnected=false;
  userDisconnected=true;     /* explicit user action — stop auto-reconnecting */
  forgetAgent();             /* and don't silently reconnect to it next visit */
  document.getElementById('agent-connect-btn').style.display='';
  document.getElementById('agent-disconnect-btn').style.display='none';
  const radar=document.getElementById('probe-radar');if(radar)radar.classList.remove('live');
  setAgentBadge('warn','AGENT DISCONNECTED');
  setConnStatus('Stopped polling. The live browser probe above is still active.','var(--warn)');
  addEvent('info','Agent Disconnected','Stopped polling the agent endpoint.');
}

/* connectWebhook(url?) — url is optional; when omitted it falls back to the
   input box. Auto-connect passes the discovered URL directly. */
function connectWebhook(url){
  userDisconnected=false;    /* a (re)connect attempt re-enables auto-reconnect */
  if(typeof url!=='string'||!url){url=document.getElementById('webhook-url').value.trim();}
  if(!url){setConnStatus('Enter the agent <code>/events</code> URL first.','var(--warn)');return;}
  if(!/^https?:\/\//i.test(url)){setConnStatus('URL must start with http:// or https://','var(--warn)');return;}
  document.getElementById('agent-connect-btn').style.display='none';
  document.getElementById('agent-disconnect-btn').style.display='';
  setAgentBadge('info','CONNECTING…');
  setConnStatus('Connecting to '+esc(url)+' …');
  addEvent('info','Agent Connecting','Polling '+esc(url)+' every 10s for intranet events…');
  if(webhookInterval)clearInterval(webhookInterval);
  seenEventKeys=new Set();
  const statusUrl=/\/events(\?|$)/.test(url)?url.replace(/\/events(\?|$)/,'/status$1'):null;
  const configUrl=/\/events(\?|$)/.test(url)?url.replace(/\/events(\?|$)/,'/config$1'):null;
  let configSynced=false;

  /* Circuit breaker: stop polling after this many consecutive failures so a
     dead agent doesn't generate endless failed requests + feed noise. */
  const MAX_CONSEC_FAILURES=5;
  let consecFailures=0;
  function pollFailed(){
    consecFailures++;
    if(consecFailures>=MAX_CONSEC_FAILURES&&webhookInterval){
      clearInterval(webhookInterval);webhookInterval=null;
      setAgentBadge('crit','AGENT OFFLINE');
      setConnStatus('Stopped polling after '+consecFailures+' consecutive failures. Click Connect to retry.','var(--crit)');
      addEvent('crit','Agent Polling Stopped',consecFailures+' consecutive failures — circuit breaker opened. Reconnect to retry.');
    }
  }

  async function poll(){
    let r;
    try{r=await fetch(url,{cache:'no-store'});}
    catch(err){
      agentConnected=false;
      setAgentBadge('crit','UNREACHABLE');
      setConnStatus('Cannot reach endpoint (network or CORS). Check the agent is running and the URL is publicly reachable.','var(--crit)');
      addEvent('crit','Agent Unreachable','Could not reach '+esc(url)+' — verify the tunnel/agent and that CORS is allowed.');
      pollFailed();
      return;
    }
    if(!r.ok){
      agentConnected=false;
      setAgentBadge('crit','HTTP '+r.status);
      setConnStatus('Endpoint returned HTTP '+r.status+'.','var(--crit)');
      addEvent('crit','Agent HTTP Error',esc(url)+' returned HTTP '+r.status);
      pollFailed();
      return;
    }
    let data;
    try{data=await r.json();}
    catch(_){
      agentConnected=false;
      setAgentBadge('crit','BAD JSON');
      setConnStatus('Response was not valid JSON. Expected an array of {type,title,message}.','var(--crit)');
      addEvent('crit','Agent Bad Response',esc(url)+' did not return JSON.');
      pollFailed();
      return;
    }
    consecFailures=0;   /* success — reset the breaker */
    const events=Array.isArray(data)?data:[data];
    let added=0;
    events.forEach(e=>{
      if(!e||typeof e!=='object')return;
      const key=(e.ts||'')+'|'+(e.time||'')+'|'+(e.title||'')+'|'+(e.message||'');
      if(seenEventKeys.has(key))return;
      seenEventKeys.add(key);
      const ty=['ok','info','warn','crit'].indexOf(e.type)>=0?e.type:'info';
      addEvent(ty,esc(e.title||'Intranet Event'),esc(e.message||JSON.stringify(e)));
      added++;
    });
    agentConnected=true;
    rememberAgent(url);       /* persist so we silently reconnect next visit */
    if(configUrl&&!configSynced){configSynced=true;fetchAgentServices(configUrl);}
    if(autoConnectTimer){clearInterval(autoConnectTimer);autoConnectTimer=null;}
    const radar=document.getElementById('probe-radar');if(radar)radar.classList.add('live');
    setAgentBadge('ok','AGENT CONNECTED');
    setConnStatus('Connected · '+events.length+' in buffer · '+added+' new · last poll '+new Date().toLocaleTimeString(),'var(--ok)');

    if(statusUrl){
      try{
        const sr=await fetch(statusUrl,{cache:'no-store'});
        if(sr.ok){
          const s=await sr.json();
          /* schema check: must be a plain object with a services array */
          if(s&&typeof s==='object'&&!Array.isArray(s)&&Array.isArray(s.services)){
            renderAgentStatus(s);
          }
        }
      }
      catch(_){/* status endpoint optional */}
    }
  }
  poll();
  webhookInterval=setInterval(poll,10000);
}

/* ---------- boot ---------- */
window.addEventListener('load',()=>{
  setTimeout(runAllChecks,500);

  /* Keep the public surface data live rather than a one-shot snapshot:
     re-run the full scan on an interval. Skips while the tab is hidden
     (no point hammering crt.sh in the background) and the scanning guard
     ensures a re-scan never overlaps an in-flight one. The intranet agent
     feed already polls every 10s on its own. */
  const AUTO_REFRESH_MS=60000;
  if(autoRefreshTimer)clearInterval(autoRefreshTimer);
  autoRefreshTimer=setInterval(()=>{
    if(document.hidden)return;
    if(Date.now()-lastRefresh<60000)return;   /* dedup: a refresh ran within the last 60s */
    runAllChecks();
  },AUTO_REFRESH_MS);
  /* refresh promptly when returning to a tab that was hidden */
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden)runAllChecks();
  });
  /* ---- fully automated agent connect (no user input required) ----
     Priority:
       1) an ?agent= link (one-click installer reopens the dashboard this way),
       2) a remembered endpoint from a previous successful connection,
       3) auto-discovery of a local agent on the conventional port.
     The background watcher keeps trying until one connects, so the user
     never has to type or click anything. */
  let agent=new URLSearchParams(location.search).get('agent');
  if(!agent){const m=location.hash.match(/agent=([^&]+)/);if(m)agent=m[1];}
  if(agent){
    try{agent=decodeURIComponent(agent);}catch(_){}
    if(/^https?:\/\//i.test(agent)){
      const box=document.getElementById('webhook-url');
      if(box)box.value=agent;
      rememberAgent(agent);
      setConnStatus('Auto-connecting to agent from link…');
      setTimeout(()=>connectWebhook(agent),900);
      return;
    }
  }
  /* No link — try to discover/reconnect silently in the background. */
  setConnStatus('Looking for an intranet agent automatically…');
  setTimeout(startAutoConnectWatch,900);
  /* Reconnect quickly when returning to the tab if we lost the agent. */
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden&&!agentConnected&&!userDisconnected)startAutoConnectWatch();
  });
});
