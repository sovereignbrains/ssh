"use strict";
/* ---------------- XTERM (SSH and local terminals) ---------------- */
const xtermPool=document.createElement('div');
xtermPool.style.cssText='position:fixed;left:-99999px;top:-99999px;width:800px;height:400px;overflow:hidden';
document.body.appendChild(xtermPool);
const xtermState={};
// Terminal background is transparent: the pane under it paints the colour (translucent in glass mode).
const XTERM_THEMES={
  edge:{background:'#00000000',foreground:'#edeff2',cursor:'#3ddbc2',cursorAccent:'#04211d',selectionBackground:'#3ddbc244',
    black:'#1b1c1f',red:'#f4737f',green:'#4ade9b',yellow:'#f2c14e',blue:'#4cc3f0',magenta:'#c792ea',cyan:'#6fb3f2',white:'#c9ccd3',
    brightBlack:'#5a5e66',brightRed:'#f4919a',brightGreen:'#7be0b3',brightYellow:'#f5d27a',brightBlue:'#7ad0f5',brightMagenta:'#d9b3f0',brightCyan:'#94c8f5',brightWhite:'#edeff2'},
  night:{background:'#00000000',foreground:'#f2ece4',cursor:'#f3a53c',cursorAccent:'#2a1704',selectionBackground:'#f3a53c44',
    black:'#1c1b19',red:'#ef7d74',green:'#a9c98a',yellow:'#e8c468',blue:'#ef7c3f',magenta:'#d8a5e0',cyan:'#93b8d8',white:'#d8d1c6',
    brightBlack:'#5c5750',brightRed:'#f3a099',brightGreen:'#c1dba7',brightYellow:'#eed491',brightBlue:'#f3a06a',brightMagenta:'#e6c1ec',brightCyan:'#b1cfe6',brightWhite:'#f2ece4'}
};
function currentXtermTheme(){return XTERM_THEMES[document.documentElement.dataset.theme==='night'?'night':'edge'];}
// App shortcuts must reach the document instead of being eaten by the terminal.
const appShortcut=e=>e.type==='keydown'&&((e.ctrlKey&&e.key==='Tab')||(e.altKey&&!e.ctrlKey&&/^[1-9]$/.test(e.key)));
function ensureXterm(tab){
  if(xtermState[tab.id])return xtermState[tab.id];
  const wrap=document.createElement('div');wrap.className='term-xterm';
  const opts={
    fontFamily:S.font||"'JetBrains Mono','Cascadia Mono',monospace",
    fontSize:S.fontSize||13.5,cursorBlink:true,scrollback:S.scrollback||10000,
    allowTransparency:true,theme:currentXtermTheme()
  };
  if(tab.local&&window.electronAPI&&window.electronAPI.platform==='win32')opts.windowsPty={backend:'conpty'};
  const term=new Terminal(opts);
  const fit=new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(wrap);
  term.attachCustomKeyEventHandler(e=>!appShortcut(e));
  term.onData(data=>{
    if(tab.local){if(tab.ptyId&&!tab.exited)window.localAPI.write(tab.ptyId,data);}
    else if(tab.connId&&!tab.closed)window.sshAPI.write(tab.connId,data);
  });
  term.onResize(({cols,rows})=>{
    if(tab.local){if(tab.ptyId&&!tab.exited)window.localAPI.resize(tab.ptyId,cols,rows);}
    else if(tab.connId&&!tab.closed)window.sshAPI.resize(tab.connId,cols,rows);
  });
  term.textarea&&term.textarea.addEventListener('focus',()=>focusPane(tab.id,true));
  xtermPool.appendChild(wrap);
  const st={term,fit,wrap};
  xtermState[tab.id]=st;
  return st;
}
function disposeXterm(tabId){
  const st=xtermState[tabId];if(!st)return;
  try{st.term.dispose();}catch(e){}
  // xterm 5.3 leaves an already scheduled viewport refresh behind after dispose(); it then reads the
  // disposed renderer and throws. Neutralise it (private field, so guarded).
  try{const vp=st.term._core&&st.term._core.viewport;if(vp)vp._innerRefresh=()=>{};}catch(e){}
  st.wrap.remove();
  delete xtermState[tabId];
}
function fitXterm(tabId){
  const st=xtermState[tabId];if(!st||!st.wrap.isConnected||st.wrap.parentElement===xtermPool)return;
  if(!st.wrap.clientWidth||!st.wrap.clientHeight)return;
  try{st.fit.fit();}catch(e){}
}
function fitActiveXterm(){
  const g=activeGroup();
  if(g&&g.kind==='term')g.panes.forEach(fitXterm);
}
const nextFrame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));

