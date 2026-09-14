"use strict";
/* ---------------- TOP TABS, WORKSPACE, SPLIT PANES ---------------- */
const MAX_PANES=4;
const tabById=id=>S.tabs.find(t=>t.id===id)||null;
const groupById=id=>S.groups.find(g=>g.id===id)||null;
function activeGroup(){return S.active?groupById(S.active):null;}
function groupOfTab(tabId){return S.groups.find(g=>g.kind==='term'&&g.panes.includes(tabId))||null;}
// Existing code reads tab.on as "this terminal is the one in front".
function syncOn(){const g=activeGroup();S.tabs.forEach(t=>{t.on=!!(g&&g.kind==='term'&&g.focus===t.id);});}
function liveSshTab(t){return !!(t&&!t.local&&t.connId&&!t.closed);}
function focusedSshTab(){const g=activeGroup();const t=g&&g.kind==='term'?tabById(g.focus):null;return liveSshTab(t)?t:null;}

function addTermGroup(tab){
  const g={id:uid('g'),kind:'term',panes:[tab.id],sizes:[1],dir:'row',focus:tab.id};
  S.groups.push(g);
  activateGroup(g.id);
  return g;
}
function activateGroup(id){
  if(id&&!groupById(id))id=null;
  S.active=id;
  const g=activeGroup();
  if(g)g.usedAt=Date.now();
  closeNewMenu();
  renderTabs();
  if(g&&g.kind==='term'){requestAnimationFrame(()=>{fitActiveXterm();termFocus();});pollStatsSoon();}
}
window.activateGroup=activateGroup;
function activateLastTerm(){
  const list=S.groups.filter(g=>g.kind==='term');
  if(!list.length){go('sessions');toast('Открытых терминалов нет — подключитесь к сессии или откройте локальный shell','info','Терминал');return;}
  activateGroup(list.reduce((a,b)=>(b.usedAt||0)>(a.usedAt||0)?b:a).id);
}
function cycleTopTab(dir){
  const ids=[null].concat(S.groups.map(g=>g.id));
  const i=ids.indexOf(S.active);
  activateGroup(ids[(i+dir+ids.length)%ids.length]);
}
function openTab(tabId){
  const g=groupOfTab(tabId);if(!g)return;
  g.focus=tabId;activateGroup(g.id);
}
window.openTab=openTab;
function focusPane(tabId,quiet){
  const g=groupOfTab(tabId);if(!g||g.focus===tabId)return;
  g.focus=tabId;syncOn();
  $$('#ws .pane').forEach(p=>p.classList.toggle('focus',p.dataset.tab===tabId&&g.panes.length>1));
  renderStrip();
  if(!quiet)termFocus();
}
function removeGroup(gid){
  const i=S.groups.findIndex(g=>g.id===gid);if(i<0)return;
  S.groups.splice(i,1);
  if(S.active===gid){const n=S.groups[i]||S.groups[i-1];S.active=n?n.id:null;}
}
function removeLeaf(tabId){
  const g=groupOfTab(tabId);if(!g)return;
  const i=g.panes.indexOf(tabId);
  g.panes.splice(i,1);g.sizes.splice(i,1);
  if(!g.panes.length){removeGroup(g.id);return;}
  if(g.focus===tabId)g.focus=g.panes[Math.min(i,g.panes.length-1)];
}
function insertLeaf(g,tabId,targetId,edge){
  if(g.panes.length===1)g.dir=(edge==='left'||edge==='right')?'row':'col';
  const ti=g.panes.indexOf(targetId);
  const at=ti+((edge==='right'||edge==='bottom')?1:0);
  const half=(g.sizes[ti]||1)/2;
  g.sizes[ti]=half;
  g.panes.splice(at,0,tabId);g.sizes.splice(at,0,half);
  g.focus=tabId;
}
function mergeGroup(srcId,targetTabId,edge){
  const src=groupById(srcId),g=groupOfTab(targetTabId);
  if(!src||!g||src===g||src.kind!=='term'||src.panes.length!==1)return;
  if(g.panes.length>=MAX_PANES){toast('В одной вкладке помещается до '+MAX_PANES+' панелей','warn','Разделение');return;}
  S.groups.splice(S.groups.indexOf(src),1);
  insertLeaf(g,src.panes[0],targetTabId,edge);
  S.active=g.id;
}
function movePane(tabId,targetTabId,edge){
  const g=groupOfTab(tabId);if(!g||tabId===targetTabId||!g.panes.includes(targetTabId))return;
  const i=g.panes.indexOf(tabId);
  g.panes.splice(i,1);g.sizes.splice(i,1);
  insertLeaf(g,tabId,targetTabId,edge);
  const sum=g.sizes.reduce((a,b)=>a+b,0);g.sizes=g.sizes.map(()=>sum/g.sizes.length);
}
function detachPane(tabId,index){
  const g=groupOfTab(tabId);if(!g||g.panes.length<2)return;
  const i=g.panes.indexOf(tabId);
  g.panes.splice(i,1);g.sizes.splice(i,1);
  if(g.focus===tabId)g.focus=g.panes[Math.min(i,g.panes.length-1)];
  const ng={id:uid('g'),kind:'term',panes:[tabId],sizes:[1],dir:'row',focus:tabId,fresh:true};
  const at=index==null?S.groups.indexOf(g)+1:index;
  S.groups.splice(at,0,ng);
  renderTabs();
}
function moveGroup(gid,index){
  const from=S.groups.findIndex(g=>g.id===gid);if(from<0)return;
  const [g]=S.groups.splice(from,1);
  if(from<index)index--;
  S.groups.splice(Math.max(0,Math.min(index,S.groups.length)),0,g);
}
async function closeGroup(gid){
  const g=groupById(gid);if(!g)return;
  if(g.kind==='sftp'){removeGroup(gid);renderTabs();return;}
  if(g.panes.length===1){closeTab(g.panes[0]);return;}
  const live=g.panes.map(tabById).filter(t=>t&&(t.local?!t.exited:!t.closed));
  if(live.length){
    const ok=await confirmModal({title:'Закрыть вкладку?',icon:'x',ok:'Закрыть все',
      text:'Во вкладке '+g.panes.length+' панели: '+g.panes.map(id=>'«<b>'+esc((tabById(id)||{}).name||'')+'</b>»').join(', ')+'. Оболочки будут завершены, соединения разорваны.'});
    if(!ok)return;
  }
  for(const id of g.panes.slice())await closeTab(id,true);
}

