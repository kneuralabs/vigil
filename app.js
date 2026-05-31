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
let agentConnected=false;
let scanning=false;          /* re-entrancy guard so auto-refresh never overlaps a run */
let autoRefreshTimer=null;   /* periodic re-scan keeps the public data live, not a snapshot */

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
async function checkSSLandCT(){
  try{
    addEvent('info','SSL &amp; CT Scan','Querying crt.sh for '+PUBLIC_DOMAIN+'…');
    const r=await fetch('https://crt.sh/?q='+encodeURIComponent(PUBLIC_DOMAIN)+'&output=json');
    if(!r.ok)throw new Error('crt.sh HTTP '+r.status);
    const data=await r.json();
    if(!data||!data.length){setCard('ssl','warn','None','No certs in CT log');return;}

    const sorted=data.slice().sort((a,b)=>new Date(b.not_after)-new Date(a.not_after));
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
    addEvent('crit','SSL Check Failed',e.message);
    document.getElementById('ssl-details').innerHTML='<div class="cors-note">Error: '+esc(e.message)+'</div>';
    document.getElementById('crt-details').innerHTML='<div class="cors-note">Could not reach crt.sh</div>';
  }
}

/* ============================================================
   DNS — live Google DoH
   ============================================================ */
async function checkDNS(){
  const types=[{t:'A',code:1},{t:'AAAA',code:28},{t:'MX',code:15},{t:'NS',code:2},{t:'TXT',code:16},{t:'CAA',code:257}];
  const rows=[];
  let hasMX=false;
  try{
    addEvent('info','DNS Probe','Google DoH resolving '+PUBLIC_DOMAIN+' records…');
    for(const {t,code} of types){
      try{
        const r=await fetch('https://dns.google/resolve?name='+encodeURIComponent(PUBLIC_DOMAIN)+'&type='+code);
        const d=await r.json();
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
async function checkIntranet(){
  if(agentConnected){
    addEvent('info','Intranet','Agent connected — rows reflect live HTTP status from the /status feed.');
    return;
  }
  const probe=document.getElementById('intranet-probe');
  const raw=document.getElementById('intranet-url-input').value.trim();
  const titleEl=document.getElementById('intranet-probe-title');
  const noteEl=document.getElementById('intranet-probe-note');
  const badge=document.getElementById('agent-badge');
  const radar=document.getElementById('probe-radar');
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

  titleEl.textContent='Probing '+INTRANET_SERVICES.length+' services…';titleEl.style.color='var(--info)';
  if(radar)radar.classList.add('live');
  noteEl.innerHTML='Running live reachability probes against <strong>'+esc(host)+'</strong> endpoints from your browser…';
  probe.innerHTML='<div style="color:var(--muted);font-size:.68rem;padding:8px 10px;font-family:var(--font-mono)"><span class="spinner"></span> Sweeping '+INTRANET_SERVICES.length+' endpoints…</div>';
  if(!agentConnected){badge.className='badge info';badge.textContent='SCANNING…';}
  addEvent('info','Intranet Sweep','Probing '+INTRANET_SERVICES.length+' '+host+' endpoints from your browser…');

  const results=await Promise.all(INTRANET_SERVICES.map(async svc=>{
    const url=base+svc.path;
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
   Orchestration
   ============================================================ */
async function runAllChecks(){
  const btn=document.getElementById('refresh-btn');
  const scanBtn=document.getElementById('scan-btn');
  const pub=document.getElementById('public-url').value.trim();
  if(!pub){alert('Please enter a Public Surface URL');return;}
  if(scanning)return;            /* a run is already in flight — let it finish */
  scanning=true;
  PUBLIC_DOMAIN=hostFromUrl(pub);
  document.getElementById('public-domain-label').textContent=PUBLIC_DOMAIN;

  /* keep the manual-verify links pointed at the current target */
  const l1=document.getElementById('sh-link1'),l2=document.getElementById('sh-link2'),cu=document.getElementById('sh-curl');
  if(l1)l1.href='https://securityheaders.com/?q=https://'+PUBLIC_DOMAIN+'&followRedirects=on';
  if(l2)l2.href='https://observatory.mozilla.org/analyze/'+PUBLIC_DOMAIN;
  if(cu)cu.textContent='curl -I https://'+PUBLIC_DOMAIN;

  btn.disabled=true;btn.innerHTML='<span class="ico">&#x21BB;</span>Scanning…';
  if(scanBtn){scanBtn.disabled=true;scanBtn.innerHTML='<span class="ico">&#x25B6;</span>Scanning…';}

  ['ssl','dns','certs','issuer','mx'].forEach(id=>setCard(id,'loading','…','Checking…'));
  setCard('intranet','loading','…','Probing…');
  document.getElementById('event-feed').innerHTML='';
  addEvent('info','Scan Started','Live checks on '+PUBLIC_DOMAIN+' via crt.sh + Google DoH (100% free, no API key)');

  await Promise.all([checkSSLandCT(),checkDNS(),checkIntranet()]);

  addEvent('ok','Scan Complete','Public APIs + intranet probe done. Connect the agent for live internal events.');
  btn.disabled=false;btn.innerHTML='<span class="ico">&#x21BB;</span>Refresh';
  if(scanBtn){scanBtn.disabled=false;scanBtn.innerHTML='<span class="ico">&#x25B6;</span>Run Scan';}
  scanning=false;
}

/* ============================================================
   Agent webhook (live polling) — unchanged contract
   ============================================================ */
let webhookInterval=null;
let seenEventKeys=new Set();

function tagForService(name){
  const m=INTRANET_SERVICES.find(s=>s.name===name);
  return m?m.tag:'SVC';
}

function renderAgentStatus(s){
  if(!s||!Array.isArray(s.services))return false;
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
  agentConnected=false;
  document.getElementById('agent-connect-btn').style.display='';
  document.getElementById('agent-disconnect-btn').style.display='none';
  const radar=document.getElementById('probe-radar');if(radar)radar.classList.remove('live');
  setAgentBadge('warn','AGENT DISCONNECTED');
  setConnStatus('Stopped polling. The live browser probe above is still active.','var(--warn)');
  addEvent('info','Agent Disconnected','Stopped polling the agent endpoint.');
}

function connectWebhook(){
  const url=document.getElementById('webhook-url').value.trim();
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

  async function poll(){
    let r;
    try{r=await fetch(url,{cache:'no-store'});}
    catch(err){
      agentConnected=false;
      setAgentBadge('crit','UNREACHABLE');
      setConnStatus('Cannot reach endpoint (network or CORS). Check the agent is running and the URL is publicly reachable.','var(--crit)');
      addEvent('crit','Agent Unreachable','Could not reach '+esc(url)+' — verify the tunnel/agent and that CORS is allowed.');
      return;
    }
    if(!r.ok){
      agentConnected=false;
      setAgentBadge('crit','HTTP '+r.status);
      setConnStatus('Endpoint returned HTTP '+r.status+'.','var(--crit)');
      addEvent('crit','Agent HTTP Error',esc(url)+' returned HTTP '+r.status);
      return;
    }
    let data;
    try{data=await r.json();}
    catch(_){
      agentConnected=false;
      setAgentBadge('crit','BAD JSON');
      setConnStatus('Response was not valid JSON. Expected an array of {type,title,message}.','var(--crit)');
      addEvent('crit','Agent Bad Response',esc(url)+' did not return JSON.');
      return;
    }
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
    const radar=document.getElementById('probe-radar');if(radar)radar.classList.add('live');
    setAgentBadge('ok','AGENT CONNECTED');
    setConnStatus('Connected · '+events.length+' in buffer · '+added+' new · last poll '+new Date().toLocaleTimeString(),'var(--ok)');

    if(statusUrl){
      try{const sr=await fetch(statusUrl,{cache:'no-store'});if(sr.ok){renderAgentStatus(await sr.json());}}
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
    runAllChecks();
  },AUTO_REFRESH_MS);
  /* refresh promptly when returning to a tab that was hidden */
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden)runAllChecks();
  });
  let agent=new URLSearchParams(location.search).get('agent');
  if(!agent){const m=location.hash.match(/agent=([^&]+)/);if(m)agent=m[1];}
  if(agent){
    try{agent=decodeURIComponent(agent);}catch(_){}
    if(/^https?:\/\//i.test(agent)){
      const box=document.getElementById('webhook-url');
      if(box)box.value=agent;
      setConnStatus('Auto-connecting to agent from link…');
      setTimeout(connectWebhook,900);
    }
  }
});