function termFocus(){
  const g=activeGroup();
  const st=g&&g.kind==='term'&&xtermState[g.focus];
  if(st)st.term.focus();
}
// Dock badges: connected sessions and running tunnels (journal errors are counted in journal.js).
function updateBadges(){
  $('#bgSessions').textContent=S.sessions.filter(s=>s.status==='active').length;
  $('#bgTunnels').textContent=S.tunnels.filter(t=>t.on).length;
}

/* ---- local shell over a real PTY ---- */
const SHELL_NAMES={pwsh:'PowerShell 7',wps:'Windows PowerShell',cmd:'cmd'};
const ptyToTab={};
let shellInfo={available:{pwsh:true,wps:true,cmd:true},home:''};
if(window.localAPI){
  window.localAPI.onData(p=>{
    const tab=ptyToTab[p.ptyId];if(!tab)return;
    const st=xtermState[tab.id];if(st)st.term.write(p.data);
  });
  window.localAPI.onExit(p=>{
    const tab=ptyToTab[p.ptyId];if(!tab)return;
    delete ptyToTab[p.ptyId];
    tab.exited=true;tab.exitCode=p.exitCode;
    logEvent(p.exitCode?'warn':'info','local',tab.name+' завершился с кодом '+p.exitCode,tab.cwd||'');
    const st=xtermState[tab.id];
    if(st)st.term.write('\r\n\x1b[33m[процесс завершён, код '+p.exitCode+'] — «Перезапустить», чтобы открыть заново\x1b[0m\r\n');
    refreshTab(tab);
  });
}
async function startLocalPty(tab){
  const st=ensureXterm(tab);
  await nextFrame();
  fitXterm(tab.id);
  tab.ptyId=uid('p');tab.exited=false;tab.exitCode=null;
  ptyToTab[tab.ptyId]=tab;
  const r=await window.localAPI.spawn({ptyId:tab.ptyId,shell:tab.shell,cwd:tab.dir||S.shellDir,cols:st.term.cols,rows:st.term.rows});
  if(!r.ok){
    delete ptyToTab[tab.ptyId];
    tab.exited=true;
    st.term.write('\x1b[31m'+r.error+'\x1b[0m\r\n');
    toast(r.error,'err','Локальный shell');
    logEvent('err','local',r.error,SHELL_NAMES[tab.shell]||tab.shell);
    refreshTab(tab);
    return false;
  }
  tab.file=r.file;tab.cwd=r.cwd;
  logEvent('info','local','Запущен '+r.file,r.cwd);
  refreshTab(tab);
  return true;
}
// opts: {dir} — стартовая папка (для проектов), {name} — имя вкладки.
async function localShell(shell,opts){
  if(!S.vaultOpen){toast('Сейф заблокирован','err','Отказано');lockScreenFocus();return;}
  if(!window.localAPI){toast('Локальный shell недоступен в этой сборке','err','Локальный shell');return;}
  shell=shell||S.shell;opts=opts||{};
  const tab={id:uid('t'),local:true,shell:shell,name:opts.name||SHELL_NAMES[shell]||shell,session:null,dir:opts.dir||''};
  S.tabs.push(tab);
  addTermGroup(tab);
  await startLocalPty(tab);
}
window.localShell=localShell;
// «Этот компьютер» on the Sessions page: one tile per installed shell, with how many of them are open.
function renderLocalStrip(){
  const box=$('#localStrip');if(!box)return;
  const shells=window.localAPI?Object.keys(SHELL_NAMES).filter(k=>shellInfo.available[k]):[];
  box.hidden=!shells.length;
  if(!shells.length)return;
  const dir=S.shellDir||shellInfo.home||'';
  box.innerHTML='<div class="ls-head"><span class="ls-title">'+IC('cpu')+' Этот компьютер</span>'+
    '<button class="ls-dir" data-do="pickShellDir" title="Стартовая папка локальных оболочек — нажмите, чтобы изменить">'+IC('folder')+'<span class="mono">'+esc(dir||'домашняя папка')+'</span></button></div>'+
    '<div class="ls-tiles">'+shells.map(k=>{
      const open=S.tabs.filter(t=>t.local&&t.shell===k&&!t.exited).length;
      return '<div class="ls-tile'+(open?' live':'')+'">'+
        '<button class="ls-main" data-do="localShell" data-arg="'+k+'" title="Открыть '+SHELL_NAMES[k]+' в новой вкладке">'+
          '<span class="ls-ico '+k+'">'+(k==='cmd'?'C:\\':'PS')+'</span>'+
          '<span class="ls-t"><b>'+SHELL_NAMES[k]+'</b><small>'+(k===S.shell?'по умолчанию':'новая вкладка')+'</small></span>'+
          '<span class="ls-go">'+IC('plus')+'</span></button>'+
        (open?'<button class="ls-open" data-do="openLocalShell" data-arg="'+k+'" title="Перейти к открытой вкладке"><i class="stab-dot on"></i>открыто'+(open>1?' '+open:'')+'</button>':'')+
      '</div>';
    }).join('')+'</div>';
}
window.openLocalShell=k=>{
  const t=S.tabs.filter(x=>x.local&&x.shell===k&&!x.exited).pop();
  if(t)openTab(t.id);
};
$('#btnTestShell').onclick=()=>localShell();