/* ---- tab strip in the title bar ---- */
function groupLabel(g){
  if(g.kind==='sftp'){const t=S.tabs.find(x=>!x.local&&x.connId===g.connId);return 'SFTP · '+(t?t.name:(g.name||''));}
  return g.panes.map(id=>(tabById(id)||{}).name||'').join(' │ ');
}
function groupState(g){
  if(g.kind==='sftp')return S.tabs.some(t=>liveSshTab(t)&&t.connId===g.connId)?'on':'err';
  const ts=g.panes.map(tabById).filter(Boolean);
  if(ts.some(t=>t.local?t.exited:t.closed))return 'err';
  return 'on';
}
function renderStrip(){
  if(drag&&drag.started){drag.dirty=true;return;}
  const box=$('#tabStrip');if(!box)return;
  $('#logo').classList.toggle('on',S.active===null);
  box.innerHTML=S.groups.map((g,i)=>{
      const t=g.kind==='term'?tabById(g.focus):null;
      const o=t&&!t.local?osOf(t.os):null;
      const ico=g.kind==='sftp'?IC('folder'):g.panes.length>1?IC('split'):IC(o?o.icon:'terminal');
      const color=g.kind==='sftp'?'var(--accent-2)':o?o.color:'var(--info)';
      const cls='stab'+(S.active===g.id?' on':'')+(g.fresh?' fresh':'');
      g.fresh=false;
      return '<div class="'+cls+'" data-gid="'+g.id+'" style="--osc:'+color+'" title="'+esc(groupLabel(g))+(i<8?' (Alt+'+(i+2)+')':'')+'">'+
        '<span class="stab-ico">'+ico+'<i class="stab-dot '+groupState(g)+'"></i></span>'+
        '<span class="stab-t">'+esc(groupLabel(g))+'</span>'+
        (g.kind==='term'&&g.panes.length>1?'<span class="stab-n">'+g.panes.length+'</span>':'')+
        '<button class="stab-x" data-close-gid="'+g.id+'" title="Закрыть">'+IC('x')+'</button></div>';
    }).join('')+
    '<button class="stab-add" id="tabAdd" title="Новое подключение или локальный shell">'+IC('plus')+'</button>';
}
function renderTabs(){
  updateBadges();
  renderStrip();
  renderWorkspace();
  renderLocalStrip();
}
window.renderTabs=renderTabs;
function refreshTab(t){
  if(!S.tabs.includes(t))return;
  renderStrip();
  if(t.local)renderLocalStrip();
  const g=groupOfTab(t.id);
  const head=document.querySelector('#ws .pane-head[data-tab="'+t.id+'"]');
  if(head&&g&&g===activeGroup())head.innerHTML=paneHeadInner(g,t);
}
const stripEl=$('#tabStrip');
stripEl.addEventListener('pointerdown',e=>{
  if(e.target.closest('.stab-x,.stab-add'))return;
  const el=e.target.closest('.stab');if(!el)return;
  if(e.button===1){e.preventDefault();return;}
  beginDrag(e,{type:'group',gid:el.dataset.gid},el);
});
stripEl.addEventListener('click',e=>{
  const x=e.target.closest('[data-close-gid]');
  if(x){e.stopPropagation();closeGroup(x.dataset.closeGid);return;}
  if(e.target.closest('#tabAdd'))toggleNewMenu();
});
stripEl.addEventListener('auxclick',e=>{
  const el=e.target.closest('.stab[data-gid]');
  if(e.button===1&&el&&el.dataset.gid){e.preventDefault();closeGroup(el.dataset.gid);}
});
stripEl.addEventListener('wheel',e=>{if(Math.abs(e.deltaY)>Math.abs(e.deltaX)){stripEl.scrollLeft+=e.deltaY;e.preventDefault();}},{passive:false});

