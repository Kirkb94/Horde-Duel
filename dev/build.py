import re,sys,os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE=os.environ.get('BASE',os.path.join(ROOT,'dev','base.html'))
OUT=os.environ.get('OUT',os.path.join(ROOT,'build','index.html'))
if not os.path.exists(BASE):
    sys.exit('build.py: base file not found: '+BASE+'\nCommit the pre-net base page as dev/base.html or set BASE=<path>. Output goes to build/index.html (or OUT=<path>); it never overwrites public/index.html by default.')
src=open(BASE).read()
def rep(old,new,cnt=1):
    global src
    n=src.count(old)
    assert n==cnt,(n,old[:80])
    src=src.replace(old,new)
rep("function near(x,y){return Math.abs(x-G.cam.x)<720","function near(x,y){if(NET.m==='host')return netNear(x,y);return Math.abs(x-G.cam.x)<720")
rep("function controlPlayer(dt){\n  const p=G.P;let mx=0,my=0;p.tgtPt=null;","function controlPlayer(dt){\n  const p=G.P;let mx=0,my=0;p.tgtPt=null;\n  if(NET.m==='host'&&!ov.hidden){p.mv={x:0,y:0};p.wantFire=false;dashQueued=false;abQueued=false;healQueued=null;return}")
rep("else{G.pending++;feedAdd(`Level","else if(f.remote){f.pend=(f.pend||0)+1}else{G.pending++;feedAdd(`Level")
rep("if(t===G.P&&!G.debug&&b&&amt>0){t.hurtA=Math.atan2(-b.vy,-b.vx);t.hurtT=0.7;const now=performance.now();if(now-lastBuzz>120)","if((t===G.P||t.remote)&&!G.debug&&b&&amt>0){t.hurtA=Math.atan2(-b.vy,-b.vx);t.hurtT=0.7;const now=performance.now();if(t===G.P&&now-lastBuzz>120)")
rep("    if(!dot&&(G.debug||src===G.P||t===G.P))addNum(","    if(NET.m==='host'&&!dot&&(t.remote||src.remote))netNumEv(t,full,src);\n    if(!dot&&(G.debug||src===G.P||t===G.P))addNum(")
rep("const a=Math.atan2(wy-P.y,wx-P.x),d=Math.min(MOLO_R,","if(NET.m==='client'){NET.acts.push(['m',Math.round(wx),Math.round(wy)]);G.molo=0;return}\n  const a=Math.atan2(wy-P.y,wx-P.x),d=Math.min(MOLO_R,")
rep("if(G.mode==='paused'&&has('pause'))togglePause();","if((G.mode==='paused'||NET.paused)&&has('pause'))togglePause();")
rep('<button class="go" data-act="start">Start match</button>','<button class="go" data-act="start">Start match</button>\n  <button class="go ghost" data-act="online">Play online · up to 16 players</button>')
rep("function togglePause(){","function togglePause(){if(NET.m){netTogglePause();return}")
rep("if(document.hidden&&(G.mode==='play'||G.mode==='count'))togglePause()","if(document.hidden&&!NET.m&&(G.mode==='play'||G.mode==='count'))togglePause()")
rep("case 'menu':menu();break;","case 'menu':if(NET.code||NET.m){netLeave();break}menu();break;")
rep("case 'wep':G.pick=v;save();","case 'wep':G.pick=v;save();if(NET.code)netSend({t:'upd',weapon:v});")
rep("    case 'zombies':startZombies();break;","    case 'zombies':startZombies();break;\n    case 'online':netMenu();break;\n    case 'n_quick':case 'n_create':case 'n_join':case 'n_start':case 'n_leave':case 'n_lobby':case 'n_rematch':case 'n_mode':case 'n_map':case 'n_team':netAct2(b.dataset.act,v);break;")
rep("case 'spec':G.mode='play';hide();break;","case 'spec':if(!NET.m)G.mode='play';hide();break;")
rep("    case 'pick':\n      if(v)applyUpgrade(G.P,v,+b.dataset.m||1);","    case 'pick':\n      if(NET.m==='client'){netClientPick(v,+b.dataset.m||1);break}\n      if(v)applyUpgrade(G.P,v,+b.dataset.m||1);")
rep("if(G.pickCtx==='between'){for(const f of G.fighters)if(f.isAI)aiPick(f);G.dropNo++;startDrop()}","if(G.pickCtx==='between'){if(NET.m==='host'){netHostOwnPicked();break}for(const f of G.fighters)if(f.isAI)aiPick(f);G.dropNo++;startDrop()}")
rep("function update(dt){\n  if((sticks.move||sticks.aim)&&!PLAT.pc&&!phoneUI())clearSticks();\n  for(let i=G.fx.length-1","function update0(dt){\n  if((sticks.move||sticks.aim)&&!PLAT.pc&&!phoneUI())clearSticks();\n  for(let i=G.fx.length-1")
rep("  if(!G.P)return;\n  SFX.tick(dt);","  if(!G.P)return;\n  SFX.tick(dt);\n  if(NET.m==='client'){netClientUpdate(dt);return}")
rep("if(f===P&&!G.debug)controlPlayer(dt);else if(f.zomb)controlHorde(f,dt);","if(f.remote)controlRemote(f,dt);else if(f===P&&!G.debug&&!NET.srv)controlPlayer(dt);else if(f.zomb)controlHorde(f,dt);")
rep("if(t===G.P&&!G.debug){G.spectating=true","if(t===G.P&&!G.debug&&!NET.srv){G.spectating=true")
rep("G.mode='elim';\n  show(","if(!NET.m)G.mode='elim';\n  show(")
rep('<button class="go ghost" data-act="skip">Skip ahead</button></div>`);','${NET.m?\'<button class="go ghost" data-act="menu">Leave match</button>\':\'<button class="go ghost" data-act="skip">Skip ahead</button>\'}</div>`);')
rep("for(let i=0;i<steps;i++)update(dt);","const st2=(NET.m==='host'&&G.mode==='play'&&netNoHumans())?4:(NET.m?1:steps);for(let i=0;i<st2;i++)update(dt);")
rep("(G.ff?'1×':'SKIP'))","(NET.m?'NEXT':(G.ff?'1×':'SKIP')))")
rep("else if(G.spectating)G.ff=!G.ff;else dashQueued=true","else if(G.spectating){if(NET.m)pickSpec(1);else G.ff=!G.ff}else dashQueued=true")
css=""".nin{width:100%;box-sizing:border-box;background:var(--void);color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:12px;font:600 16px var(--mono)}
.nin:focus{outline:2px solid var(--you);outline-offset:0}
.nrow{display:flex;gap:8px}.nrow .nin{flex:1}.nrow .go{flex:0 0 auto;padding:12px 22px}
#netInfo{position:fixed;top:4px;left:50%;transform:translateX(-50%);font:600 11px var(--mono);color:var(--muted);z-index:9;pointer-events:none;letter-spacing:.06em;text-shadow:0 1px 2px #000}
</style>"""
i=src.index("</style>");src=src[:i]+css+src[i+8:]
net=open(os.path.join(ROOT,'src','net.js')).read()
mark="pfInit();resize();menu();requestAnimationFrame(frame);"
rep(mark,net+"\nif(window.__SIM){window.__SIM.api={start:netSrvStart,tick:update,recv:netRecv,botify:netBotify,rejoin:netRejoin,resync:netResync,humans:netHumans,NET,G};}else{"+mark.replace('requestAnimationFrame(frame);','requestAnimationFrame(frame);netResume();')+"}")
rep("<title>","<title>Online · ") if False else None
import os
if os.environ.get('TEST'):
    src=src.replace('window.__G=G;','window.__G=G;window.__T={damage,eliminate,netSnapFor,tryDash,startHeal};')
    os.makedirs(os.path.dirname(OUT),exist_ok=True)
    open(os.environ.get('TEST_OUT',os.path.join(os.path.dirname(OUT),'test.html')),'w').write(src)
else:
    src=src.replace('window.__G=G;','')
    HEAD='<!doctype html>\n<html lang="en"><head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">\n<meta name="mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n<meta name="theme-color" content="#020403">\n'
    src=HEAD+src
    os.makedirs(os.path.dirname(OUT),exist_ok=True)
    open(OUT,'w').write(src)
print('built',len(src))
