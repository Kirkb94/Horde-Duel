// ================= ONLINE MULTIPLAYER (host-relay) =================
// The room creator's browser runs the whole simulation. Everyone else sends inputs and receives
// filtered snapshots + events through the relay server. Solo play never touches any of this (NET.m === null).
const NET={ws:null,role:null,m:null,live:false,pid:0,hostPid:0,code:'',players:[],name:'',notice:'',status:'',view:'',
  inp:{},ready:{},cl:{},my:0,rtt:0,ev:[],evBase:0,lastSend:0,lastIn:0,acts:[],resDn:-1,pk:0,tot:0,picks:[],zm:new Map(),
  cfg:{mode:'br',size:16,map:'random'},lastSnap:0,gotSnap:false,lag:.05,pts:null,betT:0,paused:false,keyR:0,hpPrev:0,hurtT:0,waitEl:null};
try{NET.name=localStorage.getItem('hordename')||''}catch(e){}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const FK=['x','y','facing','hp','armor','vx','vy','dashT','jumpT','jx','jy','jtx','jty','jumpMax','swingT','swingSide','muzzle','reloadT','rdT','shield','shieldDir','shieldMax','cloakT','healT','healMax','burnT','slowT','markT','hitFlash','parryT','swordOut','defl','inv','stillT','shF','hurtT','healKind','down','downT','revP','finP','tagT','tagBy','zoom','litT','fenceT','fenceN','scanWarn'];
const XK=['level','xp','kills','dropKills','wins','pts','zk','ammo','abCD','abCh','abChT','mines','mineT','band','kit','dashCD','hurtA','place','pend','slowAmt','dashSp','dashDir'];
const ZKS=['walker','brute','sprinter','hunter','runner','boss'];
const ITM=[undefined,'band','kit','armor'];
const MODEC={count:1,play:2,ending:3},MODEN=[null,'count','play','ending'];
const q2=v=>Math.round(v*100)/100;
const fById=id=>id==null?null:(id<N_FIGHT?G.fighters[id]:NET.zm.get(id))||null;
const SIM=window.__SIM||null;   // set when the simulation runs inside the server (server-authoritative mode)
const netSend=o=>{if(NET.ws&&NET.ws.readyState===1)NET.ws.send(JSON.stringify(o))};
const netRel=(to,d)=>{if(SIM){SIM.rel(to,d);return}netSend({t:'r',to,d})};
function netFixSrv(v){
  v=String(v||'').trim();if(!v)return'';
  if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(v))v=(location.protocol==='http:'?'ws://':'wss://')+v;
  v=v.replace(/^http:\/\//i,'ws://').replace(/^https:\/\//i,'wss://');
  try{
    const x=new URL(v);
    if(x.protocol!=='ws:'&&x.protocol!=='wss:')return'';
    if(location.protocol==='https:'&&x.protocol==='ws:'&&!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(x.hostname))x.protocol='wss:';
    if(x.pathname===''||x.pathname==='/')x.pathname='/ws';
    return x.toString();
  }catch(e){return''}
}
function netUrl(){let u='';try{u=localStorage.getItem('hordeserver')||''}catch(e){}
  u=netFixSrv(u);
  if(u)return u;
  if(location.protocol==='http:'||location.protocol==='https:')return(location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws';
  return'ws://localhost:3000/ws';}

// ---------- connection ----------
function netConnect(then){
  if(NET.ws&&NET.ws.readyState===1){then();return}
  if(NET.ws&&NET.ws.readyState===0)return;
  if(NET.wake)return;
  NET.status='Connecting…';netMenu();
  NET.wake={t0:Date.now(),n:0,tm:0,iv:setInterval(netWakeTick,500),then};
  netWakeTry();
}
// Cold start: Render's free plan sleeps when idle. Retry + ping /healthz until it is up, with a waiting screen.
function netWakeStop(){const W=NET.wake;if(W){clearTimeout(W.tm);clearInterval(W.iv);NET.wake=null}}
function netWakeShow(){
  NET.view='wake';G.mode='menu';G.P=null;showHUD(false);
  show(`<p class='eyebrow'>Server asleep</p><h1>Waking the <em>server</em></h1><p class='lede'>The free server naps when nobody is playing. It is starting up now, which usually takes 30 to 60 seconds. You will connect automatically.</p><p class='lede'>Waiting: <b id='wkT'>0</b>s</p><button class='go ghost' data-act='n_leave'>Cancel</button>`);
}
function netWakeTick(){
  const W=NET.wake;if(!W)return;
  const s=Math.floor((Date.now()-W.t0)/1000);
  if(NET.view==='wake'){const e=$('#wkT');if(e)e.textContent=s}
  else if(s>=3&&NET.view==='menu')netWakeShow();
}
function netWakeFail(msg){
  netWakeStop();
  if(NET.ws){try{NET.ws.onclose=null;NET.ws.close()}catch(_){}NET.ws=null}
  NET.status='';NET.notice=msg;netMenu();
}
function netWakeTry(){
  const W=NET.wake;if(!W)return;
  if(Date.now()-W.t0>90000){netWakeFail('The server did not wake up in time. Try again in a minute.');return}
  W.n++;
  try{fetch(netUrl().replace(/^ws/,'http').replace(/\/ws\/?$/,'')+'/healthz',{mode:'no-cors',cache:'no-store'}).catch(()=>{})}catch(e){}
  let ws;try{ws=new WebSocket(netUrl())}catch(e){netWakeFail('That server address is not valid.');return}
  NET.ws=ws;const to=setTimeout(()=>{if(ws.readyState===0){try{ws.close()}catch(_){}}},8000);
  ws.onopen=()=>{clearTimeout(to);NET.rx=Date.now();NET.status='';const f=W.then;netWakeStop();f()};
  ws.onmessage=e=>{NET.rx=Date.now();let m;try{m=JSON.parse(e.data)}catch(_){return}netMsg(m)};
  ws.onclose=()=>{clearTimeout(to);if(NET.ws!==ws)return;NET.ws=null;if(NET.wake===W)W.tm=setTimeout(netWakeTry,W.n<3?1500:3000);else netDropped(NET.status||NET.code||NET.live?'Lost connection to the server.':'Could not reach the server. Check the address under Server.')};
  ws.onerror=()=>{};
}
setInterval(()=>{
  if(NET.ws&&NET.ws.readyState===1){
    if(!document.hidden&&!NET.chk){
      if(Date.now()-(NET.rx||0)>8000){netDropped('Lost connection to the server (timed out).');return}
      // server-authoritative: pongs still arrive but snapshots stopped. Only count time spent in play/count.
      if(NET.auth&&NET.live&&NET.gotSnap&&(G.mode==='play'||G.mode==='count')){
        if(!NET.modeSince)NET.modeSince=performance.now();
        if(performance.now()-NET.modeSince>6000&&performance.now()-NET.lastSnap>6000){NET.modeSince=0;netDropped('Lost connection to the server (no game updates).');return}
      }else NET.modeSince=0;
    }
    netPingSent()
  }
},2000);
// Force an immediate token rejoin (auth mode) after tab sleep / network switch. Server answers with a full resync.
let netHidAt=0,netForceAt=0;
function netForceRejoin(why){
  const t=Date.now();if(t-netForceAt<1500)return false;
  if(SIM||NET.wake||!NET.auth||!(NET.live||NET.code))return false;
  const s=netSess();if(!s||s.rel)return false;
  netForceAt=t;
  if(NET.reco){const R=NET.reco;clearTimeout(R.tm);if(!NET.ws||NET.ws.readyState!==1){if(NET.ws){try{NET.ws.onclose=null;NET.ws.close()}catch(_){}NET.ws=null}netRecoTry()}return true}
  if(NET.ws){try{NET.ws.onclose=null;NET.ws.close()}catch(_){}NET.ws=null}
  NET.reco={t0:t,n:0,tm:0,keep:1};NET.status='';NET.rx=t;netRecoTry();return true;
}
addEventListener('online',()=>netForceRejoin('online'));
addEventListener('pageshow',e=>{if(e.persisted)netForceRejoin('pageshow')});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){netHidAt=Date.now();return}
  const ws=NET.ws,t=Date.now();
  const slept=netHidAt&&t-netHidAt>2500;netHidAt=0;
  if(slept||!ws||ws.readyState!==1){if(netForceRejoin('visible'))return}
  if(NET.reco||NET.wake){NET.rx=t;return}
  if(ws&&ws.readyState>=2){netDropped('Lost connection to the server.');return}
  if(ws&&ws.readyState===1&&t-(NET.rx||0)>4000){
    NET.chk=t;netSend({t:'ping',ts:t});
    setTimeout(()=>{NET.chk=0;if(NET.ws===ws&&(NET.rx||0)<t)netDropped('Lost connection to the server (timed out).')},3000);
    return}
  NET.rx=t;
});
function netCleanup(){NET.live=false;NET.m=null;NET.paused=false;NET.zm.clear();NET.inp={};NET.cl={};NET.ready={};NET.acts=[];G.fighters=[];G.P=null;G.bullets=[];G.deploys=[];G.orbs=[];G.fx=[];G.spectating=false;G.pOut=false;G.mode='menu';showHUD(false)}
// ---------- session token + auto-reconnect (auth mode) ----------
const REJOIN_MS=28000;   // stay under the server's 30s slot hold
function netSess(){try{const s=JSON.parse(sessionStorage.getItem('hordesess')||'null');return s&&/^[A-Z]{4}$/.test(s.code)&&/^[0-9a-f]{32}$/.test(s.token)?s:null}catch(e){return null}}
function netSessSave(m){try{if(m.token&&(m.auth||m.pid===m.host))sessionStorage.setItem('hordesess',JSON.stringify({code:m.code,token:m.token,rel:m.auth?0:1}));else sessionStorage.removeItem('hordesess')}catch(e){}}
function netSessClear(){try{sessionStorage.removeItem('hordesess')}catch(e){}}
function netResume(){if(SIM||NET.reco||NET.ws)return;const s=netSess();if(!s)return;if(s.rel){netSessClear();return}NET.auth=true;NET.reco={t0:Date.now(),n:0,tm:0};netRecoTry()}
function netBanner(n){
  let b=document.getElementById('netBanner');
  if(n<0){if(b)b.style.display='none';return}
  if(!b){b=document.createElement('div');b.id='netBanner';b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:99999;padding:8px 12px;text-align:center;font:700 14px system-ui,sans-serif;background:#c0392b;color:#fff;pointer-events:none';document.body.appendChild(b)}
  b.textContent='Reconnecting… attempt '+(n+1);b.style.display='block';
}
function netRecoStop(){netBanner(-1);if(NET.reco){clearTimeout(NET.reco.tm);NET.reco=null}}
function netRecoShow(){NET.view='reco';G.mode='menu';show(`<p class='eyebrow'>Connection lost</p><h1>Reconnecting<em>…</em></h1><p class='lede'>Trying to get you back into your match${NET.reco&&NET.reco.n?' (attempt '+(NET.reco.n+1)+')':''}. A bot plays your fighter meanwhile.</p><button class='go ghost' data-act='n_leave'>Give up</button>`)}
function netRecoFail(msg){netRecoStop();netSessClear();if(NET.ws){try{NET.ws.onclose=null;NET.ws.close()}catch(_){}NET.ws=null}NET.code='';NET.role=null;NET.players=[];netCleanup();NET.notice=msg||'Could not reconnect to the match.';netMenu()}
function netRecoNext(){
  const R=NET.reco;if(!R)return;
  R.n++;const cap=Math.min(4000,500*Math.pow(2,R.n-1)),d=Math.round(cap/2+Math.random()*cap/2);
  if(Date.now()-R.t0+d>REJOIN_MS){netRecoFail('Could not reconnect to the match.');return}
  clearTimeout(R.tm);R.tm=setTimeout(netRecoTry,d);
}
function netRecoTry(){
  const R=NET.reco;if(!R)return;
  if(Date.now()-R.t0>REJOIN_MS){netRecoFail('Could not reconnect to the match.');return}
  netBanner(R.n);if(!R.keep)netRecoShow();
  let ws;try{ws=new WebSocket(netUrl())}catch(e){netRecoNext();return}
  NET.ws=ws;const to=setTimeout(()=>{try{ws.close()}catch(_){}},6000);
  ws.onopen=()=>{clearTimeout(to);NET.rx=Date.now();const s=netSess();if(!s){netRecoFail('Could not reconnect to the match.');return}netSend({t:'rejoin',code:s.code,token:s.token})};
  ws.onmessage=e=>{NET.rx=Date.now();let m;try{m=JSON.parse(e.data)}catch(_){return}netMsg(m)};
  ws.onclose=()=>{clearTimeout(to);if(NET.ws===ws){NET.ws=null;if(NET.reco)netRecoNext();else netDropped('Lost connection to the server.')}};
  ws.onerror=()=>{};
}
function netRecoBegin(){
  const S=netSess(),relHost=!NET.reco&&!NET.auth&&NET.live&&NET.m==='host'&&NET.role==='host'&&S&&S.rel;
  if(!(NET.reco||relHost||(NET.auth&&NET.live&&S)))return false;
  if(NET.ws){try{NET.ws.onclose=null;NET.ws.close()}catch(_){}NET.ws=null}
  if(NET.reco){netRecoNext();return true}
  if(relHost){NET.reco={t0:Date.now(),n:0,tm:0,keep:1};NET.status='';feedAdd('Connection lost - reconnecting...',false);netRecoTry();return true}
  NET.reco={t0:Date.now(),n:0,tm:0};NET.code='';NET.role=null;NET.players=[];NET.status='';NET.notice='';netCleanup();
  netRecoTry();return true;
}
function netDropped(msg){
  if(netRecoBegin())return;
  const had=NET.code||NET.live||NET.status;
  NET.code='';NET.role=null;NET.status='';NET.players=[];if(NET.ws){try{NET.ws.onclose=null;NET.ws.close()}catch(_){}NET.ws=null}
  netCleanup();if(had)NET.notice=msg||'Disconnected.';netMenu();
}
function netLeave(){netWakeStop();netRecoStop();netSessClear();netSend({t:'leave'});if(NET.ws){try{NET.ws.onclose=null;NET.ws.close()}catch(_){}NET.ws=null}NET.code='';NET.role=null;NET.players=[];netCleanup();menu()}
function netMsg(m){
  try{
    if(!m||typeof m!=='object'||typeof m.t!=='string')return;
    if((m.t==='joined'||m.t==='players')&&!Array.isArray(m.players))return;
    if(m.t==='pong'&&typeof m.ts!=='number')return;
    if(m.t==='r'&&(!m.d||typeof m.d!=='object'))return;
    netMsgInner(m);
  }catch(err){console.warn('netMsg error',err)}
}
function netLeaderChanged(prev,m){
  if(!prev||prev===m.host)return;
  const q=NET.players.find(p=>p.pid===m.host);if(!q)return;
  const msg=m.host===NET.pid?'You are now the room leader':q.name+' is now the room leader';
  if(NET.live||G.mode==='over'||G.mode==='between')feedAdd(msg,false);else NET.notice=msg;
  if(G.mode==='over'){
    const r=panel.querySelector('.row');if(r)r.innerHTML=netEndRow();
    const l=document.getElementById('nlead');if(l)l.textContent=NET.role==='host'?'Start another match with the same players and settings.':'Waiting for the room leader to start a rematch.';
  }
}
function netMsgInner(m){
  switch(m.t){
    case'joined':NET.auth=!!m.auth;netSessSave(m);if(m.cfg)NET.cfg=m.cfg;NET.pid=m.pid;NET.code=m.code;NET.hostPid=m.host;NET.players=m.players;NET.role=m.pid===m.host?'host':'client';NET.notice='';if(m.rejoined){netRecoStop();NET.lastSnap=performance.now();NET.modeSince=0}if(m.started){NET.status='';break}netLobby();break;
    case'players':
      const pvHost=NET.hostPid;NET.players=m.players;NET.hostPid=m.host;if(m.cfg)NET.cfg=m.cfg;NET.role=NET.pid===m.host?'host':'client';netLeaderChanged(pvHost,m);
      if(!m.started&&NET.live){netCleanup();netLobby()}else if(!NET.live&&!m.started)netLobby();break;
    case'left':if(NET.m==='host')netBotify(m.pid);break;
    case'hostlost':if(NET.m==='client')feedAdd('Host connection lost - waiting up to '+Math.round((m.ms||30000)/1000)+'s for them to return',false);break;
    case'hostback':if(NET.m==='client')feedAdd('Host is back',false);break;
    case'closed':netRecoStop();netSessClear();NET.code='';NET.role=null;if(NET.ws){try{NET.ws.onclose=null;NET.ws.close()}catch(_){}NET.ws=null}netCleanup();NET.notice=m.restarting?'Server restarting for an update. Your match was ended - start a new room in about a minute.':(m.reason||'The room was closed.');netMenu();break;
    case'err':if(m.code==='full'){m.msg='Server full: no free rooms right now. Try again in a minute, or join a friend with their room code.'}if(NET.reco){if(m.rejoin===false)netRecoFail(m.msg);else{if(NET.ws){try{NET.ws.onclose=null;NET.ws.close()}catch(_){}NET.ws=null}netRecoNext()}break}if(m.rejoin===false)netSessClear();NET.status='';NET.notice=m.msg||'Error';if(NET.code)netLobby();else netMenu();break;
    case'pong':NET.rtt=Math.max(0,Date.now()-m.ts);NET.lag=Math.min(.12,NET.rtt/2000+.03);netPongGot(m.ts,NET.rtt);break;
    case'r':netRecv(m.from,m.d);break;
  }
}
function netRecv(from,d){
  try{
    if(!d||typeof d!=='object')return;
    netRecvInner(from,d);
  }catch(err){console.warn('netRecv error',err)}
}
function netRecvInner(from,d){
  if(!d)return;
  if(NET.m==='host'){
    if(d.k==='i'){const c=NET.cl[from];if(!c)return;let I=NET.inp[from];if(!I)I=NET.inp[from]={acts:[]};
      I.mx=clamp(+d.mx||0,-1,1);I.my=clamp(+d.my||0,-1,1);I.f=+d.f||0;I.fr=d.fr?1:0;if(Array.isArray(d.a)&&I.acts.length<12)for(const a of d.a.slice(0,6))I.acts.push(a);
      if(typeof d.sv==='number')c.sv=d.sv;if(typeof d.q==='number')c.ak=d.q}
    else if(d.k==='ready'){const c=NET.cl[from];if(!c||G.mode!=='between'||NET.ready[from])return;
      if(Array.isArray(d.picks))for(const p of d.picks.slice(0,8))if(Array.isArray(p)&&UP[p[0]])applyUpgrade(c.f,p[0],1);
      c.f.pend=0;NET.ready[from]=true;netHostCheckNext()}
    else if(d.k==='rs'){const c=NET.cl[from];if(c)c.needFull=true}
    return;
  }
  if(NET.m==='client'||d.k==='start'){
    switch(d.k){
      case'start':netOnStart(d);break;
      case's':netApplySnap(d);break;
      case'res':netClientResults(d);break;
      case'drop':netApplyDrop(d.drop);break;
    }
  }
}

// ---------- menus ----------
function wepGrid(){return`<div class="weps">${Object.entries(WEAPONS).map(([k,w])=>{const c=CHARS[k];return`<button class="wep" data-act="wep" data-v="${k}" aria-pressed="${G.pick===k}" style="border-left:4px solid ${CPAL[k].acc}"><span class="wrole" style="color:${CPAL[k].acc}">${c.role} · ${w.name}</span><span class="wname">${c.name}</span><span class="wab"><b>${c.ab}.</b> ${c.desc}</span></button>`}).join('')}</div>`}
function netMenu(){
  NET.view='menu';G.mode='menu';G.P=null;showHUD(false);
  let srv='';try{srv=localStorage.getItem('hordeserver')||''}catch(e){}
  show(`<p class="eyebrow">Online · up to 16 players</p><h1>Horde <em>Duel</em></h1>
  ${NET.notice?`<p class="lede" style="color:var(--foe)">${esc(NET.notice)}</p>`:''}${NET.status?`<p class="lede">${esc(NET.status)}</p>`:''}
  <div class="group"><span class="glabel">Your name</span><input class="nin" id="nName" maxlength="14" placeholder="Player" value="${esc(NET.name)}" autocomplete="off"></div>
  <div class="group"><span class="glabel">Choose your character</span>${wepGrid()}</div>
  <button class="go" data-act="n_quick">Quick play</button>
  <button class="go ghost" data-act="n_create">Create a room</button>
  <div class="group"><span class="glabel">Join a friend's room</span><div class="nrow"><input class="nin" id="nCode" maxlength="6" placeholder="CODE" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" inputmode="text" style="text-transform:uppercase;letter-spacing:.3em;text-align:center"><button class="go" data-act="n_join">Join</button></div></div>
  <details class="how"><summary>Server address</summary><input class="nin" id="nSrv" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Leave empty to use this site" value="${esc(srv)}" autocomplete="off"><p class="lede">Only change this if you host the server somewhere else, e.g. wss://your-app.onrender.com/ws</p></details>
  <button class="go ghost" data-act="menu">Back to solo menu</button>`);
}
function netReadForm(){
  const n=$('#nName'),s=$('#nSrv');
  if(n){NET.name=n.value.replace(/[^\w \-.!?]/g,'').trim().slice(0,14);try{localStorage.setItem('hordename',NET.name)}catch(e){}}
  if(s){try{localStorage.setItem('hordeserver',netFixSrv(s.value))}catch(e){}}
}
function netCap(){const c=NET.cfg;return c.mode==='duel'?2:c.mode==='team'?4:c.size}
function netSizeChange(v){if(NET.role==='host'){NET.cfg.size=v;const e=$('#nsizeV');if(e)e.textContent=v;clearTimeout(netSizeChange.t);netSizeChange.t=setTimeout(()=>netSend({t:'cfg',mode:NET.cfg.mode,size:v,map:NET.cfg.map}),150)}}
function modLine(m){m=(m||[]).filter(k=>MODS[k]);return m.length?`<p class="lede" style="color:#ffd166;font-weight:700">Modifiers on: ${m.map(k=>esc(MODS[k][0])).join(' · ')}</p>`:''}
function modGroup(){const m=NET.cfg.mods||[];return `<div class="group"><span class="glabel">Modifiers (apply to everyone)</span><div class="seg" style="grid-template-columns:repeat(2,1fr)">${Object.entries(MODS).map(([k,v])=>`<button data-act="n_mod" data-v="${k}" title="${esc(v[1])}" aria-pressed="${m.includes(k)}">${esc(v[0])}</button>`).join('')}</div></div>`}
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-act=n_mod]');if(!b||NET.role!=='host'||NET.view!=='lobby')return;const k=b.dataset.v,m=(NET.cfg.mods||[]).slice(),i=m.indexOf(k);if(i>=0)m.splice(i,1);else if(MODS[k])m.push(k);NET.cfg.mods=m;b.setAttribute('aria-pressed',m.includes(k));netSend({t:'cfg',mode:NET.cfg.mode,size:NET.cfg.size,map:NET.cfg.map,mods:m})});
(function(){const el=document.createElement('div');el.id='modStrip';el.style.cssText='position:fixed;top:22px;left:50%;transform:translateX(-50%);z-index:9;pointer-events:none;font:700 11px var(--mono);color:#ffd166;background:rgba(0,0,0,.6);border:1px solid #ffd16688;border-radius:4px;padding:3px 8px;letter-spacing:.05em;display:none;max-width:92vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';(document.body||document.documentElement).appendChild(el);setInterval(()=>{const m=((G.cfg&&G.cfg.mods)||[]).filter(k=>MODS[k]),on=!!G.P&&G.mode!=='menu'&&m.length>0;if(!on){if(el.style.display!=='none')el.style.display='none';return}const t='MODIFIERS: '+m.map(k=>MODS[k][0]).join(' · ');if(el.textContent!==t)el.textContent=t;el.style.display='block'},400)})();
function netLobby(){
  NET.view='lobby';G.mode='menu';G.P=null;showHUD(false);
  const host=NET.role==='host',cfg=NET.cfg,tm=cfg.mode==='team',capN=netCap(),me=NET.players.find(p=>p.pid===NET.pid);
  const tl=t=>t===1?'Team B':'Team A';
  show(`<p class="eyebrow">Room code · ${NET.players.length}/${capN} players · ${MODES[cfg.mode]}${cfg.mode==='br'?' · '+cfg.size+' fighters':''}</p><h1 style="letter-spacing:.25em;font-size:56px">${esc(NET.code)}</h1>${modLine(cfg.mods)}
  ${NET.notice?`<p class="lede" style="color:var(--foe)">${esc(NET.notice)}</p>`:''}
  <p class="lede">${host?(NET.auth?'Share the code with friends. Empty slots are filled with bots when you start.':'Share the code with friends. Empty slots are filled with bots when you start. Keep this tab open and in front: the match runs in your browser.'):'Waiting for the room leader to start the match.'}</p>
  <div class="tbl">${NET.players.map(p=>`<div class="tr${p.pid===NET.pid?' me':''}"><span>${p.pid===NET.hostPid?'★':''}</span><span>${esc(p.name)}</span><span>${tm?tl(p.team)+' · ':''}${CHARS[p.weapon]?CHARS[p.weapon].name:''}</span></div>`).join('')}</div>
  ${tm&&me?`<div class="group"><span class="glabel">Your team</span><div class="seg"><button data-act="n_team" data-v="0" aria-pressed="${me.team!==1}">Team A</button><button data-act="n_team" data-v="1" aria-pressed="${me.team===1}">Team B</button></div></div>`:''}
  ${host?`<div class="group"><span class="glabel">Mode</span><div class="seg">${Object.entries(MODES).map(([k,v])=>`<button data-act="n_mode" data-v="${k}" aria-pressed="${cfg.mode===k}">${v}</button>`).join('')}</div></div>
  <div class="group"><span class="glabel">Map</span><div class="seg" style="grid-template-columns:repeat(4,1fr)">${[['random','Random'],...Object.entries(MAPS).map(([k,v])=>[k,v.name])].map(([k,v])=>`<button data-act="n_map" data-v="${k}" aria-pressed="${(cfg.map||'random')===k}">${v}</button>`).join('')}</div></div>
  ${cfg.mode==='br'?`<div class="group"><label class="glabel" for="nsize">Lobby size · <b id="nsizeV">${cfg.size}</b> fighters (empty slots are bots)</label><input class="nin" type="range" id="nsize" min="${Math.max(2,NET.players.length)}" max="16" value="${cfg.size}" style="padding:6px"></div>`:`<p class="lede">${cfg.mode==='duel'?'1v1: a small arena with a light zombie horde. First to 3 round wins.':'2v2: two teams of two, pick yours above. Bots fill empty team slots. Allies cannot hurt each other.'}</p>`}
  ${modGroup()}
  <div class="group"><span class="glabel">Bot skill</span><div class="seg">${Object.keys(DIFF).map(k=>`<button data-act="diff" data-v="${k}" aria-pressed="${G.diff===k}">${cap(k)}</button>`).join('')}</div></div>`:''}
  <details class="how"><summary>Change character</summary>${wepGrid()}</details>
  ${host?'<div class="pfoot"><button class="go" data-act="n_start">Start match</button></div>':''}
  <button class="go ghost" data-act="n_leave">Leave room</button>`);
}
function netAct2(act,v){
  switch(act){
    case'n_quick':netReadForm();NET.notice='';netConnect(()=>netSend({t:'quick',name:NET.name,weapon:G.pick}));break;
    case'n_create':netReadForm();NET.notice='';netConnect(()=>netSend({t:'create',name:NET.name,weapon:G.pick}));break;
    case'n_join':{netReadForm();const c=($('#nCode').value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');if(c.length!==4){NET.notice='Enter the 4 letter room code.';netMenu();break}NET.notice='';netConnect(()=>netSend({t:'join',code:c,name:NET.name,weapon:G.pick}));break}
    case'n_start':if(NET.role==='host'&&NET.players.length){if(NET.auth)netSend({t:'start',diff:G.diff});else{netSend({t:'start'});netHostStart()}}break;
    case'n_leave':netLeave();break;
    case'n_lobby':netSend({t:'lobby'});break;
    case'n_rematch':if(NET.role==='host'){netSend({t:'rematch',diff:G.diff});if(!NET.auth)netHostStart()}break;
    case'n_mode':if(NET.role==='host')netSend({t:'cfg',mode:v,size:NET.cfg.size,map:NET.cfg.map});break;
    case'n_map':if(NET.role==='host')netSend({t:'cfg',mode:NET.cfg.mode,size:NET.cfg.size,map:v});break;
    case'n_team':netSend({t:'upd',team:+v});break;
  }
}

// ---------- host: start / drops ----------
function netDropInfo(){const fs=G.fighters.slice(0,N_FIGHT);return{map:MAPID,dn:G.dropNo,su:G.sudden?1:0,sc:G.sc,ups:fs.map(f=>f.ups),pos:fs.map(f=>[Math.round(f.x),Math.round(f.y),q2(f.facing)])}}
function netBuild(pl,cfg,localPid){
  const mapId=(cfg.map&&MAPS[cfg.map])?cfg.map:Object.keys(MAPS)[Math.floor(Math.random()*3)];setMap(mapId);
  const hn=pl.length,c=setupMode(Object.assign({},cfg,{n:Math.max(cfg.size||cfg.n||16,hn)}));
  const team=c.mode==='team';let slots;
  if(team){const a=pl.filter(p=>p.team!==1).slice(0,2),b=pl.filter(p=>p.team===1).slice(0,2);slots=[a[0],a[1],b[0],b[1]]}
  else{slots=pl.slice(0,N_FIGHT);if(localPid!=null)slots.sort((x,y)=>x.pid===localPid?-1:y.pid===localPid?1:x.pid-y.pid)}
  G.fighters=[];NET.cl={};
  for(let i=0;i<N_FIGHT;i++){
    const h=slots[i],f=makeFighter(i,h?h.weapon:WKEYS[Math.floor(Math.random()*WKEYS.length)]);
    if(team)f.team=i<2?0:1;
    if(h){f.name=h.name;f.isAI=false;f.pid=h.pid;f.remote=h.pid!==localPid;f.pend=0}else{f.isAI=true;f.name=i?NAMES[i-1]:'Ash'}
    G.fighters.push(f);
  }
  for(const f of G.fighters)if(f.remote)NET.cl[f.pid]={f,evi:0,sv:f.id};
  return c;
}
const netRoster=()=>G.fighters.slice(0,N_FIGHT).map(f=>[f.pid||0,f.name,f.weapon,f.team===undefined?-1:f.team]);
function netHostStart(){
  G.debug=false;G.zmode=false;NET.inp={};NET.ready={};NET.ev=[];NET.evBase=0;
  resetMatch();netBuild(NET.players.slice(),NET.cfg,NET.pid);
  G.P=G.fighters.find(f=>f.pid===NET.pid)||G.fighters[0];G.dropNo=1;NET.m='host';NET.live=true;NET.resDn=-1;NET.pts=null;NET.paused=false;
  startDrop();
  netRel('*',{k:'start',ros:netRoster(),cfg:G.cfg,diff:G.diff,drop:netDropInfo()});
}
function netSrvStart(pl,diff,cfg){
  NET.srv=true;NET.pid=0;NET.hostPid=0;NET.snapMs=50;if(DIFF[diff])G.diff=diff;
  G.debug=false;G.zmode=false;NET.inp={};NET.ready={};NET.ev=[];NET.evBase=0;
  resetMatch();netBuild(pl,cfg||NET.cfg,0);
  G.P=G.fighters[0];G.dropNo=1;NET.m='host';NET.live=true;NET.resDn=-1;NET.pts=[];NET.paused=false;
  startDrop();
  netRel('*',{k:'start',ros:netRoster(),cfg:G.cfg,diff:G.diff,drop:netDropInfo()});
}
function netHumans(){return Object.keys(NET.cl).length}
function netRejoin(pid){
  if(NET.cl[pid])return true;
  const f=G.fighters.slice(0,N_FIGHT).find(x=>x.pid===pid);if(!f)return false;
  f.isAI=false;f.remote=true;f.pend=0;f.wantFire=false;
  NET.cl[pid]={f,evi:NET.evBase+NET.ev.length,sv:f.id};
  feedAdd(f.name+' reconnected',false);return true;
}
function netResync(pid){
  if(!NET.cl[pid])return false;
  NET.cl[pid].needFull=true;
  netRel(pid,{k:'start',ros:netRoster(),cfg:G.cfg,diff:G.diff,drop:netDropInfo()});return true;
}
function netBotify(pid){
  const c=NET.cl[pid];if(!c)return;
  c.f.remote=false;c.f.isAI=true;c.f.wantFire=false;delete NET.cl[pid];delete NET.inp[pid];delete NET.ready[pid];
  feedAdd(c.f.name+' disconnected',false);if(G.mode==='between')netHostCheckNext();
}
function netNear(x,y){
  const p=NET.pts;if(!p)return Math.abs(x-G.cam.x)<720&&Math.abs(y-G.cam.y)<720;
  for(let i=0;i<p.length;i++)if(Math.abs(x-p[i].x)<720&&Math.abs(y-p[i].y)<720)return true;return false;
}
const netNoHumans=()=>!G.fighters.slice(0,N_FIGHT).some(f=>f.alive&&!f.isAI);
// remote human inputs -> fighter state
function controlRemote(f,dt){
  const I=NET.inp[f.pid];if(!I){f.mv={x:0,y:0};f.wantFire=false;return}
  const mm=Math.hypot(I.mx,I.my);f.mv=mm>1?{x:I.mx/mm,y:I.my/mm}:{x:I.mx,y:I.my};f.facing=I.f;f.wantFire=!!I.fr&&!f.down;
  if(f.down){I.acts=[];return}
  const acts=I.acts;I.acts=[];
  for(const a of acts){
    if(a[0]==='d')tryDash(f,+a[1]||0,+a[2]||0);
    else if(a[0]==='h'){const k=a[1]===1?'band':'kit';if(f.healT>0){f.healT=0;f.healKind=null}else startHeal(f,k)}
    else if(a[0]==='a'){if(f.weapon!=='revolver'){if(f.weapon==='crossbow'&&a.length>2)f.tgtPt={x:+a[1]||f.x,y:+a[2]||f.y};useAbility(f);f.tgtPt=null}}
    else if(a[0]==='z')toggleZoom(f);
    else if(a[0]==='u')usePanel(f,40);
    else if(a[0]==='m'&&f.weapon==='revolver'){
      const wx=+a[1],wy=+a[2],ang=Math.atan2(wy-f.y,wx-f.x),d=Math.min(MOLO_R,Math.hypot(wx-f.x,wy-f.y)),w=Math.max(0,d);
      f.facing=ang;f.throwTarget={x:f.x+Math.cos(ang)*w,y:f.y+Math.sin(ang)*w};useAbility(f);f.throwTarget=null}
    else if(a[0]==='r'){if(f.reloadT<=0&&f.ammo<f.st.clip)f.reloadT=f.st.reload}
  }
}
// ---------- host: between-drop flow ----------
function netBroadcastRes(){
  const fs=G.fighters.slice(0,N_FIGHT),fin=fs.some(f=>f.wins>=WIN_DROPS),st=fs.map(f=>[f.wins,f.pts,f.kills,f.place,f.dropKills,f.level]);
  NET.ready={};if(NET.srv)NET.ready[NET.pid]=true;NET.betT=performance.now()+50000;
  for(const pid in NET.cl){const f=NET.cl[pid].f;netRel(+pid,{k:'res',dn:G.dropNo,fin,w:G.winner?G.winner.id:-1,dr:G.draw?1:0,st,pk:fin?0:(f.pend||0)+1,reel:fin?reelGet():undefined})}
}
function netEndRow(){return (G.reel?'<button class="go ghost" data-act="reel">Highlights</button>':'')+(NET.role==='host'?'<button class="go" data-act="n_rematch">Rematch</button><button class="go ghost" data-act="n_lobby">Back to lobby</button>':'')+'<button class="go ghost" data-act="menu">Leave</button>'}
const dropResults0=dropResults;
dropResults=function(){
  if(NET.m==='host'&&NET.resDn!==G.dropNo){NET.resDn=G.dropNo;netBroadcastRes()}
  dropResults0();
  if(NET.m==='host'&&G.mode==='over'){const r=panel.querySelector('.row');if(r)r.innerHTML=netEndRow()}
};
function netWaitPanel(){
  show(`<p class="eyebrow">Drop ${G.dropNo} complete</p><h2>Waiting for players…</h2><p class="lede" id="nWait"></p>`);NET.waitEl=$('#nWait');netWaitText();
}
function netWaitText(){if(!NET.waitEl)return;const hs=Object.keys(NET.cl),n=hs.filter(p=>NET.ready[p]).length;NET.waitEl.textContent=`${n} of ${hs.length} other players ready · continues automatically in ${Math.max(0,Math.ceil((NET.betT-performance.now())/1000))}s`}
function netHostOwnPicked(){NET.ready[NET.pid]=true;netWaitPanel();netHostCheckNext()}
function netHostCheckNext(){
  if(G.mode!=='between'||!NET.ready[NET.pid])return;
  const all=Object.keys(NET.cl).every(p=>NET.ready[p]);
  if(all||performance.now()>NET.betT)netNextDrop();
}
function netNextDrop(){
  NET.waitEl=null;
  for(const f of G.fighters.slice(0,N_FIGHT)){
    if(f.remote){const c=NET.cl[f.pid];if(!c||!NET.ready[f.pid]){const n=(f.pend||0)+1;for(let i=0;i<n;i++)aiPick(f)}f.pend=0}
    else if(f.isAI)aiPick(f);
  }
  G.dropNo++;startDrop();NET.ready={};
  netRel('*',{k:'drop',drop:netDropInfo()});
}
// ---------- host: events and snapshots ----------
function evt(o){NET.ev.push(o);if(NET.ev.length>700){NET.ev.splice(0,250);NET.evBase+=250}}
{
  const _burst=burst;burst=function(x,y,col,n=10,sp=220){_burst(x,y,col,n,sp);if(NET.m==='host')evt({e:'b',x:x|0,y:y|0,c:col,n,s:sp|0})};
  for(const n of['shot','dash','ability']){const o=SFX[n];SFX[n]=function(f){o.call(SFX,f);if(NET.m==='host')evt({e:'s',n,f:f.id,x:f.x|0,y:f.y|0})}}
  for(const n of['snarl','boom','thwack','zdie','hunter']){const o=SFX[n];SFX[n]=function(x,y,a){o.call(SFX,x,y,a);if(NET.m==='host')evt({e:'s',n,x:x|0,y:y|0,a:typeof a==='number'?a:undefined})}}
  {const o=SFX.fdie;SFX.fdie=function(x,y,me){o.call(SFX,x,y,me);if(NET.m==='host')evt({e:'s',n:'fdie',x:x|0,y:y|0})}}
  {const o=SFX.pickup;SFX.pickup=function(k,x,y){o.call(SFX,k,x,y);if(NET.m==='host')evt({e:'s',n:'pickup',k,x:x|0,y:y|0})}}
  const _feed=feedAdd;feedAdd=function(t,h,ev){_feed(t,h,ev);if(NET.m==='host'){let o;if(ev){o=Object.assign({},ev);delete o.km;delete o.vm}evt({e:'f',m:t,all:1,ev:o})}};
  const _elim=eliminate;eliminate=function(t,src){
    const was=t.alive;_elim(t,src);
    if(NET.m==='host'&&was&&!t.zomb){
      for(let i=G.fx.length-1;i>=0&&i>G.fx.length-30;i--){const d=G.fx[i];if(d.kind==='death'&&d.x===t.x&&d.y===t.y){d.who=t.id;break}}
      evt({e:'k',id:t.id,pl:t.place,all:1});
    }
  };
}
const FXK={boom:1,ring:1,slash:1,splat:1,death:1,dropgun:1};
function netScanFx(){
  const fx=G.fx;
  for(let i=0;i<fx.length;i++){const f=fx[i];if(f.sent||!FXK[f.kind])continue;f.sent=1;
    const o={e:'x',k:f.kind};for(const key in f){const v=f[key];if(key==='age'||key==='sent'||key==='own')continue;if(typeof v==='number')o[key]=q2(v);else if(typeof v==='string')o[key]=v}
    if(f.own)o.own=f.own.id;evt(o)}
}
function netNumEv(t,amt,src){
  const only=[];if(t.remote)only.push(t.id);if(src&&src.remote)only.push(src.id);
  if(only.length)evt({e:'n',x:t.x|0,y:t.y-26|0,v:Math.round(amt),t:t.id,s:src?src.id:-1,only});
}
const enc=(o,keys)=>{const a=new Array(keys.length);for(let i=0;i<keys.length;i++){const k=keys[i];let v=o[k];
  if(k==='healKind')v=v==='band'?1:v==='kit'?2:0;else v=+v||0;a[i]=(k==='x'||k==='y')?Math.round(v):q2(v)}return a};
function netSnapFor(c){
  const f=c.f,V=(!f.alive&&c.sv!=null&&c.sv>=0&&fById(c.sv))||f,cx=V.x,cy=V.y,R2=900*900,fs=G.fighters;
  const F=[];
  for(let i=0;i<N_FIGHT;i++){const o=fs[i];if(o===f)continue;const dx=o.x-cx,dy=o.y-cy;
    if(dx*dx+dy*dy<R2)F.push([i,o.alive?1:0,1,...enc(o,FK)]);else F.push([i,o.alive?1:0,0,Math.round(o.x),Math.round(o.y),Math.round(o.hp),q2(o.tagT||0),o.tagBy==null?-1:o.tagBy])}
  c.n=(c.n||0)+1;c.sn=(c.sn||0)+1;const full=!!c.needFull||c.n%75===0;c.needFull=false;
  let Z;
  if(full||c.n%2===0){Z=[];const ZR2=780*780;
    for(let i=N_FIGHT;i<fs.length;i++){const z=fs[i];if(!z.zomb||!z.alive)continue;const dx=z.x-cx,dy=z.y-cy;
      if(dx*dx+dy*dy<ZR2)Z.push(z.id*8+Math.max(0,ZKS.indexOf(z.zk)),Math.round(z.x),Math.round(z.y),Math.round(z.facing*10),Math.max(1,Math.round(z.hp/z.zhp*100))+101*Math.min(1,Math.round(z.hitFlash*10))+202*Math.min(3,Math.round(z.swingT*10)))}}
  const B=[];for(const b of G.bullets){const dx=b.x-cx,dy=b.y-cy;if(dx*dx+dy*dy<1000*1000)B.push([b.owner.id,Math.round(b.x),Math.round(b.y),Math.round(b.vx),Math.round(b.vy),Math.round(b.r*10),b.expl?1:0])}
  let O;if(full||c.n%4===1){O=[];for(const o of G.orbs){const dx=o.x-cx,dy=o.y-cy;if(dx*dx+dy*dy<1100*1100)O.push([Math.round(o.x),Math.round(o.y),Math.round(o.t%100),Math.max(0,ITM.indexOf(o.item))])}}
  let M;if(full||c.n%4===3||c.n<3||c.mapv!==MAPV)M=(c.mapv=MAPV,DYN).map(r=>r.x<0?(r.door&&r.broken?-1:0):Math.max(1,Math.ceil(r.hp)));
  const D=[];for(const d of G.deploys){const dx=d.x-cx,dy=d.y-cy;if(dx*dx+dy*dy>1100*1100)continue;
    const o={};for(const k in d){const v=d[k];if(k==='owner')o.oid=v.id;else if(typeof v==='number')o[k]=q2(v);else if(typeof v==='string'||typeof v==='boolean')o[k]=v}D.push(o)}
  const E=[];const from=Math.max(0,c.evi-NET.evBase);
  for(let i=from;i<NET.ev.length;i++){const e=NET.ev[i];
    if(e.only&&e.only.indexOf(f.id)<0)continue;
    if(!e.all&&(e.x-cx)*(e.x-cx)+(e.y-cy)*(e.y-cy)>1500*1500)continue;E.push(e)}
  c.evi=NET.evBase+NET.ev.length;
  return{k:'s',sn:c.sn,ak:c.ak,T:q2(G.time),m:MODEC[G.mode]||0,cd:q2(G.countdown),et:q2(G.endT),w:G.winner?G.winner.id:-1,me:[f.alive?1:0,...enc(f,FK),...enc(f,XK)],F,Z,B,O,M,D,bo:G.bo?[G.bo.s,q2(G.bo.t)]:0,E:E.length>70?E.slice(-70):E};
}
function netHostTick(dt){
  if(!NET.live)return;
  const pts=NET.srv?[]:[{x:G.cam.x,y:G.cam.y}];
  for(const pid in NET.cl){const c=NET.cl[pid],V=(!c.f.alive&&c.sv>=0&&fById(c.sv))||c.f;pts.push({x:V.x,y:V.y})}
  NET.pts=pts;
  if(G.mode==='between'){if(NET.waitEl)netWaitText();if(performance.now()>NET.betT)netHostCheckNext();return}
  if(G.mode!=='play'&&G.mode!=='count'&&G.mode!=='ending')return;
  netScanFx();
  const now=performance.now();
  if(now-NET.lastSend>=(NET.snapMs||66)){NET.lastSend=now;for(const pid in NET.cl)netRel(+pid,netSnapFor(NET.cl[pid]))}
}
// ---------- client ----------
function netOnStart(d){
  NET.m='client';NET.live=true;NET.acts=[];NET.hist=[];NET.snapArr=0;NET.iv=0;NET.jit=0;NET.delay=0;NET.zm.clear();NET.paused=false;NET.gotSnap=false;NET.lastSn=0;
  G.debug=false;G.zmode=false;if(DIFF[d.diff])G.diff=d.diff;G.fighters=[];setupMode(d.cfg);
  d.ros.forEach((r,i)=>{const f=makeFighter(i,r[2]);f.name=r[1];f.pid=r[0];f.isAI=r[0]!==NET.pid;if(r[3]>=0)f.team=r[3];f.pend=0;f.tx=f.x;f.ty=f.y;f.tf=0;G.fighters.push(f);if(r[0]===NET.pid)NET.my=i});
  G.P=G.fighters[NET.my];G.P.isAI=false;G.dropNo=1;
  resetMatch();
  netApplyDrop(d.drop);
}
function netApplyDrop(d){
  const fs=G.fighters.slice(0,N_FIGHT);
  G.fighters=fs;NET.zm.clear();
  fs.forEach((f,i)=>{f.ups=d.ups[i]||{};computeStats(f);Object.assign(f,{alive:true,hp:mhp(f),place:0,dropKills:0,ammo:f.st.clip,reloadT:0,dashT:0,jumpT:0,healT:0,shield:0,cloakT:0,burnT:0,slowT:0,markT:0,armor:0,band:0,kit:0,pend:0,down:0,downT:0,revP:0,finP:0,tagT:0,zoom:0,zoomK:0,litT:0,fenceT:0,fenceN:0,x:d.pos[i][0],y:d.pos[i][1],facing:d.pos[i][2],mv:{x:0,y:0},wantFire:false,vx:0,vy:0});
    f.tx=f.x;f.ty=f.y;f.tf=f.facing;f.sb=null});
  if(d.map&&d.map!==MAPID)setMap(d.map);mapReset();G.dropNo=d.dn;G.sudden=!!d.su;G.draw=false;G.sc=d.sc;G.st=storm(0);G.bullets=[];G.deploys=[];G.orbs=[];G.fx=[];G.feed=[];G.time=0;boReset();G.pending=0;G.molo=0;G.afterPick=false;G.pOut=false;G.elimT=0;G.spectating=false;G.spec=null;G.ff=false;G.winner=null;
  G.cam={x:G.P.x,y:G.P.y};NET.gotSnap=false;NET.lastSn=0;NET.snapArr=0;NET.hist=[];NET.hpPrev=G.P.hp;NET.pk=0;NET.picks=[];
  SFX.drop();NARR.say(G.sudden?'vo_sudden':G.dropNo>1?'vo_next_drop':'vo_match_start',{force:true});G.mode='count';G.countdown=3.2+NARR.lead();hide();showHUD(true);
}
function netApplySnap(d){
  if(!NET.live||NET.m!=='client'||!G.P)return;
  const P=G.P,fs=G.fighters,now=performance.now();netJitter(now);NET.lastSnap=now;NET.gotSnap=true;
  if(typeof d.sn==='number'){if(NET.lastSn&&d.sn>NET.lastSn+1&&now-(NET.rsT||0)>1000){NET.rsT=now;NET.rsN=(NET.rsN||0)+1;netRel(NET.hostPid,{k:'rs'})}NET.lastSn=d.sn}
  const nm=MODEN[d.m];
  if(nm&&(G.mode==='count'||G.mode==='play'||G.mode==='ending')){
    if(nm==='ending'&&G.mode!=='ending'){G.winner=fs[d.w]||null;SFX.sting(d.w===NET.my)}
    if(!(G.mode==='ending'&&nm!=='ending'))G.mode=nm;
  }
  G.time=d.T;G.countdown=d.cd;G.endT=d.et;if(d.bo)G.bo={s:d.bo[0],t:d.bo[1]};
  // self
  {const t=d.me,hp0=P.hp;P.alive=!!t[0];
    const o=1+FK.length,dsp=t[o+XK.indexOf('dashSp')];
    for(let i=0;i<FK.length;i++){const k=FK[i],v=t[1+i];
      if(k==='x'||k==='y'||k==='facing')continue;
      if(k==='healKind'){P.healKind=v===1?'band':v===2?'kit':null;continue}
      if(k==='dashT'&&!(dsp>800))continue;
      P[k]=v}
    for(let i=0;i<XK.length;i++){const k=XK[i],v=t[o+i];
      if((k==='dashSp'||k==='dashDir')&&!(dsp>800))continue;
      P[k]=v}
    P.tx=t[1];P.ty=t[2];G.pending=P.pend||0;
    {let ex=P.tx-P.x,ey=P.ty-P.y,er=Math.hypot(ex,ey),acked=false;const mv=Math.hypot(P.mv.x,P.mv.y)>.1||P.dashT>0;
      const H=NET.hist;if(H&&typeof d.ak==='number'){while(H.length&&H[0].q<d.ak)H.shift();if(H.length&&H[0].q===d.ak&&!(P.jumpT>0)&&!(P.dashT>0&&P.dashSp>800)){ex=P.tx-H[0].x;ey=P.ty-H[0].y;er=Math.hypot(ex,ey);acked=true}}
      // host position trails the predicted one by ~RTT while moving: tolerate that lag, only correct real divergence
      const tol=acked?20:mv?Math.max(70,(NET.rtt||120)*.42):10;
      if(!P.alive||er>(acked?120:Math.max(260,tol*3))){P.x=P.tx;P.y=P.ty;NET.cor=null}
      else if(er>tol){const k=(acked?.3:.1)*(er-tol)/er;NET.cor={x:ex*k,y:ey*k}}}
    if(P.alive&&P.hp<hp0-1.2&&performance.now()-NET.hurtT>150){NET.hurtT=performance.now();SFX.hurt();if(typeof VOICE!=='undefined')VOICE.hurt(hp0-P.hp)}
  }
  // others
  for(const t of d.F){const f=fs[t[0]];if(!f||f===P)continue;f.alive=!!t[1];
    if(t[2]){
      for(let i=0;i<FK.length;i++){const k=FK[i],v=t[3+i];
        if(k==='x'||k==='y'||k==='facing')continue;
        if(k==='healKind'){f.healKind=v===1?'band':v===2?'kit':null;continue}
        f[k]=v}
      f.tx=t[3];f.ty=t[4];f.tf=t[5];if(!f.known||!f.alive){f.x=f.tx;f.y=f.ty;f.facing=f.tf;f.sb=null}else netSample(f,f.tx,f.ty,f.tf,now);f.known=true;
    }else{f.tx=t[3];f.ty=t[4];f.known=false;f.sb=null;f.x=f.tx;f.y=f.ty;if(t.length>5){f.hp=t[5];f.tagT=t[6];f.tagBy=t[7]}}
    if(!f.alive){f.x=f.tx;f.y=f.ty}
  }
  // zombies (sent every other snapshot)
  if(d.Z){
    const seen=new Set(),Z=d.Z;
    for(let i=0;i<Z.length;i+=5){const id=Z[i]>>3,kc=Z[i]&7,a=Z[i+4];let z=NET.zm.get(id);
      if(!z){z=netMkZ(id,kc);NET.zm.set(id,z);fs.push(z);z.x=Z[i+1];z.y=Z[i+2];z.facing=Z[i+3]/10}
      seen.add(id);z.tx=Z[i+1];z.ty=Z[i+2];z.tf=Z[i+3]/10;netSample(z,z.tx,z.ty,z.tf,now);z.zhp=100;z.hp=a%101;z.hitFlash=(Math.floor(a/101)%2)*.1;z.swingT=Math.floor(a/202)*.1}
    if(NET.zm.size!==seen.size){
      for(const [id,z] of NET.zm)if(!seen.has(id)){NET.zm.delete(id);z.alive=false}
      let w=N_FIGHT;for(let i=N_FIGHT;i<fs.length;i++){if(fs[i].alive)fs[w++]=fs[i]}fs.length=w;
    }
  }
  // bullets / orbs / deploys
  const lag=NET.lag;
  G.bullets=d.B.map(t=>({x:t[1]+t[3]*lag,y:t[2]+t[4]*lag,vx:t[3],vy:t[4],r:t[5]/10,expl:t[6]?1:0,owner:fs[t[0]]||fs[0],fx:{}}));
  if(d.M)netMapApply(d.M);
  if(d.O)G.orbs=d.O.map(t=>({x:t[0],y:t[1],t:t[2],item:ITM[t[3]]}));
  G.deploys=d.D.map(o=>{o.owner=fs[o.oid]||fs[0];return o});
  for(const e of d.E)netReplay(e);
}
// ---------- snapshot interpolation / jitter buffer ----------
// Track snapshot arrival interval + jitter; remote entities are drawn NET.delay ms in the past so there are
// almost always two samples to interpolate between.
function netJitter(now){
  const l=NET.snapArr;NET.snapArr=now;if(!l)return;
  const dt=now-l;if(dt<=0||dt>500)return;
  NET.iv=NET.iv?NET.iv*.9+dt*.1:dt;
  NET.jit=(NET.jit||0)*.9+Math.abs(dt-NET.iv)*.1;
  NET.delay=Math.max(100,Math.min(300,NET.iv*2+NET.jit*2.5));
}
function netSample(f,x,y,a,now){
  const b=f.sb||(f.sb=[]),l=b[b.length-1];
  if(l){
    if(now<=l.t)return;
    if((x-l.x)*(x-l.x)+(y-l.y)*(y-l.y)>40000){b.length=0;f.x=x;f.y=y}
  }
  b.push({t:now,x,y,a});if(b.length>10)b.shift();
}
function netInterp(f,rt){
  const b=f.sb;
  while(b.length>2&&b[1].t<=rt)b.shift();
  const a=b[0];let x=a.x,y=a.y,r=a.a;
  if(b.length>1){
    const c=b[1],span=c.t-a.t;
    if(rt>=c.t){
      // starved: extrapolate briefly along the last velocity, then hold
      const ms=Math.min(100,rt-c.t);
      if(span>0){x=c.x+(c.x-a.x)/span*ms;y=c.y+(c.y-a.y)/span*ms}else{x=c.x;y=c.y}
      r=c.a;
    }else if(rt>a.t&&span>0){
      const k=(rt-a.t)/span;
      x=a.x+(c.x-a.x)*k;y=a.y+(c.y-a.y)*k;
      let da=c.a-a.a;da=Math.atan2(Math.sin(da),Math.cos(da));r=a.a+da*k;
    }
  }
  f.x=x;f.y=y;f.facing=r;
}
function netMapApply(M){
  for(let i=0;i<DYN.length&&i<M.length;i++){const r=DYN[i],v=M[i];
    if(v<=0){if(r.x>=0)dynPark(r);if(r.door){r.on=false;r.broken=v<0}else r.gone=true}
    else{if(r.x<0){r.x=r.ox;r.y=r.oy}if(r.door){r.on=true;r.broken=false}r.hp=v}}
}
function netMkZ(id,kc){
  const k=ZKS[kc]||'walker',z=makeFighter(id,'pistol');
  Object.assign(z,{zomb:true,zk:k,isAI:true,name:k==='hunter'?'A hunter':k==='sprinter'?'A sprinter':'A zombie',r:k==='sprinter'?12:(ZT[k]?ZT[k].r:16),pulse:Math.random()*TAU,alive:true,known:true,id});
  return z;
}
function netShards(x,y,cols,n){for(let i=0;i<n;i++){const a=Math.random()*TAU,v=rnd(80,300);G.fx.push({kind:'shard',x,y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,rot:Math.random()*TAU,vr:rnd(-12,12),age:0,life:rnd(.5,.9),col:cols[i%cols.length],sz:rnd(3,6)})}}
function netReplay(e){
  const P=G.P;
  switch(e.e){
    case'b':burst(e.x,e.y,e.c,e.n,e.s);break;
    case's':{
      const n=e.n;
      if(n==='shot'||n==='dash'||n==='ability'){const f=fById(e.f);if(!f)break;SFX[n](f);
        if(n==='shot'&&f!==P&&P.alive&&f.pingT<=0&&Math.hypot(P.x-f.x,P.y-f.y)<900&&!canSee(P,f)){G.fx.push({kind:'ping',x:e.x+gauss()*70,y:e.y+gauss()*70,age:0,life:1.1});f.pingT=.9}}
      else if(n==='pickup')SFX.pickup(e.k,e.x,e.y);
      else if(n==='fdie'){SFX.fdie(e.x,e.y,false);netShards(e.x,e.y,['#d9a441','#c8d4e0','#ff8a4d','#49d9bd'],12)}
      else if(n==='zdie'){SFX.zdie(e.x,e.y);netShards(e.x,e.y,['#5f8a3f','#8c1f2b'],8);G.fx.push({kind:'splat',x:e.x,y:e.y,r:rnd(20,30),a:Math.random()*TAU,age:0,life:9})}
      else if(SFX[n])SFX[n](e.x,e.y,e.a);
      break}
    case'x':{const o=Object.assign({age:0},e);delete o.e;o.kind=o.k;delete o.k;
      if(o.kind==='slash'&&o.own!=null)o.own=fById(o.own);
      if(o.kind==='death')o.col=o.who===NET.my?COL.you:COL.foe;
      if(o.kind==='splat')break;
      G.fx.push(o);break}
    case'f':feedAdd(e.m,!!(P&&e.m.indexOf(P.name)>=0),e.ev);break;
    case'n':{const t=fById(e.t);if(!t)break;const mine=e.t===NET.my;addNum(t,e.v,mine?COL.foe:COL.you);break}
    case'k':{const f=fById(e.id);if(!f)break;f.alive=false;f.place=e.pl;
      if(e.id===NET.my){G.spectating=true;G.pOut=true;G.elimT=1.7;try{navigator.vibrate&&navigator.vibrate([40,40,80])}catch(_){}}break}
  }
}
const DECAY=['muzzle','swingT','hitFlash','parryT','rdT','inv','dashCD','healT','shF','hurtT','cloakT','burnT','slowT','markT','dashT','reloadT','swingT','pingT','tagT','scanWarn','litT','fenceT','downT'];
function netClientUpdate(dt){
  const P=G.P,fs=G.fighters;
  const rt=performance.now()-(NET.delay||110),rtZ=rt-(NET.iv||50);   // zombies arrive every other snapshot: one extra interval of delay
  if(G.mode==='count'){G.countdown-=dt;NARR.say.tick(G.countdown);if(G.countdown<=0&&NET.gotSnap)G.mode='play'}
  else if(G.mode==='play'||G.mode==='ending')G.time+=dt;
  for(let i=0;i<fs.length;i++){const f=fs[i];
    f.t+=dt;for(const k of DECAY)if(f[k]>0)f[k]=Math.max(0,f[k]-dt);
    if(f.zomb)f.pulse+=dt;
    if(f===P||!f.alive||f.tx===undefined)continue;
    if(f.sb&&f.sb.length)netInterp(f,f.zomb?rtZ:rt);
    else{
      const dx=f.tx-f.x,dy=f.ty-f.y;
      if(dx*dx+dy*dy>40000){f.x=f.tx;f.y=f.ty}else{const k=Math.min(1,dt*14);f.x+=dx*k;f.y+=dy*k}
      if(f.tf!==undefined)f.facing=turnToward(f.facing,f.tf,(f.zomb?6:18)*dt);
    }
    if(f.dashT>0&&!f.zomb&&Math.random()<.9)G.fx.push({kind:'ghost',x:f.x,y:f.y,age:0,life:.18,col:COL.foe});
  }
  for(const b of G.bullets){b.x+=b.vx*dt;b.y+=b.vy*dt}
  for(const o of G.orbs)o.t+=dt;
  mapDecay(dt);
  if(G.bo)G.bo.t-=dt;
  if(G.mode==='ending')return;
  // own fighter: input, prediction
  if(P.alive&&(G.mode==='play'||G.mode==='count')){
    controlNet(dt);
    if(G.mode==='play'){
      if(P.jumpT>0||(P.dashT>0&&P.dashSp>800)){const k=Math.min(1,dt*14);P.x+=(P.tx-P.x)*k;P.y+=(P.ty-P.y)*k}
      else{
        let vx,vy;
        if(P.dashT>0){vx=Math.cos(P.dashDir)*P.dashSp;vy=Math.sin(P.dashDir)*P.dashSp;if(Math.random()<.9)G.fx.push({kind:'ghost',x:P.x,y:P.y,age:0,life:.18,col:COL.you})}
        else{const fx=P.st.fx,sp=SPEED*CHARS[P.weapon].spd*(1+.08*(fx.fleet||0))*(P.healT>0?.5:1)*(P.slowT>0?1-P.slowAmt:1)*moveSp(P);vx=P.mv.x*sp;vy=P.mv.y*sp}
        P.x+=vx*dt;P.y+=vy*dt;collide(P);
      }
    }
  }else if(!P.alive){P.mv={x:0,y:0};P.wantFire=false}
  if(G.pOut&&G.elimT>0){G.elimT-=dt;if(G.elimT<=0)openElim()}
  if(NET.cor&&P.alive){const a=Math.min(1,dt*18),cx=NET.cor.x*a,cy=NET.cor.y*a;P.x+=cx;P.y+=cy;NET.cor.x-=cx;NET.cor.y-=cy;collide(P)}
  if(performance.now()-NET.lastIn>=33||NET.acts.length){NET.lastIn=performance.now();netSendInput()}
}
function controlNet(dt){
  const p=G.P;let mx=0,my=0,fire=false;p.tgtPt=null;
  if(ov.hidden&&G.mode==='play'){
    const ms=stickVec(sticks.move);mx=ms.x;my=ms.y;
    if(kd('up'))my-=1;if(kd('down'))my+=1;if(kd('left'))mx-=1;if(kd('right'))mx+=1;
    const mm=Math.hypot(mx,my);if(mm>1){mx/=mm;my/=mm}
    const as=stickVec(sticks.aim);
    if(sticks.aim&&as.m>0.22){p.facing=Math.atan2(as.y,as.x);fire=true}
    else if(G.mouseMode){const z=zoom();const wx=(mouse.x-innerWidth/2)/z+G.cam.x,wy=(mouse.y-innerHeight/2)/z+G.cam.y;p.facing=Math.atan2(wy-p.y,wx-p.x);p.tgtPt={x:wx,y:wy};fire=mouse.down}
    else if(mm>0.15)p.facing=turnToward(p.facing,Math.atan2(my,mx),12*dt);
    if(p.down){fire=false;dashQueued=false;abQueued=false;healQueued=null;zoomQueued=false}
    if(zoomQueued){zoomQueued=false;if(p.weapon==='sniper'&&p.alive){NET.acts.push(['z']);p.zoom=p.zoom?0:1}}
    if(dashQueued){dashQueued=false;
      if(p.dashCD<=0&&p.dashT<=0&&p.jumpT<=0){p.dashSp=DASH_SPEED;p.dashDir=Math.hypot(mx,my)>.1?Math.atan2(my,mx):p.facing;p.dashT=DASH_T;p.inv=INV_T;p.dashCD=DASH_CD;p.healT=0;p.healKind=null;NET.acts.push(['d',q2(mx),q2(my)])}}
    if(G.molo>0){G.molo-=dt;if(G.molo<=0)G.molo=0}
    if(healQueued){const k=healQueued;healQueued=null;NET.acts.push(['h',k==='band'?1:2])}
    if(abQueued){abQueued=false;
      if(p.weapon==='revolver'){if(G.molo>0)G.molo=0;else if((p.abCD<=0||p.abCh>0)&&p.dashT<=0)G.molo=5}
      else NET.acts.push(p.weapon==='crossbow'&&p.tgtPt?['a',q2(p.tgtPt.x),q2(p.tgtPt.y)]:['a'])}
    if(useQueued){useQueued=false;const pn=nearPanel(p);if(pn){NET.acts.push(['u']);const w=useWhy(pn.door);useFB(!w,w)}}
    if(keys.has('KeyR')&&performance.now()-NET.keyR>400){NET.keyR=performance.now();NET.acts.push(['r'])}
  }else{dashQueued=false;abQueued=false;healQueued=null;zoomQueued=false;useQueued=false}
  p.mv={x:mx,y:my};p.wantFire=fire&&!p.down;
}
function netSendInput(){
  const P=G.P;if(!P||NET.m!=='client')return;
  const q=(NET.seq=(NET.seq||0)+1);(NET.hist||(NET.hist=[])).push({q,x:P.x,y:P.y});if(NET.hist.length>90)NET.hist.shift();
  netRel(NET.hostPid,{k:'i',q,mx:q2(P.mv.x),my:q2(P.mv.y),f:q2(P.facing),fr:P.wantFire?1:0,a:NET.acts,sv:(G.spec&&!P.alive)?G.spec.id:-1});
  NET.acts=[];
}
function netClientResults(d){
  const fs=G.fighters.slice(0,N_FIGHT),P=G.P;
  d.st.forEach((s,i)=>{const f=fs[i];f.wins=s[0];f.pts=s[1];f.kills=s[2];f.place=s[3];f.dropKills=s[4];f.level=s[5]});
  G.winner=fs[d.w]||null;G.draw=!!d.dr;G.reel=d.reel||null;G.mode=d.fin?'over':'between';G.pickCtx='between';NET.pk=d.pk;NET.tot=d.pk;NET.picks=[];G.pending=0;
  if(d.fin){
    showHUD(false);const champ=standings()[0];
    show(`<p class="eyebrow">Match over</p><h2>${champ===P?'You win the match':isAlly(champ,P)?'Your team wins the match':esc(champ.name)+' wins the match'}</h2>
      <p class="lede">You placed #${P.place} in the last drop.</p>${standingsHTML(8)}${buildHTML()}
      <p class="lede" id="nlead">${NET.role==='host'?'Start another match with the same players and settings.':'Waiting for the room leader to start a rematch.'}</p><div class="row">${netEndRow()}</div>`);
    if(G.reel)setTimeout(()=>{if(G.mode==='over'&&!REEL.on)reelOpen()},900);
    return;
  }
  netShowOffers(true);
}
function netShowOffers(first){
  const P=G.P,o=offers(P,3);
  if(!o.length){netClientDone();return}
  const won=G.winner===P;
  show(`<p class="eyebrow">Drop ${G.dropNo} complete</p><h2>${first?(won?'You won the drop':G.draw?'Draw':'Drop over'):'Pick another upgrade'}</h2>
    ${first?`<p class="lede">${won?'Last one standing':(G.draw?'Draw, no win awarded. ':'')+'You placed #'+P.place+' of '+N_FIGHT+' with '+P.dropKills+' kill'+(P.dropKills===1?'':'s')}. First to ${WIN_DROPS} drop wins takes the match.</p>${standingsHTML(5)}`:''}
    <p class="lede">Upgrade ${NET.tot-NET.pk+1} of ${NET.tot}. Pick yours.</p>${cardsHTML(o,1)}`);
}
function netClientPick(v,m){
  const P=G.P;if(v){applyUpgrade(P,v,m);NET.picks.push([v,m])}
  NET.pk--;if(NET.pk>0)netShowOffers(false);else netClientDone();
}
function netClientDone(){
  netRel(NET.hostPid,{k:'ready',picks:NET.picks});
  show(`<p class="eyebrow">Drop ${G.dropNo} complete</p><h2>Waiting for players…</h2><p class="lede">The next drop starts as soon as everyone has picked.</p>`);
}
function netTogglePause(){
  if(!ov.hidden&&NET.paused){NET.paused=false;hide();return}
  if(ov.hidden&&(G.mode==='play'||G.mode==='count')){NET.paused=true;
    show(`<p class="eyebrow">Drop ${G.dropNo} · ${aliveCount()} alive</p><h2>Menu</h2><p class="lede">The match keeps running while this is open.</p>${buildHTML()}
      <button class="go ghost" data-pf="settings-pause">Settings · Controls</button>
      <div class="row"><button class="go" data-act="resume">Resume</button><button class="go ghost" data-act="menu">Leave match</button></div>`)}
}
// ---------- lag indicator: RTT + packet loss from ping/pong ----------
// NET.pq = recent pings {ts,ok}; a ping older than 3s with no pong counts as lost.
function netPingSent(){
  const ts=Date.now();
  if(!NET.pq)NET.pq=[];
  NET.pq.push({ts,ok:false});if(NET.pq.length>12)NET.pq.shift();
  netSend({t:'ping',ts});
}
function netPongGot(ts,rt){
  NET.pongAt=Date.now();
  if(NET.pq)for(const p of NET.pq)if(p.ts===ts){p.ok=true;break}
  if(rt<10000)NET.rttAvg=NET.rttAvg?NET.rttAvg*.7+rt*.3:rt;
}
function netLagInfo(){
  const now=Date.now();let sent=0,lost=0;
  if(NET.pq)for(const p of NET.pq){const age=now-p.ts;if(age>20000||age<3000)continue;sent++;if(!p.ok)lost++}
  const loss=sent>=3?Math.round(lost/sent*100):0;
  const rtt=Math.round(NET.rttAvg||NET.rtt||0);
  const silent=NET.pongAt&&now-NET.pongAt>4000&&!document.hidden;
  let lvl=0;
  if(rtt>=120||loss>=5)lvl=1;
  if(rtt>=250||loss>=15||silent)lvl=2;
  return{rtt,loss,silent,lvl};
}
// small status line: room, ping, host stalls
const netInfo=document.createElement('div');netInfo.id='netInfo';document.body.appendChild(netInfo);
setInterval(()=>{
  if(!NET.live||ov.hidden===false&&G.mode==='menu'){netInfo.textContent='';return}
  const li=netLagInfo();
  let s=`${NET.code} · ${NET.m==='host'?'HOST · ':''}${li.rtt} ms`;
  if(li.loss>0)s+=` · ${li.loss}% loss`;
  if(li.silent)s+=' · no response';
  else if(li.lvl===2)s+=' · lag!';
  else if(li.lvl===1)s+=' · unstable';
  netInfo.style.color=li.lvl===2?'#ff5a4a':li.lvl===1?'#f5c542':'';
  if(NET.m==='client'&&NET.gotSnap&&performance.now()-NET.lastSnap>1500&&(G.mode==='play'||G.mode==='count'))s+=' · waiting for host…';
  if(NET.m==='host'&&document.hidden)s+=' · keep this tab in front!';
  netInfo.textContent=s;
},500);
window.__net=NET;window.__G=G;window.__G=G;

function update(dt){update0(dt);if(NET.m==='host')netHostTick(dt)}