/* ---- «+» menu: new session, local shells, saved sessions ---- */
const newMenu=$('#newMenu');
function toggleNewMenu(){newMenu.hidden?openNewMenu():closeNewMenu();}
function openNewMenu(){
  const btn=$('#tabAdd');if(!btn)return;
  const shells=Object.keys(SHELL_NAMES).filter(k=>shellInfo.available[k]);
  const list=S.sessions.slice().sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  $('#nmShells').innerHTML=shells.map(k=>'<button class="nm-item" data-shell="'+k+'">'+IC('terminal')+'<span>'+SHELL_NAMES[k]+'</span>'+(k===S.shell?'<small>по умолчанию</small>':'')+'</button>').join('');
  $('#nmSessions').innerHTML=list.length?list.map(s=>{const o=osOf(s.os);
    return '<button class="nm-item" data-sid="'+s.id+'" style="--osc:'+o.color+'"><span class="nm-os">'+IC(o.icon)+'</span><span>'+esc(s.name)+'<small class="mono">'+esc(s.user+'@'+s.host)+'</small></span>'+
      (s.status==='active'?'<i class="stab-dot on"></i>':'')+'</button>';}).join('')
    :'<div class="nm-empty">Сохранённых сессий пока нет</div>';
  newMenu.hidden=false;
  const r=btn.getBoundingClientRect(),w=newMenu.offsetWidth;
  newMenu.style.left=Math.max(8,Math.min(window.innerWidth-w-8,r.left))+'px';
  newMenu.style.top=(r.bottom+6)+'px';
}
function closeNewMenu(){if(newMenu)newMenu.hidden=true;}
newMenu.addEventListener('click',e=>{
  const b=e.target.closest('.nm-item');if(!b)return;
  closeNewMenu();
  if(b.dataset.shell)localShell(b.dataset.shell);
  else if(b.dataset.sid)connectSession(b.dataset.sid);
});
document.addEventListener('pointerdown',e=>{if(!newMenu.hidden&&!e.target.closest('#newMenu,#tabAdd'))closeNewMenu();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!newMenu.hidden)closeNewMenu();});
window.addEventListener('blur',closeNewMenu);