function termAction(act,t){
  if(act==='files'){if(t.connId&&!t.closed)openFiles(t.connId);return;}
  if(act==='claude'){if(t.connId&&!t.closed)openClaude(t.connId);return;}
  if(act==='detach'){detachPane(t.id);return;}
  if(act==='close'){closeTab(t.id);return;}
  const st=xtermState[t.id];
  if(act==='copy'){
    if(!st)return;
    const sel=st.term.getSelection();
    let text=sel;
    if(!text){
      const buf=st.term.buffer.active,lines=[];
      for(let i=0;i<buf.length;i++){const line=buf.getLine(i);if(line)lines.push(line.translateToString(true));}
      text=lines.join('\n').replace(/\n+$/,'');
    }
    navigator.clipboard&&navigator.clipboard.writeText(text).catch(()=>{});
    toast(sel?'Выделение скопировано':'Весь буфер терминала скопирован','ok','Терминал');
    return;
  }
  if(act==='clear'){if(st)st.term.clear();return;}
  if(act==='re'){
    if(t.local){
      if(t.ptyId&&!t.exited){window.localAPI.kill(t.ptyId);delete ptyToTab[t.ptyId];}
      if(st)st.term.reset();
      startLocalPty(t);
    }else if(t.session){
      // The pane keeps its place: the old connection goes first so tunnels can rebind their ports.
      if(!t.closed)dropConnection(t,'Переподключение');
      connectSession(t.session,null,{replace:t.id});
    }
    return;
  }
}
// Ends the SSH connection behind a tab but leaves the tab itself on screen.
function dropConnection(t,why){
  if(!t.connId||t.closed)return;
  window.sshAPI.disconnect(t.connId);
  delete connIdToTab[t.connId];
  t.closed=true;
  const s=S.sessions.find(x=>x.id===t.session);
  if(s&&!S.tabs.some(x=>x!==t&&!x.local&&x.session===s.id&&!x.closed)){s.status='idle';renderSessions();}
  logEvent('info','disconnect',why+(t.connectedAt?' · длительность '+fmtDuration(Date.now()-t.connectedAt):''),s?sessTarget(s):t.user+'@'+t.host+':'+t.port);
  refreshTab(t);renderTunnels();renderTunnelForm();
}
async function closeTab(id,byDisconnect){
  const t=S.tabs.find(x=>x.id===id);if(!t)return;
  const alive=t.local?!t.exited:!t.closed;
  const files=!t.local&&S.groups.some(g=>g.kind==='sftp'&&g.connId===t.connId);
  if(!byDisconnect&&alive){
    const ok=await confirmModal({title:'Закрыть вкладку?',icon:'x',
      text:t.local?'Оболочка «<b>'+esc(t.name)+'</b>» будет завершена вместе с запущенными в ней программами.'
                  :'Соединение «<b>'+esc(t.name)+'</b>» ('+esc(osLabel(t.os,t.osName))+') будет разорвано'+(files?' — вкладка SFTP этого сервера тоже закроется':'')+'. Данные в сейфе не пострадают.',
      ok:'Закрыть'});
    if(!ok)return;
  }
  if(!S.tabs.includes(t))return;
  if(t.local){if(t.ptyId){window.localAPI.kill(t.ptyId);delete ptyToTab[t.ptyId];}}
  else if(t.connId){window.sshAPI.disconnect(t.connId);delete connIdToTab[t.connId];}
  const s=S.sessions.find(x=>x.id===t.session);
  S.tabs.splice(S.tabs.indexOf(t),1);
  removeLeaf(t.id);
  if(!t.local)S.groups.filter(g=>g.kind==='sftp'&&g.connId===t.connId).forEach(g=>removeGroup(g.id));
  disposeXterm(t.id);
  if(s&&!S.tabs.some(x=>!x.local&&x.session===s.id&&!x.closed)){s.status='idle';renderSessions();}
  if(alive){
    if(t.local)logEvent('info','local','Оболочка закрыта: '+t.name,t.cwd||'');
    else logEvent('info','disconnect','Отключено пользователем'+(t.connectedAt?' · длительность '+fmtDuration(Date.now()-t.connectedAt):''),s?sessTarget(s):t.user+'@'+t.host+':'+t.port);
  }
  renderTabs();renderTunnels();renderTunnelForm();
  if(typeof renderClaude==='function'&&CL.open)renderClaude();
}
window.closeTab=closeTab;
