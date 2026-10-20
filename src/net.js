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
function netUrl(){let u='';try{u=localStorage.getItem('hordeserver')||''}catch(e){}
  if(u)return u;
  if(location.protocol==='http:'||location.protocol==='https:')return(location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws';
  return'ws://localhost:3000/ws';}

// ---------- connection ----------
function netConnect(then){
  if(NET.ws&&NET.ws.readyState===1){then();return}
  if(NET.ws&&NET.ws.readyState===0)return;
  NET.status='Connecting… the free server can take up to a minute to wake up';netMenu();
  let ws;try{ws=new WebSocket(netUrl())}catch(e){NET.status='';NET.notice='That server address is not valid.';netMenu();return}
  NET.ws=ws;const to=setTimeout(()=>{if(ws.readyState===0){try{ws.close()}catch(_){}}},90000);
  ws.onopen=()=>{clearTimeout(to);NET.status='';then()};
  ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(_){return}netMsg(m)};
  ws.onclose=()=>{clearTimeout(to);if(NET.ws===ws){NET.ws=null;netDropped(NET.status||NET.code||NET.live?'Lost connection to the server.':'Could not reach the server. Check the address under Server.')}};
  ws.onerror=()=>{};
}
setInterval(()=>{if(NET.ws&&NET.ws.readyState===1)netSend({t:'ping',ts:Date.now()})},3000);
function netCleanup(){NET.live=false;NET.m=null;NET.paused=false;NET.zm.clear();NET.inp={};NET.cl={};NET.ready={};NET.acts=[];G.fighters=[];G.P=null;G.bullets=[];G.deploys=[];G.orbs=[];G.fx=[];G.spectating=false;G.pOut=false;G.mode='menu';showHUD(false)}
function netDropped(msg){
  const had=NET.code||NET.live||NET.status;
  NET.code='';NET.role=null;NET.status='';NET.players=[];if(NET.ws){try{NET.ws.onclose=null;NET.ws.close()}catch(_){}NET.ws=null}
  netCleanup();if(had)NET.notice=msg||'Disconnected.';netMenu();
}
function netLeave(){netSend({t:'leave'});if(NET.ws){try{NET.ws.onclose=null;NET.ws.close()}catch(_){}NET.ws=null}NET.code='';NET.role=null;NET.players=[];netCleanup();menu()}
function netMsg(m){
  switch(m.t){
    case'joined':NET.auth=!!m.auth;if(m.cfg)NET.cfg=m.cfg;NET.pid=m.pid;NET.code=m.code;NET.hostPid=m.host;NET.players=m.players;NET.role=m.pid===m.host?'host':'client';NET.notice='';netLobby();break;
    case'players':
      NET.players=m.players;NET.hostPid=m.host;if(m.cfg)NET.cfg=m.cfg;NET.role=NET.pid===m.host?'host':'client';
      if(!m.started&&NET.live){netCleanup();netLobby()}else if(!NET.live)netLobby();break;
    case'left':if(NET.m==='host')netBotify(m.pid);break;
    case'closed':NET.code='';NET.role=null;if(NET.ws){try{NET.ws.onclose=null;NET.ws.close()}catch(_){}NET.ws=null}netCleanup();NET.notice=m.reason||'The room was closed.';netMenu();break;
    case'err':NET.status='';NET.notice=m.msg||'Error';if(NET.code)netLobby();else netMenu();break;
    case'pong':NET.rtt=Math.max(0,Date.now()-m.ts);NET.lag=Math.min(.12,NET.rtt/2000+.03);break;
    case'r':netRecv(m.from,m.d);break;
  }
}
function netRecv(from,d){
  if(!d)return;
  if(NET.m==='host'){
    if(d.k==='i'){const c=NET.cl[from];if(!c)return;let I=NET.inp[from];if(!I)I=NET.inp[from]={acts:[]};
      I.mx=clamp(+d.mx||0,-1,1);I.my=clamp(+d.my||0,-1,1);I.f=+d.f||0;I.fr=d.fr?1:0;if(Array.isArray(d.a)&&I.acts.length<12)for(const a of d.a.slice(0,6))I.acts.push(a);
      if(typeof d.sv==='number')c.sv=d.sv}
    else if(d.k==='ready'){const c=NET.cl[from];if(!c||G.mode!=='between'||NET.ready[from])return;
      if(Array.isArray(d.picks))for(const p of d.picks.slice(0,8))if(Array.isArray(p)&&UP[p[0]])applyUpgrade(c.f,p[0],1);
      c.f.pend=0;NET.ready[from]=true;netHostCheckNext()}
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
  <div class="group"><span class="glabel">Join a friend's room</span><div class="nrow"><input class="nin" id="nCode" maxlength="4" placeholder="CODE" autocomplete="off" style="text-transform:uppercase;letter-spacing:.3em;text-align:center"><button class="go" data-act="n_join">Join</button></div></div>
  <details class="how"><summary>Server address</summary><input class="nin" id="nSrv" placeholder="Leave empty to use this site" value="${esc(srv)}" autocomplete="off"><p class="lede">Only change this if you host the server somewhere else, e.g. wss://your-app.onrender.com/ws</p></details>
  <button class="go ghost" data-act="menu">Back to solo menu</button>`);
}
function netReadForm(){
  const n=$('#nName'),s=$('#nSrv');
  if(n){NET.name=n.value.replace(/[^\w \-.!?]/g,'').trim().slice(0,14);try{localStorage.setItem('hordename',NET.name)}catch(e){}}
  if(s){try{localStorage.setItem('hordeserver',s.value.trim())}catch(e){}}
}
function netCap(){const c=NET.cfg;return c.mode==='duel'?2:c.mode==='team'?4:c.size}
function netSizeChange(v){if(NET.role==='host'){NET.cfg.size=v;const e=$('#nsizeV');if(e)e.textContent=v;clearTimeout(netSizeChange.t);netSizeChange.t=setTimeout(()=>netSend({t:'cfg',mode:NET.cfg.mode,size:v,map:NET.cfg.map}),150)}}
function netLobby(){
  NET.view='lobby';G.mode='menu';G.P=null;showHUD(false);
  const host=NET.role==='host',cfg=NET.cfg,tm=cfg.mode==='team',capN=netCap(),me=NET.players.find(p=>p.pid===NET.pid);
  const tl=t=>t===1?'Team B':'Team A';
  show(`<p class="eyebrow">Room code · ${NET.players.length}/${capN} players · ${MODES[cfg.mode]}${cfg.mode==='br'?' · '+cfg.size+' fighters':''}</p><h1 style="letter-spacing:.25em;font-size:56px">${esc(NET.code)}</h1>
  ${NET.notice?`<p class="lede" style="color:var(--foe)">${esc(NET.notice)}</p>`:''}
  <p class="lede">${host?(NET.auth?'Share the code with friends. Empty slots are filled with bots when you start.':'Share the code with friends. Empty slots are filled with bots when you start. Keep this tab open and in front: the match runs in your browser.'):'Waiting for the room leader to start the match.'}</p>
  <div class="tbl">${NET.players.map(p=>`<div class="tr${p.pid===NET.pid?' me':''}"><span>${p.pid===NET.hostPid?'★':''}</span><span>${esc(p.name)}</span><span>${tm?tl(p.team)+' · ':''}${CHARS[p.weapon]?CHARS[p.weapon].name:''}</span></div>`).join('')}</div>
  ${tm&&me?`<div class="group"><span class="glabel">Your team</span><div class="seg"><button data-act="n_team" data-v="0" aria-pressed="${me.team!==1}">Team A</button><button data-act="n_team" data-v="1" aria-pressed="${me.team===1}">Team B</button></div></div>`:''}
  ${host?`<div class="group"><span class="glabel">Mode</span><div class="seg">${Object.entries(MODES).map(([k,v])=>`<button data-act="n_mode" data-v="${k}" aria-pressed="${cfg.mode===k}">${v}</button>`).join('')}</div></div>
  <div class="group"><span class="glabel">Map</span><div class="seg" style="grid-template-columns:repeat(4,1fr)">${[['random','Random'],...Object.entries(MAPS).map(([k,v])=>[k,v.name])].map(([k,v])=>`<button data-act="n_map" data-v="${k}" aria-pressed="${(cfg.map||'random')===k}">${v}</button>`).join('')}</div></div>
  ${cfg.mode==='br'?`<div class="group"><span class="glabel">Lobby size · <b id="nsizeV">${cfg.size}</b> fighters (empty slots are bots)</span><input class="nin" type="range" id="nsize" min="${Math.max(2,NET.players.length)}" max="16" value="${cfg.size}" style="padding:6px"></div>`:`<p class="lede">${cfg.mode==='duel'?'1v1: a small arena with a light zombie horde. First to 3 round wins.':'2v2: two teams of two, pick yours above. Bots fill empty team slots. Allies cannot hurt each other.'}</p>`}
  <div class="group"><span class="glabel">Bot skill</span><div class="seg">${Object.keys(DIFF).map(k=>`<button data-act="diff" data-v="${k}" aria-pressed="${G.diff===k}">${cap(k)}</button>`).join('')}</div></div>`:''}
  <details class="how"><summary>Change character</summary>${wepGrid()}</details>
  ${host?'<button class="go" data-act="n_start">Start match</button>':''}
  <button class="go ghost" data-act="n_leave">Leave room</button>`);
}
function netAct2(act,v){
  switch(act){
    case'n_quick':netReadForm();NET.notice='';netConnect(()=>netSend({t:'quick',name:NET.name,weapon:G.pick}));break;
    case'n_create':netReadForm();NET.notice='';netConnect(()=>netSend({t:'create',name:NET.name,weapon:G.pick}));break;
    case'n_join':{netReadForm();const c=($('#nCode').value||'').trim().toUpperCase();if(c.length!==4){NET.notice='Enter the 4 letter room code.';netMenu();break}NET.notice='';netConnect(()=>netSend({t:'join',code:c,name:NET.name,weapon:G.pick}));break}
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
function netDropInfo(){const fs=G.fighters.slice(0,N_FIGHT);return{map:MAPID,dn:G.dropNo,sc:G.sc,ups:fs.map(f=>f.ups),pos:fs.map(f=>[Math.round(f.x),Math.round(f.y),q2(f.facing)])}}
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
  netBuild(NET.players.slice(),NET.cfg,NET.pid);
  G.P=G.fighters.find(f=>f.pid===NET.pid)||G.fighters[0];G.dropNo=1;NET.m='host';NET.live=true;NET.resDn=-1;NET.pts=null;NET.paused=false;
  startDrop();
  netRel('*',{k:'start',ros:netRoster(),cfg:G.cfg,diff:G.diff,drop:netDropInfo()});
}
function netSrvStart(pl,diff,cfg){
  NET.srv=true;NET.pid=0;NET.hostPid=0;NET.snapMs=50;if(DIFF[diff])G.diff=diff;
  G.debug=false;G.zmode=false;NET.inp={};NET.ready={};NET.ev=[];NET.evBase=0;
  netBuild(pl,cfg||NET.cfg,0);
  G.P=G.fighters[0];G.dropNo=1;NET.m='host';NET.live=true;NET.resDn=-1;NET.pts=[];NET.paused=false;
  startDrop();
  netRel('*',{k:'start',ros:netRoster(),cfg:G.cfg,diff:G.diff,drop:netDropInfo()});
}
function netHumans(){return Object.keys(NET.cl).length}
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
    else if(a[0]==='m'&&f.weapon==='revolver'){
      const wx=+a[1],wy=+a[2],ang=Math.atan2(wy-f.y,wx-f.x),d=Math.min(MOLO_R,Math.hypot(wx-f.x,wy-f.y)),w=Math.max(0,Math.min(d,rayCast(f.x,f.y,ang,d+30)-10));
      f.facing=ang;f.throwTarget={x:f.x+Math.cos(ang)*w,y:f.y+Math.sin(ang)*w};useAbility(f);f.throwTarget=null}
    else if(a[0]==='r'){if(f.reloadT<=0&&f.ammo<f.st.clip)f.reloadT=f.st.reload}
  }
}
// ---------- host: between-drop flow ----------
function netBroadcastRes(){
  const fs=G.fighters.slice(0,N_FIGHT),fin=fs.some(f=>f.wins>=WIN_DROPS),st=fs.map(f=>[f.wins,f.pts,f.kills,f.place,f.dropKills,f.level]);
  NET.ready={};if(NET.srv)NET.ready[NET.pid]=true;NET.betT=performance.now()+50000;
  for(const pid in NET.cl){const f=NET.cl[pid].f;netRel(+pid,{k:'res',dn:G.dropNo,fin,w:G.winner?G.winner.id:0,st,pk:fin?0:(f.pend||0)+1,reel:fin?reelGet():undefined})}
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
  const _feed=feedAdd;feedAdd=function(t,h){_feed(t,h);if(NET.m==='host')evt({e:'f',m:t,all:1})};
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
  c.n=(c.n||0)+1;
  let Z;
  if(c.n%2===0){Z=[];const ZR2=780*780;
    for(let i=N_FIGHT;i<fs.length;i++){const z=fs[i];if(!z.zomb||!z.alive)continue;const dx=z.x-cx,dy=z.y-cy;
      if(dx*dx+dy*dy<ZR2)Z.push(z.id*8+Math.max(0,ZKS.indexOf(z.zk)),Math.round(z.x),Math.round(z.y),Math.round(z.facing*10),Math.max(1,Math.round(z.hp/z.zhp*100))+101*Math.min(1,Math.round(z.hitFlash*10))+202*Math.min(3,Math.round(z.swingT*10)))}}
  const B=[];for(const b of G.bullets){const dx=b.x-cx,dy=b.y-cy;if(dx*dx+dy*dy<1000*1000)B.push([b.owner.id,Math.round(b.x),Math.round(b.y),Math.round(b.vx),Math.round(b.vy),Math.round(b.r*10),b.expl?1:0])}
  let O;if(c.n%4===1){O=[];for(const o of G.orbs){const dx=o.x-cx,dy=o.y-cy;if(dx*dx+dy*dy<1100*1100)O.push([Math.round(o.x),Math.round(o.y),Math.round(o.t%100),Math.max(0,ITM.indexOf(o.item))])}}
  let M;if(c.n%4===3||c.n<3)M=DYN.map(r=>r.x<0?0:Math.max(1,Math.ceil(r.hp)));
  const D=[];for(const d of G.deploys){const dx=d.x-cx,dy=d.y-cy;if(dx*dx+dy*dy>1100*1100)continue;
    const o={};for(const k in d){const v=d[k];if(k==='owner')o.oid=v.id;else if(typeof v==='number')o[k]=q2(v);else if(typeof v==='string'||typeof v==='boolean')o[k]=v}D.push(o)}
  const E=[];const from=Math.max(0,c.evi-NET.evBase);
  for(let i=from;i<NET.ev.length;i++){const e=NET.ev[i];
    if(e.only&&e.only.indexOf(f.id)<0)continue;
    if(!e.all&&(e.x-cx)*(e.x-cx)+(e.y-cy)*(e.y-cy)>1500*1500)continue;E.push(e)}
  c.evi=NET.evBase+NET.ev.length;
  return{k:'s',T:q2(G.time),m:MODEC[G.mode]||0,cd:q2(G.countdown),et:q2(G.endT),w:G.winner?G.winner.id:-1,me:[f.alive?1:0,...enc(f,FK),...enc(f,XK)],F,Z,B,O,M,D,bo:G.bo?[G.bo.s,q2(G.bo.t)]:0,E:E.length>70?E.slice(-70):E};
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
  NET.m='client';NET.live=true;NET.acts=[];NET.zm.clear();NET.paused=false;NET.gotSnap=false;
  G.debug=false;G.zmode=false;if(DIFF[d.diff])G.diff=d.diff;G.fighters=[];setupMode(d.cfg);
  d.ros.forEach((r,i)=>{const f=makeFighter(i,r[2]);f.name=r[1];f.pid=r[0];f.isAI=r[0]!==NET.pid;if(r[3]>=0)f.team=r[3];f.pend=0;f.tx=f.x;f.ty=f.y;f.tf=0;G.fighters.push(f);if(r[0]===NET.pid)NET.my=i});
  G.P=G.fighters[NET.my];G.P.isAI=false;G.dropNo=1;
  netApplyDrop(d.drop);
}
function netApplyDrop(d){
  const fs=G.fighters.slice(0,N_FIGHT);
  G.fighters=fs;NET.zm.clear();
  fs.forEach((f,i)=>{f.ups=d.ups[i]||{};computeStats(f);Object.assign(f,{alive:true,hp:mhp(f),place:0,dropKills:0,ammo:f.st.clip,reloadT:0,dashT:0,jumpT:0,healT:0,shield:0,cloakT:0,burnT:0,slowT:0,markT:0,armor:0,band:0,kit:0,pend:0,down:0,downT:0,revP:0,finP:0,tagT:0,zoom:0,zoomK:0,litT:0,fenceT:0,fenceN:0,x:d.pos[i][0],y:d.pos[i][1],facing:d.pos[i][2],mv:{x:0,y:0},wantFire:false,vx:0,vy:0});
    f.tx=f.x;f.ty=f.y;f.tf=f.facing});
  if(d.map&&d.map!==MAPID)setMap(d.map);mapReset();G.dropNo=d.dn;G.sc=d.sc;G.st=storm(0);G.bullets=[];G.deploys=[];G.orbs=[];G.fx=[];G.feed=[];G.time=0;G.pending=0;G.molo=0;G.afterPick=false;G.pOut=false;G.elimT=0;G.spectating=false;G.spec=null;G.ff=false;G.winner=null;
  G.cam={x:G.P.x,y:G.P.y};NET.gotSnap=false;NET.hpPrev=G.P.hp;NET.pk=0;NET.picks=[];
  SFX.drop();G.mode='count';G.countdown=3.2;hide();showHUD(true);
}
function netApplySnap(d){
  if(!NET.live||NET.m!=='client'||!G.P)return;
  const P=G.P,fs=G.fighters;NET.lastSnap=performance.now();NET.gotSnap=true;
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
    if(!P.alive||Math.hypot(P.tx-P.x,P.ty-P.y)>140){P.x=P.tx;P.y=P.ty}else{P.x+=(P.tx-P.x)*.18;P.y+=(P.ty-P.y)*.18}
    if(P.alive&&P.hp<hp0-1.2&&performance.now()-NET.hurtT>150){NET.hurtT=performance.now();SFX.hurt()}
  }
  // others
  for(const t of d.F){const f=fs[t[0]];if(!f||f===P)continue;f.alive=!!t[1];
    if(t[2]){
      for(let i=0;i<FK.length;i++){const k=FK[i],v=t[3+i];
        if(k==='x'||k==='y'||k==='facing')continue;
        if(k==='healKind'){f.healKind=v===1?'band':v===2?'kit':null;continue}
        f[k]=v}
      f.tx=t[3];f.ty=t[4];f.tf=t[5];if(!f.known||!f.alive){f.x=f.tx;f.y=f.ty;f.facing=f.tf}f.known=true;
    }else{f.tx=t[3];f.ty=t[4];f.known=false;f.x=f.tx;f.y=f.ty;if(t.length>5){f.hp=t[5];f.tagT=t[6];f.tagBy=t[7]}}
    if(!f.alive){f.x=f.tx;f.y=f.ty}
  }
  // zombies (sent every other snapshot)
  if(d.Z){
    const seen=new Set(),Z=d.Z;
    for(let i=0;i<Z.length;i+=5){const id=Z[i]>>3,kc=Z[i]&7,a=Z[i+4];let z=NET.zm.get(id);
      if(!z){z=netMkZ(id,kc);NET.zm.set(id,z);fs.push(z);z.x=Z[i+1];z.y=Z[i+2];z.facing=Z[i+3]/10}
      seen.add(id);z.tx=Z[i+1];z.ty=Z[i+2];z.tf=Z[i+3]/10;z.zhp=100;z.hp=a%101;z.hitFlash=(Math.floor(a/101)%2)*.1;z.swingT=Math.floor(a/202)*.1}
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
function netMapApply(M){
  for(let i=0;i<DYN.length&&i<M.length;i++){const r=DYN[i],v=M[i];
    if(v===0){if(r.x>=0){dynPark(r);if(r.door){r.on=false;r.broken=true}else r.gone=true}}
    else{if(r.x<0){r.x=r.ox;r.y=r.oy}if(r.door)r.on=true;r.hp=v}}
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
    case'f':feedAdd(e.m,!!(P&&e.m.indexOf(P.name)>=0));break;
    case'n':{const t=fById(e.t);if(!t)break;const mine=e.t===NET.my;addNum(t,e.v,mine?COL.foe:COL.you);break}
    case'k':{const f=fById(e.id);if(!f)break;f.alive=false;f.place=e.pl;
      if(e.id===NET.my){G.spectating=true;G.pOut=true;G.elimT=1.7;try{navigator.vibrate&&navigator.vibrate([40,40,80])}catch(_){}}break}
  }
}
const DECAY=['muzzle','swingT','hitFlash','parryT','rdT','inv','dashCD','healT','shF','hurtT','cloakT','burnT','slowT','markT','dashT','reloadT','swingT','pingT','tagT','scanWarn','litT','fenceT','downT'];
function netClientUpdate(dt){
  const P=G.P,fs=G.fighters;
  if(G.mode==='count'){G.countdown-=dt;if(G.countdown<=0&&NET.gotSnap)G.mode='play'}
  else if(G.mode==='play'||G.mode==='ending')G.time+=dt;
  for(let i=0;i<fs.length;i++){const f=fs[i];
    f.t+=dt;for(const k of DECAY)if(f[k]>0)f[k]=Math.max(0,f[k]-dt);
    if(f.zomb)f.pulse+=dt;
    if(f===P||!f.alive||f.tx===undefined)continue;
    const dx=f.tx-f.x,dy=f.ty-f.y;
    if(dx*dx+dy*dy>40000){f.x=f.tx;f.y=f.ty}else{const k=Math.min(1,dt*14);f.x+=dx*k;f.y+=dy*k}
    if(f.tf!==undefined)f.facing=turnToward(f.facing,f.tf,(f.zomb?6:18)*dt);
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
    if(keys.has('KeyR')&&performance.now()-NET.keyR>400){NET.keyR=performance.now();NET.acts.push(['r'])}
  }else{dashQueued=false;abQueued=false;healQueued=null;zoomQueued=false}
  p.mv={x:mx,y:my};p.wantFire=fire&&!p.down;
}
function netSendInput(){
  const P=G.P;if(!P||NET.m!=='client')return;
  netRel(NET.hostPid,{k:'i',mx:q2(P.mv.x),my:q2(P.mv.y),f:q2(P.facing),fr:P.wantFire?1:0,a:NET.acts,sv:(G.spec&&!P.alive)?G.spec.id:-1});
  NET.acts=[];
}
function netClientResults(d){
  const fs=G.fighters.slice(0,N_FIGHT),P=G.P;
  d.st.forEach((s,i)=>{const f=fs[i];f.wins=s[0];f.pts=s[1];f.kills=s[2];f.place=s[3];f.dropKills=s[4];f.level=s[5]});
  G.winner=fs[d.w];G.reel=d.reel||null;G.mode=d.fin?'over':'between';G.pickCtx='between';NET.pk=d.pk;NET.tot=d.pk;NET.picks=[];G.pending=0;
  if(d.fin){
    showHUD(false);const champ=standings()[0];
    show(`<p class="eyebrow">Match over</p><h2>${champ===P?'You win the match':isAlly(champ,P)?'Your team wins the match':esc(champ.name)+' wins the match'}</h2>
      <p class="lede">You placed #${P.place} in the last drop.</p>${standingsHTML(8)}${buildHTML()}
      <p class="lede">${NET.role==='host'?'Start another match with the same players and settings.':'Waiting for the room leader to start a rematch.'}</p><div class="row">${netEndRow()}</div>`);
    if(G.reel)setTimeout(()=>{if(G.mode==='over'&&!REEL.on)reelOpen()},900);
    return;
  }
  netShowOffers(true);
}
function netShowOffers(first){
  const P=G.P,o=offers(P,3);
  if(!o.length){netClientDone();return}
  const won=G.winner===P;
  show(`<p class="eyebrow">Drop ${G.dropNo} complete</p><h2>${first?(won?'You won the drop':'Drop over'):'Pick another upgrade'}</h2>
    ${first?`<p class="lede">${won?'Last one standing':'You placed #'+P.place+' of '+N_FIGHT+' with '+P.dropKills+' kill'+(P.dropKills===1?'':'s')}. First to ${WIN_DROPS} drop wins takes the match.</p>${standingsHTML(5)}`:''}
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
// small status line: room, ping, host stalls
const netInfo=document.createElement('div');netInfo.id='netInfo';document.body.appendChild(netInfo);
setInterval(()=>{
  if(!NET.live||ov.hidden===false&&G.mode==='menu'){netInfo.textContent='';return}
  let s=`${NET.code} · ${NET.m==='host'?'HOST':NET.rtt+' ms'}`;
  if(NET.m==='client'&&NET.gotSnap&&performance.now()-NET.lastSnap>1500&&(G.mode==='play'||G.mode==='count'))s+=' · waiting for host…';
  if(NET.m==='host'&&document.hidden)s+=' · keep this tab in front!';
  netInfo.textContent=s;
},500);
window.__net=NET;window.__G=G;window.__G=G;

function update(dt){update0(dt);if(NET.m==='host')netHostTick(dt)}