/* ---- workspace: panes of the active tab ---- */
const fitQueue=new Set();let fitRaf=0;
function scheduleFit(id){fitQueue.add(id);if(!fitRaf)fitRaf=requestAnimationFrame(()=>{fitRaf=0;fitQueue.forEach(fitXterm);fitQueue.clear();});}
const paneObserver=new ResizeObserver(entries=>{
  for(const en of entries){const p=en.target.closest('.pane');if(p)scheduleFit(p.dataset.tab);}
});
function renderWorkspace(){
  const g=activeGroup(),ws=$('#ws');
  syncOn();
  $('#homeShell').hidden=!!g;ws.hidden=!g;
  document.documentElement.classList.toggle('in-tab',!!g);
  // Park terminals off-screen first so rebuilding the panes never destroys them.
  Object.values(xtermState).forEach(st=>{if(st.wrap.parentElement!==xtermPool)xtermPool.appendChild(st.wrap);});
  paneObserver.disconnect();
  if(!g){ws.innerHTML='';return;}
  if(g.kind==='sftp'){
    ws.innerHTML='<div class="ws-scroll"><div class="ws-files" id="fxBody"></div></div>';
    fxShow(g.connId);
    return;
  }
  const multi=g.panes.length>1;
  // flex-grow values that add up to less than 1 leave the rest of the row empty: keep their sum equal to the pane count.
  const sum=g.sizes.reduce((a,b)=>a+(b>0?b:0),0);
  g.sizes=g.panes.map((_,i)=>sum>0&&g.sizes[i]>0?g.sizes[i]*g.panes.length/sum:1);
  ws.innerHTML='<div class="split '+g.dir+(multi?' multi':'')+'">'+g.panes.map((id,i)=>{
    const t=tabById(id);
    return (i?'<div class="pane-div" data-i="'+(i-1)+'"></div>':'')+
      '<section class="pane'+(multi&&g.focus===id?' focus':'')+'" data-tab="'+id+'" style="flex:'+g.sizes[i]+' 1 0">'+
        '<header class="pane-head'+(multi?' grab':'')+'" data-tab="'+id+'">'+paneHeadInner(g,t)+'</header>'+
        '<div class="pane-body"></div></section>';
  }).join('')+'</div>';
  g.panes.forEach(id=>{
    const t=tabById(id);if(!t)return;
    const st=ensureXterm(t);
    const body=ws.querySelector('.pane[data-tab="'+id+'"] .pane-body');
    body.appendChild(st.wrap);
    paneObserver.observe(body);
  });
}
function paneHeadInner(g,t){
  if(!t)return '';
  const multi=g.panes.length>1;
  const live=t.local?!t.exited:!t.closed;
  const o=t.local?null:osOf(t.os);
  const state=t.local?(t.exited?['err','завершён'+(t.exitCode!=null?' · код '+t.exitCode:'')]:['on','локальная оболочка']):(t.closed?['err','соединение закрыто']:['on','подключено']);
  const who=t.local?esc((t.file||'').split(/[\\/]/).pop()||t.name)+(t.cwd?' · '+esc(t.cwd):''):esc(t.user+'@'+t.host+(String(t.port)!=='22'?':'+t.port:''));
  return '<span class="ph-ico" style="--osc:'+(o?o.color:'var(--info)')+'">'+IC(o?o.icon:'terminal')+'<i class="stab-dot '+state[0]+'"></i></span>'+
    '<span class="ph-main"><b class="ph-name">'+esc(t.name)+'</b><span class="ph-who mono" title="'+who+'">'+who+(t.local?'':' · '+esc(osLabel(t.os,t.osName)))+'</span></span>'+
    (live?'':'<span class="pill err ph-state"><span class="sdot"></span>'+state[1]+'</span>')+
    (t.local?'':'<span class="ph-stats">'+statsHtml(t)+'</span>')+
    '<span class="ph-sp"></span>'+
    '<span class="ph-acts">'+
      (!t.local&&live?'<button class="ibtn ph-claude" data-act="claude" title="AI-ассистент на этом сервере">'+IC('chat')+'</button><button class="ibtn" data-act="files" title="Файлы сервера (SFTP)">'+IC('folder')+'</button><i class="ph-sep"></i>':'')+
      '<button class="ibtn" data-act="copy" title="Копировать выделение или весь буфер">'+IC('copy')+'</button>'+
      '<button class="ibtn" data-act="clear" title="Очистить экран">'+IC('eraser')+'</button>'+
      '<button class="ibtn" data-act="re" title="'+(t.local?'Перезапустить оболочку':'Переподключиться')+'">'+IC('refresh')+'</button>'+
      (multi?'<button class="ibtn" data-act="detach" title="Открепить в отдельную вкладку">'+IC('detach')+'</button>':'')+
      '<button class="ibtn x" data-act="close" title="'+(t.local?'Закрыть оболочку':'Отключиться и закрыть')+'">'+IC('x')+'</button>'+
    '</span>';
}
const wsEl=$('#ws');
wsEl.addEventListener('pointerdown',e=>{
  const pane=e.target.closest('.pane');
  if(pane)focusPane(pane.dataset.tab,!!e.target.closest('.pane-head'));
  const div=e.target.closest('.pane-div');
  if(div){startResize(e,div);return;}
  const head=e.target.closest('.pane-head.grab');
  if(head&&!e.target.closest('button')){const g=groupOfTab(head.dataset.tab);if(g)beginDrag(e,{type:'pane',gid:g.id,tabId:head.dataset.tab},head);}
});
wsEl.addEventListener('click',e=>{
  const b=e.target.closest('.pane-head [data-act]');if(!b)return;
  const t=tabById(b.closest('.pane-head').dataset.tab);if(t)termAction(b.dataset.act,t);
});
wsEl.addEventListener('dblclick',e=>{
  // Double-click on a pane header: open that pane as its own tab.
  const head=e.target.closest('.pane-head.grab');
  if(head&&!e.target.closest('button'))detachPane(head.dataset.tab);
});
function startResize(e,div){
  const g=activeGroup();if(!g||g.kind!=='term'||e.button!==0)return;
  e.preventDefault();
  const i=+div.dataset.i,row=g.dir==='row';
  const panes=$$('#ws .split > .pane'),a=panes[i],b=panes[i+1];if(!a||!b)return;
  const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();
  const start=row?e.clientX:e.clientY,total=row?ra.width+rb.width:ra.height+rb.height,sizeA=row?ra.width:ra.height;
  const sum=g.sizes[i]+g.sizes[i+1],min=row?160:90;
  div.setPointerCapture(e.pointerId);div.classList.add('on');
  document.documentElement.classList.add('resizing',row?'resizing-row':'resizing-col');
  const move=ev=>{
    const na=Math.max(min,Math.min(total-min,sizeA+(row?ev.clientX:ev.clientY)-start));
    g.sizes[i]=sum*na/total;g.sizes[i+1]=sum-g.sizes[i];
    a.style.flexGrow=g.sizes[i];b.style.flexGrow=g.sizes[i+1];
  };
  const up=()=>{
    div.removeEventListener('pointermove',move);div.removeEventListener('pointerup',up);div.removeEventListener('pointercancel',up);
    div.classList.remove('on');document.documentElement.classList.remove('resizing','resizing-row','resizing-col');
    termFocus();
  };
  div.addEventListener('pointermove',move);div.addEventListener('pointerup',up);div.addEventListener('pointercancel',up);
}

/* ---- drag & drop: reorder tabs, split by dropping onto a pane edge, drag a pane back to the strip ---- */
let drag=null;
const dropMark=document.createElement('div');dropMark.className='drop-mark';dropMark.hidden=true;document.body.appendChild(dropMark);
const dragGhost=document.createElement('div');dragGhost.className='drag-ghost';dragGhost.hidden=true;document.body.appendChild(dragGhost);
function beginDrag(e,src,el){
  if(e.button!==0)return;
  drag={src,el,x:e.clientX,y:e.clientY,started:false,target:null};
  el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove',dragMove);
  el.addEventListener('pointerup',dragEnd);
  el.addEventListener('pointercancel',dragCancel);
  el.addEventListener('lostpointercapture',dragCancel);
}
function dragCleanup(){
  if(!drag)return;
  const el=drag.el;
  el.removeEventListener('pointermove',dragMove);
  el.removeEventListener('pointerup',dragEnd);
  el.removeEventListener('pointercancel',dragCancel);
  el.removeEventListener('lostpointercapture',dragCancel);
  el.classList.remove('dragging');
  dropMark.hidden=true;dragGhost.hidden=true;
  document.documentElement.classList.remove('tab-dragging');
  const dirty=drag.dirty||drag.started;
  drag=null;
  return dirty;
}
function dragCancel(){if(drag&&drag.ending)return;if(dragCleanup())renderTabs();}
function dragMove(ev){
  if(!drag)return;
  if(!drag.started){
    if(Math.hypot(ev.clientX-drag.x,ev.clientY-drag.y)<6)return;
    drag.started=true;
    drag.el.classList.add('dragging');
    document.documentElement.classList.add('tab-dragging');
    const label=drag.src.type==='group'?groupLabel(groupById(drag.src.gid)||{panes:[]}):((tabById(drag.src.tabId)||{}).name||'');
    dragGhost.innerHTML=IC(drag.src.type==='pane'?'terminal':'split')+'<span>'+esc(label)+'</span>';
    dragGhost.hidden=false;
  }
  dragGhost.style.transform='translate('+(ev.clientX+14)+'px,'+(ev.clientY+12)+'px)';
  drag.target=dropTarget(ev.clientX,ev.clientY);
  showDropMark(drag.target);
}
function dropTarget(x,y){
  const src=drag.src;
  const sr=stripEl.getBoundingClientRect();
  if(y>=sr.top-6&&y<=sr.bottom+10){
    const tabs=$$('#tabStrip .stab[data-gid]');
    let index=tabs.length,mx=null;
    for(let k=0;k<tabs.length;k++){const r=tabs[k].getBoundingClientRect();if(x<r.left+r.width/2){index=k;mx=r.left-3;break;}}
    if(mx===null)mx=tabs.length?tabs[tabs.length-1].getBoundingClientRect().right+3:sr.left+2;
    if(src.type==='group'){const from=S.groups.findIndex(g=>g.id===src.gid);if(index===from||index===from+1)return null;}
    return {type:'strip',index,x:mx,top:sr.top+7,height:sr.height-14};
  }
  const g=activeGroup();if(!g||g.kind!=='term')return null;
  const hit=document.elementFromPoint(x,y);
  const pane=hit&&hit.closest('#ws .pane');if(!pane)return null;
  const tid=pane.dataset.tab;
  const sg=src.type==='group'?groupById(src.gid):null;
  const ok=src.type==='group'
    ?(sg&&sg.id!==g.id&&sg.kind==='term'&&sg.panes.length===1&&g.panes.length<MAX_PANES)
    :(src.gid===g.id&&src.tabId!==tid);
  if(!ok)return null;
  const r=pane.getBoundingClientRect();
  const fx=(x-r.left)/r.width,fy=(y-r.top)/r.height;
  const free=g.panes.length===1||(src.type==='pane'&&g.panes.length===2);
  const edges=free?['left','right','top','bottom']:(g.dir==='row'?['left','right']:['top','bottom']);
  const dist={left:fx,right:1-fx,top:fy,bottom:1-fy};
  const edge=edges.reduce((a,b)=>dist[a]<=dist[b]?a:b);
  return {type:'split',tabId:tid,edge,rect:r};
}
function showDropMark(t){
  if(!t){dropMark.hidden=true;return;}
  dropMark.hidden=false;
  dropMark.className='drop-mark '+t.type;
  if(t.type==='strip'){
    Object.assign(dropMark.style,{left:t.x+'px',top:t.top+'px',width:'3px',height:t.height+'px'});
    dropMark.textContent='';
    return;
  }
  const r=t.rect,h=t.edge==='left'||t.edge==='right';
  Object.assign(dropMark.style,{
    left:(t.edge==='right'?r.left+r.width/2:r.left)+'px',top:(t.edge==='bottom'?r.top+r.height/2:r.top)+'px',
    width:(h?r.width/2:r.width)+'px',height:(h?r.height:r.height/2)+'px'
  });
  dropMark.textContent=drag&&drag.src.type==='pane'?'Переместить сюда':'Разделить';
}
function dragEnd(ev){
  if(!drag)return;
  drag.ending=true;
  const {src,started,target}=drag;
  dragCleanup();
  if(!started){if(src.type==='group'&&ev.button===0)activateGroup(src.gid);return;}
  if(target&&target.type==='strip'){
    if(src.type==='group')moveGroup(src.gid,target.index);
    else{detachPane(src.tabId,target.index);return;}
  }else if(target&&target.type==='split'){
    if(src.type==='group')mergeGroup(src.gid,target.tabId,target.edge);
    else movePane(src.tabId,target.tabId,target.edge);
  }
  renderTabs();
  requestAnimationFrame(termFocus);
}

/* ---- server status line ---- */
const STATS_EVERY=4000;
function fmtUptime(sec){
  const d=Math.floor(sec/86400),h=Math.floor(sec%86400/3600),m=Math.floor(sec%3600/60);
  return d?d+'д '+h+'ч':h?h+'ч '+m+'м':m+'м';
}
const fmtRate=n=>n==null?'—':fmtBytes(Math.round(n))+'/с';
function statsHtml(t){
  const s=t.stats;if(!s||t.closed||t.statsOff)return '';
  const pct=(u,tot)=>tot?Math.round(u/tot*100):null;
  const lvl=p=>p>=90?' hi':p>=70?' mid':'';
  const chip=(cls,label,val,p,title)=>'<span class="chip '+cls+'" title="'+esc(title)+'"><b>'+label+'</b><span class="cv">'+val+'</span>'+
    (p!=null?'<i class="meter"><i class="'+lvl(p)+'" style="width:'+Math.max(2,p)+'%"></i></i>':'')+'</span>';
  let h='';
  if(s.cpu!=null)h+=chip('c-cpu','CPU',Math.round(s.cpu)+'%',Math.round(s.cpu),'Процессор'+(s.cores?' · ядер: '+s.cores:'')+(s.load?' · load average: '+s.load.join(' / '):''));
  const mp=pct(s.memUsed,s.memTotal);
  if(mp!=null)h+=chip('c-ram','RAM',mp+'%',mp,'Память: занято '+fmtBytes(s.memUsed)+' из '+fmtBytes(s.memTotal));
  const dp=pct(s.diskUsed,s.diskTotal);
  if(dp!=null)h+=chip('c-disk','Диск',dp+'%',dp,'Раздел /: занято '+fmtBytes(s.diskUsed)+' из '+fmtBytes(s.diskTotal));
  if(s.load)h+=chip('c-la','LA',s.load[0].toFixed(2).replace('.',','),null,'Load average за 1 / 5 / 15 минут: '+s.load.join(' / '));
  if(s.rxRate!=null)h+=chip('c-net','↓',fmtRate(s.rxRate)+' <em>↑</em> '+fmtRate(s.txRate),null,'Сеть: приём / передача по всем интерфейсам, кроме lo и виртуальных');
  if(s.uptime)h+=chip('c-up','up',fmtUptime(s.uptime),null,'Время работы сервера без перезагрузки');
  return h;
}
function updateStatsDom(t){
  const el=document.querySelector('#ws .pane[data-tab="'+t.id+'"] .ph-stats');
  if(el)el.innerHTML=statsHtml(t);
}
async function pollTabStats(t){
  if(t.statsBusy||t.statsOff||!liveSshTab(t)||!window.sshAPI||!window.sshAPI.stats)return;
  t.statsBusy=true;
  const connId=t.connId;
  let r;
  try{r=await window.sshAPI.stats(connId);}catch(e){r={ok:false,error:String(e)};}
  t.statsBusy=false;
  if(t.connId!==connId||t.closed)return;
  if(r.ok&&r.unsupported)t.statsOff=true;
  else if(r.ok){
    t.stats=r.stats;t.statsFails=0;
    // CPU and network are rates: take a second sample soon so the line fills in right after connecting.
    if(r.stats.cpu==null&&!t.statsPrimed){t.statsPrimed=true;setTimeout(()=>pollTabStats(t),1200);}
  }else if((t.statsFails=(t.statsFails||0)+1)>=3)t.statsOff=true;
  updateStatsDom(t);
}
function pollStats(){
  if(document.hidden)return;
  const g=activeGroup();if(!g||g.kind!=='term')return;
  g.panes.map(tabById).forEach(t=>{if(liveSshTab(t))pollTabStats(t);});
}
function pollStatsSoon(){setTimeout(pollStats,60);}
setInterval(pollStats,STATS_EVERY);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)pollStatsSoon();});
