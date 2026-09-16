"use strict";
/* ---------------- CLAUDE (Claude Code over ACP, acting on the SSH server) ---------------- */
const CL={detect:null,connId:null,chats:{},drafts:{},freshWanted:{},renderQueued:false,open:false,big:false};
const CL_LOCAL={connId:'local',local:true,name:'Этот компьютер'};
function clTargets(){return [CL_LOCAL,...fxLiveTabs()];}
function clIsLocal(connId){return connId===CL_LOCAL.connId;}
function clProfileId(connId){const t=clTab(connId);return t?(t.local?'local':t.session):null;}
function clTargetIco(t){return t.local?'<span class="cl-pk-os cl-pk-local">'+IC('terminal')+'</span>':'<span class="cl-pk-os" style="--osc:'+osOf(t.os).color+'">'+IC(osOf(t.os).icon)+'</span>';}
function clTargetSub(t){return t.local?'этот компьютер':t.user+'@'+t.host+(String(t.port)!=='22'?':'+t.port:'');}
const CL_TOOL_LABELS={run_command:'Команда',read_file:'Чтение файла',list_directory:'Список папки',write_file:'Запись файла',edit_file:'Правка файла'};
function clShortTool(name){const m=/^mcp__ssh__(.+)$/.exec(name||'');return m?m[1]:(name||'');}
function clChatById(chatId){return Object.values(CL.chats).find(c=>c.chatId===chatId)||null;}
function clTab(connId){return clTargets().find(t=>t.connId===connId)||null;}
function clTarget(chat){const t=chat&&clTab(chat.connId);return t?(t.local?t.name:t.name+' · '+t.user+'@'+t.host+':'+t.port):'';}
function clPending(){return Object.values(CL.chats).reduce((n,c)=>n+c.items.filter(i=>((i.kind==='approval'||i.kind==='permission')&&i.state==='pending')||(i.approval&&i.approval.state==='pending')).length,0);}
function clMd(src){
  // Minimal, escape-first formatting: ``` fences, `code`, **bold**, line breaks.
  return String(src).split('```').map((part,i)=>{
    if(i%2){const body=part.replace(/^[\w-]*\n/,'');return '<pre class="cl-code">'+esc(body.replace(/\n$/,''))+'</pre>';}
    return esc(part).replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g,'<b>$1</b>').replace(/\n/g,'<br>');
  }).join('');
}
function clToolText(content){
  if(!Array.isArray(content))return '';
  return content.map(c=>c&&c.type==='content'&&c.content&&c.content.type==='text'?c.content.text:(c&&c.type==='diff'?('--- '+(c.path||'')+'\n'+(c.newText||'')):'')).filter(Boolean).join('\n');
}
function clQueueRender(){
  if(CL.renderQueued)return;
  CL.renderQueued=true;
  requestAnimationFrame(()=>{CL.renderQueued=false;if(CL.open)renderClaudeLog();updateClaudeBadge();});
}
function updateClaudeBadge(){
  const n=clPending(),b=$('#bgClaude');if(!b)return;
  b.textContent=n;b.hidden=!n;
  const busy=Object.values(CL.chats).some(c=>c.busy);
  $('#clFab').classList.toggle('attn',n>0&&!CL.open);
  $('#clFab').classList.toggle('busy',busy);
}
function clItemHtml(it){
  if(it.kind==='user')return '<div class="cl-msg user">'+clMd(it.text)+'</div>';
  if(it.kind==='agent')return '<div class="cl-msg agent">'+clMd(it.text)+'</div>';
  if(it.kind==='thought')return '<details class="cl-thought"><summary>'+IC('sparkles')+' Размышления</summary><div>'+clMd(it.text)+'</div></details>';
  if(it.kind==='info')return '<div class="cl-info'+(it.error?' err':'')+'">'+IC(it.error?'alert':'info')+' '+esc(it.text)+'</div>';
  if(it.kind==='plan')return '<div class="cl-card"><div class="cl-card-h">'+IC('check-c')+' План</div><ul class="cl-plan">'+
    (it.entries||[]).map(e=>'<li class="'+esc(e.status||'')+'">'+(e.status==='completed'?'✓':e.status==='in_progress'?'▸':'○')+' '+esc(e.content||'')+'</li>').join('')+'</ul></div>';
  if(it.kind==='tool'){
    if(it.toolName==='ToolSearch')return ''; // Claude Code loading deferred MCP tools, not useful to show
    const short=clShortTool(it.toolName),label=CL_TOOL_LABELS[short]||it.title||short||'Инструмент';
    const ap=it.approval;
    const input=it.rawInput||{};
    const subject=input.command||input.path||(short&&it.title!==label?it.title:'')||'';
    const st=it.status==='completed'?['on','готово']:it.status==='failed'?['err','ошибка']:it.status==='in_progress'?['warn','выполняется']:['off','ожидает'];
    const out=clToolText(it.content);
    return '<div class="cl-card cl-tool'+(ap&&ap.state==='pending'?' cl-approval pending':'')+'"'+(ap?' data-approval="'+ap.approvalId+'"':'')+'><div class="cl-card-h">'+IC(short==='run_command'?'terminal':short.includes('file')||short==='list_directory'?'folder':'settings')+' '+esc(label)+
      '<span class="pill '+st[0]+'" style="margin-left:auto"><span class="sdot"></span>'+st[1]+'</span></div>'+
      (subject?'<div class="cl-subject mono">'+esc(subject)+'</div>':'')+
      (ap&&ap.detail?'<details '+(ap.tool!=='run_command'?'open':'')+' class="cl-out"><summary>'+(ap.tool==='run_command'?'подробности':'содержимое')+'</summary><pre>'+esc(ap.detail)+'</pre></details>':'')+
      (ap?(ap.state==='pending'
        ?'<div class="cl-actions"><span class="hint" style="margin:0 6px 0 0;align-self:center">Нужно ваше подтверждение</span><button class="btn sm primary" data-allow="1">'+IC('check')+' Разрешить</button><button class="btn sm ghost" data-allow="1" data-always="1" title="Больше не спрашивать для «'+esc(label)+'» на этом сервере">'+IC('check')+' Разрешать всегда</button><button class="btn sm danger" data-allow="0">'+IC('x')+' Отклонить</button></div>'
        :'<div class="cl-actions"><span class="pill '+(ap.state==='allowed'?'on':ap.state==='denied'?'err':'off')+'"><span class="sdot"></span>'+(ap.state==='allowed'?'разрешено':ap.state==='denied'?'отклонено':'отменено')+'</span></div>'):'')+
      (out?'<details class="cl-out"><summary>вывод</summary><pre>'+esc(out.length>6000?out.slice(0,6000)+'\n…':out)+'</pre></details>':'')+'</div>';
  }
  if(it.kind==='approval'){
    const titles={run_command:'Claude хочет выполнить команду на сервере',write_file:'Claude хочет записать файл',edit_file:'Claude хочет изменить файл'};
    const pending=it.state==='pending';
    return '<div class="cl-card cl-approval '+(pending?'pending':'')+'" data-approval="'+it.approvalId+'">'+
      '<div class="cl-card-h">'+IC('shield')+' '+esc(titles[it.tool]||'Claude запрашивает действие')+'</div>'+
      '<pre class="cl-subject-pre">'+esc(it.summary)+'</pre>'+
      (it.detail?'<details '+(it.tool!=='run_command'?'open':'')+' class="cl-out"><summary>'+(it.tool==='run_command'?'подробности':'содержимое')+'</summary><pre>'+esc(it.detail)+'</pre></details>':'')+
      (pending?'<div class="cl-actions"><button class="btn sm primary" data-allow="1">'+IC('check')+' Разрешить</button><button class="btn sm ghost" data-allow="1" data-always="1" title="Больше не спрашивать для этого на этом сервере">'+IC('check')+' Разрешать всегда</button><button class="btn sm danger" data-allow="0">'+IC('x')+' Отклонить</button></div>'
        :'<div class="cl-actions"><span class="pill '+(it.state==='allowed'?'on':it.state==='denied'?'err':'off')+'"><span class="sdot"></span>'+(it.state==='allowed'?'разрешено':it.state==='denied'?'отклонено':'отменено')+'</span></div>')+'</div>';
  }
  if(it.kind==='permission'){
    const pending=it.state==='pending';
    return '<div class="cl-card cl-approval '+(pending?'pending':'')+'" data-permission="'+it.requestId+'">'+
      '<div class="cl-card-h">'+IC('shield')+' Claude запрашивает разрешение: '+esc(it.title||it.toolName)+'</div>'+
      (it.rawInput?'<details class="cl-out"><summary>параметры</summary><pre>'+esc(JSON.stringify(it.rawInput,null,2))+'</pre></details>':'')+
      (pending?'<div class="cl-actions">'+it.options.map(o=>'<button class="btn sm '+(o.kind==='allow_once'?'primary':'danger')+'" data-option="'+esc(o.optionId)+'">'+esc(o.name)+'</button>').join('')+'</div>'
        :'<div class="cl-actions"><span class="pill '+(it.state==='allowed'?'on':'err')+'"><span class="sdot"></span>'+(it.state==='allowed'?'разрешено':'отклонено')+'</span></div>')+'</div>';
  }
  return '';
}
function renderClaudeLog(){
  const log=$('#clLog');if(!log){renderClaude();return;}
  const chat=CL.chats[CL.connId];
  const nearBottom=log.scrollHeight-log.scrollTop-log.clientHeight<120;
  log.innerHTML=chat&&chat.items.length?chat.items.map(clItemHtml).join('')+(chat.busy?'<div class="cl-typing"><span class="cl-think">'+IC('claude')+'</span> Claude работает…</div>':'')
    :'<div class="cl-empty">'+IC('claude','xl')+'<h4>Спросите Claude о сервере</h4><p>Например: «почему не стартует nginx?», «сколько места на дисках и что занимает больше всего?», «обнови пакеты и перезапусти сервис».</p></div>';
  if(nearBottom)log.scrollTop=log.scrollHeight;
  const top=$('#clStatus');if(top)top.outerHTML=clStatusHtml(chat);
  clSyncSend();
}
// One button: arrow to send, square to stop while Claude answers, spinner while the agent starts.
function clSyncSend(){
  const b=$('#clSend'),ta=$('#clText');if(!b||!ta)return;
  const chat=CL.chats[CL.connId];
  const mode=chat&&chat.busy?(chat.state==='starting'?'wait':'stop'):'send';
  if(b.dataset.mode!==mode){
    b.dataset.mode=mode;
    b.className='cl-send '+mode;
    b.innerHTML=mode==='wait'?'<span class="spinner"></span>':IC(mode==='stop'?'stop':'arrow-up');
    b.title=mode==='stop'?'Остановить ответ':mode==='wait'?'Claude запускается…':'Отправить (Enter)';
  }
  b.disabled=mode==='wait'||(mode==='send'&&!ta.value.trim());
}
function clGrow(ta){ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,160)+'px';}
function renderClPicker(targets){
  const b=$('#clPicker');if(!b)return;
  const t=targets.find(x=>x.connId===CL.connId);
  b.classList.toggle('single',false);
  if(!t){b.innerHTML='<span class="cl-pk-sub">нет цели</span>';b.disabled=true;closeClMenu();return;}
  b.disabled=false;
  b.innerHTML=clTargetIco(t)+'<span class="cl-pk-t">'+esc(t.name)+'</span>'+
    '<span class="cl-pk-sub">'+esc(clTargetSub(t))+'</span>'+IC('chev-down','cl-pk-chev');
  b.title='Выбрать, где работает Claude';
}
function openClMenu(){
  const row=(t)=>{
    const c=CL.chats[t.connId],on=t.connId===CL.connId;
    const st=c&&c.state!=='closed'?(c.busy?'<span class="cl-mi-st busy">отвечает</span>':'<span class="cl-mi-st">есть чат</span>'):'';
    return '<button class="cl-mi'+(on?' on':'')+'" data-conn="'+t.connId+'">'+clTargetIco(t)+
      '<span class="cl-mi-t"><b>'+esc(t.name)+'</b><small>'+esc(t.local?clTargetSub(t):clTargetSub(t)+' · '+osLabel(t.os,t.osName))+'</small></span>'+
      st+'<span class="cl-mi-ck">'+(on?IC('check'):'')+'</span></button>';
  };
  const liveIds=new Set(S.tabs.filter(t=>!t.local&&!t.closed).map(t=>t.session));
  const offline=S.sessions.filter(s=>!liveIds.has(s.id)).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,8);
  $('#clMenu').innerHTML='<div class="cl-menu-h">Где работает Claude</div>'+clTargets().map(row).join('')+
    (offline.length?'<div class="cl-menu-h">Подключиться</div>'+offline.map(s=>
      '<button class="cl-mi" data-do="connect" data-arg="'+s.id+'">'+
        '<span class="cl-pk-os" style="--osc:'+osOf(s.os).color+'">'+IC(osOf(s.os).icon)+'</span>'+
        '<span class="cl-mi-t"><b>'+esc(s.name)+'</b><small>'+esc(s.user+'@'+s.host+(String(s.port)!=='22'?':'+s.port:''))+'</small></span>'+
        '<span class="cl-mi-ck">'+IC('play')+'</span></button>').join(''):'');
  $('#clMenu').hidden=false;
  $('#clPicker').classList.add('open');
}
function closeClMenu(){
  const m=$('#clMenu');if(!m||m.hidden)return;
  m.hidden=true;$('#clPicker').classList.remove('open');
}
function clStatusHtml(chat){
  const s=!chat?['off','не запущен']:chat.state==='starting'?['warn','запуск…']:chat.state==='ready'?(chat.busy?['warn','отвечает']:['on','готов']):['off','завершён'];
  return '<span class="pill '+s[0]+'" id="clStatus"><span class="sdot"></span>'+s[1]+'</span>';
}
function renderClaude(){
  const box=$('#clBody');if(!box)return;
  const tabs=fxLiveTabs(),targets=clTargets();
  if(CL.connId&&!targets.some(t=>t.connId===CL.connId))CL.connId=null;
  if(!CL.connId)CL.connId=tabs.length?tabs[0].connId:CL_LOCAL.connId;
  renderClPicker(targets);
  const d=CL.detect;
  if(d&&!d.found){
    box.innerHTML='<div class="empty cl-none"><div class="empty-ico">'+IC('alert')+'</div><h4>Claude Code не найден</h4><p>'+esc(d.error||'')+'</p>'+
      '<button class="btn primary" id="clRedetect">'+IC('refresh')+' Проверить снова</button></div>';
    $('#clRedetect').onclick=async()=>{CL.detect=await window.agentAPI.detect(true);renderClaude();renderClaudeSettings();};
    return;
  }
  const chat=CL.chats[CL.connId];
  box.innerHTML='<div class="cl-wrap">'+
    '<div class="cl-top">'+clStatusHtml(chat)+'<span class="hint" style="margin:0">'+esc(d&&d.version?d.version:'')+'</span><div style="flex:1"></div>'+
      '<button class="ibtn" id="clForget" title="Забыть разговор и все «разрешать всегда» для этого сервера">'+IC('trash')+'</button>'+
      '<button class="btn sm ghost" id="clNew">'+IC('plus')+' Новый чат</button></div>'+
    '<div class="cl-log" id="clLog"></div>'+
    '<div class="cl-compose"><div class="cl-box">'+
      '<textarea id="clText" rows="1" placeholder="'+(clIsLocal(CL.connId)?'Спросите Claude об этом компьютере…':'Спросите Claude о сервере…')+'" spellcheck="false"></textarea>'+
      '<button class="cl-send" id="clSend"></button></div>'+
      '<div class="cl-hint"><span><span class="kbd">Enter</span> отправить</span><span><span class="kbd">Shift+Enter</span> новая строка</span></div>'+
    '</div>'+
  '</div>';
  const ta=$('#clText');
  ta.value=CL.drafts[CL.connId]||'';
  renderClaudeLog();
  clGrow(ta);
  ta.oninput=()=>{CL.drafts[CL.connId]=ta.value;clGrow(ta);clSyncSend();};
  ta.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();clSend();}};
  $('#clSend').onclick=()=>{
    const c=CL.chats[CL.connId];
    if($('#clSend').dataset.mode==='stop'){if(c)window.agentAPI.cancel(c.chatId);return;}
    clSend();
  };
  $('#clNew').onclick=async()=>{
    const c=CL.chats[CL.connId];
    if(c&&c.state!=='closed')await window.agentAPI.close(c.chatId);
    CL.freshWanted[CL.connId]=true;
    delete CL.chats[CL.connId];renderClaude();$('#clText').focus();
  };
  $('#clForget').onclick=async()=>{
    const ok=await confirmModal({title:'Забыть чат с Claude?',text:'Клод забудет разговор с этим сервером и снова начнёт спрашивать подтверждение на каждое действие.',ok:'Забыть'});
    if(!ok)return;
    const c=CL.chats[CL.connId];
    if(c&&c.state!=='closed')await window.agentAPI.close(c.chatId);
    await window.agentAPI.forget(clProfileId(CL.connId));
    CL.freshWanted[CL.connId]=true;
    delete CL.chats[CL.connId];renderClaude();$('#clText').focus();
  };
  const log=$('#clLog');
  log.onclick=e=>{
    const a=e.target.closest('[data-allow]');
    if(a){
      const card=a.closest('[data-approval]'),it=clFindItem('approvalId',card.dataset.approval);
      if(!it||it.state!=='pending')return;
      const allow=a.dataset.allow==='1',always=a.dataset.always==='1';
      it.state=allow?'allowed':'denied';
      window.agentAPI.approve(it.approvalId,allow,always);
      logEvent(allow?'info':'warn','claude',(allow?(always?'Разрешено всегда: ':'Разрешено: '):'Отклонено: ')+(CL_TOOL_LABELS[it.tool]||it.tool)+' — '+it.summary.slice(0,200),clTarget(clChatById(it.chatId)));
      clQueueRender();return;
    }
    const o=e.target.closest('[data-option]');
    if(o){
      const card=o.closest('[data-permission]'),it=clFindItem('requestId',card.dataset.permission);
      if(!it||it.state!=='pending')return;
      const opt=it.options.find(x=>x.optionId===o.dataset.option);
      it.state=opt&&opt.kind==='allow_once'?'allowed':'denied';
      window.agentAPI.choosePermission(it.requestId,o.dataset.option);
      clQueueRender();
    }
  };
}
function clFindItem(key,val){
  for(const c of Object.values(CL.chats)){
    for(const i of c.items){if(i[key]===val)return i;if(i.approval&&i.approval[key]===val)return i.approval;}
  }
  return null;
}
async function clSend(){
  const ta=$('#clText');if(!ta)return;
  const text=ta.value.trim();if(!text||!CL.connId)return;
  let chat=CL.chats[CL.connId];
  if(chat&&(chat.busy||chat.state==='starting'))return;
  ta.value='';delete CL.drafts[CL.connId];clGrow(ta);clSyncSend();
  if(!chat||chat.state==='closed'){
    const fresh=!!CL.freshWanted[CL.connId];delete CL.freshWanted[CL.connId];
    const r=await window.agentAPI.start(CL.connId,clProfileId(CL.connId),fresh);
    if(!r.ok){toast(r.error,'err','Claude');ta.value=text;CL.drafts[CL.connId]=text;clGrow(ta);clSyncSend();return;}
    const prev=chat?chat.items:[];
    chat=CL.chats[CL.connId]={chatId:r.chatId,connId:CL.connId,state:'starting',busy:true,items:prev,pendingPrompt:text};
    if(fresh&&prev.length)chat.items.push({kind:'info',text:'Начат новый чат — предыдущий контекст сброшен'});
    logEvent('info','claude','Запущен Claude Code',clTarget(chat));
    chat.items.push({kind:'user',text:text});
    clQueueRender();
    return;
  }
  chat.busy=true;
  chat.items.push({kind:'user',text:text});
  clQueueRender();
  const r=await window.agentAPI.prompt(chat.chatId,text);
  if(!r.ok){chat.busy=false;chat.items.push({kind:'info',error:true,text:r.error});clQueueRender();}
}
/* ---- floating chat: launcher bottom-right, panel opens above it ---- */
function openClaude(connId){
  const f=focusedSshTab();
  if(connId)CL.connId=connId;
  else if(f&&!(CL.chats[CL.connId]&&CL.chats[CL.connId].busy))CL.connId=f.connId;
  CL.open=true;
  $('#clPop').hidden=false;
  syncClaudeInset();
  $('#clFab').classList.add('open');
  renderClaude();updateClaudeBadge();
  setTimeout(()=>{const t=$('#clText');if(t)t.focus();const l=$('#clLog');if(l)l.scrollTop=l.scrollHeight;},60);
}
function closeClaude(){
  if(!CL.open)return;
  CL.open=false;
  syncClaudeInset();
  closeClMenu();
  const pop=$('#clPop');
  pop.classList.add('out');
  setTimeout(()=>{pop.classList.remove('out');if(!CL.open)pop.hidden=true;},180);
  $('#clFab').classList.remove('open');
  updateClaudeBadge();
  requestAnimationFrame(termFocus);
}
window.openClaude=openClaude;
function setClaudeBig(v){
  CL.big=v;
  $('#clPop').classList.toggle('big',v);
  $('#clBig').innerHTML=IC(v?'restore':'maximize');
  $('#clBig').title=v?'Обычный размер':'Развернуть';
  applyClaudeSize();
}
/* ---- chat size: drag the left or top edge, or the corner between them; remembered on this computer ---- */
const CL_MIN_W=360,CL_MIN_H=380;
try{const v=JSON.parse(localStorage.getItem('ssh.chatSize')||'null');if(v&&v.w>0&&v.h>0)CL.size=v;}catch(e){}
function applyClaudeSize(){
  const pop=$('#clPop'),own=!CL.big&&CL.size;
  pop.style.width=own?CL.size.w+'px':'';
  pop.style.height=own?CL.size.h+'px':'';
  syncClaudeInset();
}
// Pages that should stay clear of the open chat (settings) read its width from --cl-w.
function syncClaudeInset(){
  const root=document.documentElement;
  root.classList.toggle('cl-open',CL.open);
  if(CL.open)root.style.setProperty('--cl-w',$('#clPop').offsetWidth+'px');
}
$$('#clPop .cl-rs').forEach(h=>{
  h.onpointerdown=e=>{
    if(e.button!==0)return;
    e.preventDefault();
    const pop=$('#clPop'),root=document.documentElement,mode=h.dataset.rs,r=pop.getBoundingClientRect();
    const start={x:e.clientX,y:e.clientY,w:pop.offsetWidth,h:pop.offsetHeight};
    const maxW=r.right-22,maxH=r.bottom-56;
    if(CL.big){CL.size={w:start.w,h:start.h};setClaudeBig(false);}
    h.setPointerCapture(e.pointerId);
    h.classList.add('on');pop.classList.add('resizing');
    root.style.setProperty('--cl-cursor',getComputedStyle(h).cursor);root.classList.add('cl-resizing');
    const clamp=(v,a,b)=>Math.round(Math.max(a,Math.min(b,v)));
    const move=ev=>{
      CL.size={w:mode==='t'?start.w:clamp(start.w+start.x-ev.clientX,CL_MIN_W,maxW),h:mode==='l'?start.h:clamp(start.h+start.y-ev.clientY,CL_MIN_H,maxH)};
      applyClaudeSize();
    };
    const up=()=>{
      h.removeEventListener('pointermove',move);h.removeEventListener('pointerup',up);h.removeEventListener('pointercancel',up);
      h.classList.remove('on');pop.classList.remove('resizing');root.classList.remove('cl-resizing');
      try{localStorage.setItem('ssh.chatSize',JSON.stringify(CL.size));}catch(e){}
    };
    h.addEventListener('pointermove',move);h.addEventListener('pointerup',up);h.addEventListener('pointercancel',up);
  };
  h.ondblclick=()=>{CL.size=null;try{localStorage.removeItem('ssh.chatSize');}catch(e){}if(CL.big)setClaudeBig(false);else applyClaudeSize();};
});
window.addEventListener('resize',syncClaudeInset);
applyClaudeSize();
$('#clFab').onclick=()=>CL.open?closeClaude():openClaude();
$('#clMin').onclick=closeClaude;
$('#clPicker').onclick=()=>{$('#clMenu').hidden?openClMenu():closeClMenu();};
$('#clMenu').onclick=e=>{
  if(e.target.closest('[data-do]')){closeClMenu();return;}
  const b=e.target.closest('[data-conn]');if(!b)return;
  closeClMenu();
  if(b.dataset.conn!==CL.connId){CL.connId=b.dataset.conn;renderClaude();}
  const t=$('#clText');if(t)t.focus();
};
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#clMenu,#clPicker'))closeClMenu();});
$('#clBig').onclick=()=>setClaudeBig(!CL.big);
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&CL.open&&!modalStack.length&&e.target.closest&&e.target.closest('#clPop')){e.preventDefault();if(!$('#clMenu').hidden)closeClMenu();else closeClaude();}
});
if(window.agentAPI){
  window.agentAPI.onStatus(p=>{
    const chat=clChatById(p.chatId);if(!chat)return;
    chat.state=p.state;
    if(p.state==='ready'&&p.resumed&&!chat.resumedNoted){
      chat.resumedNoted=true;
      chat.items.push({kind:'info',text:'Продолжаю предыдущий разговор — контекст восстановлен'});
    }
    if(p.state==='ready'&&chat.pendingPrompt){
      const text=chat.pendingPrompt;chat.pendingPrompt=null;
      window.agentAPI.prompt(chat.chatId,text).then(r=>{if(!r.ok){chat.busy=false;chat.items.push({kind:'info',error:true,text:r.error});clQueueRender();}});
    }
    if(p.state==='closed'){
      chat.busy=false;chat.pendingPrompt=null;
      chat.items.forEach(i=>{if((i.kind==='approval'||i.kind==='permission')&&i.state==='pending')i.state='expired';if(i.approval&&i.approval.state==='pending')i.approval.state='expired';});
      const normal=/^(Чат завершён|Начат новый чат)$/.test(p.message);
      if(p.message&&!normal){
        chat.items.push({kind:'info',error:true,text:p.message});
        logEvent('err','claude','Claude остановлен: '+p.message,clTarget(chat));
      }
    }
    clQueueRender();
  });
  window.agentAPI.onUpdate(({chatId,update:u})=>{
    const chat=clChatById(chatId);if(!chat)return;
    const last=chat.items[chat.items.length-1];
    if(u.sessionUpdate==='agent_message_chunk'||u.sessionUpdate==='agent_thought_chunk'){
      if(!u.content||u.content.type!=='text')return;
      const kind=u.sessionUpdate==='agent_message_chunk'?'agent':'thought';
      if(last&&last.kind===kind&&!last.closed)last.text+=u.content.text;
      else chat.items.push({kind:kind,text:u.content.text});
    }else if(u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update'){
      if(last&&(last.kind==='agent'||last.kind==='thought'))last.closed=true;
      let it=chat.items.find(i=>i.kind==='tool'&&i.id===u.toolCallId);
      if(!it){it={kind:'tool',id:u.toolCallId};chat.items.push(it);}
      if(u.title!=null)it.title=u.title;
      if(u.status!=null)it.status=u.status;
      if(u.rawInput!=null)it.rawInput=u.rawInput;
      if(u.content!=null)it.content=u.content;
      if(u._meta&&u._meta.claudeCode&&u._meta.claudeCode.toolName)it.toolName=u._meta.claudeCode.toolName;
    }else if(u.sessionUpdate==='plan'){
      let it=chat.items.find(i=>i.kind==='plan'&&!i.done);
      if(!it){it={kind:'plan'};chat.items.push(it);}
      it.entries=u.entries||[];
      if(it.entries.length&&it.entries.every(e=>e.status==='completed'))it.done=true;
    }else return;
    clQueueRender();
  });
  window.agentAPI.onStop(p=>{
    const chat=clChatById(p.chatId);if(!chat)return;
    chat.busy=false;
    const last=chat.items[chat.items.length-1];if(last)last.closed=true;
    if(p.error){
      const msg=String(p.error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'').replace(/^Internal error:\s*/i,'');
      const limit=/session limit|usage limit|hit your .*limit/i.test(msg);
      chat.items.push({kind:'info',error:true,text:limit?'Исчерпан лимит подписки Claude Code — '+msg:msg});
    }
    else if(p.stopReason==='cancelled')chat.items.push({kind:'info',text:'Остановлено'});
    else if(p.stopReason==='refusal')chat.items.push({kind:'info',error:true,text:'Claude отказался выполнять этот запрос'});
    else if(p.stopReason==='max_tokens'||p.stopReason==='max_turn_requests')chat.items.push({kind:'info',text:'Ответ прерван по лимиту — напишите «продолжай»'});
    clQueueRender();
  });
  window.agentAPI.onApproval(p=>{
    const chat=clChatById(p.chatId);if(!chat)return;
    const last=chat.items[chat.items.length-1];if(last&&(last.kind==='agent'||last.kind==='thought'))last.closed=true;
    const ap={kind:'approval',chatId:p.chatId,approvalId:p.approvalId,tool:p.tool,summary:p.summary,detail:p.detail,state:'pending'};
    // Attach to the tool card that asked, so the command appears once, with its buttons.
    const owner=[...chat.items].reverse().find(i=>i.kind==='tool'&&clShortTool(i.toolName)===p.tool&&!i.approval&&i.status!=='completed'&&i.status!=='failed');
    if(owner)owner.approval=ap;else chat.items.push(ap);
    if(!CL.open)toast('Claude ждёт подтверждения: '+(CL_TOOL_LABELS[p.tool]||p.tool),'warn','Claude');
    clQueueRender();
  });
  window.agentAPI.onApprovalClosed(p=>{const it=clFindItem('approvalId',p.approvalId);if(it&&it.state==='pending'){it.state='expired';clQueueRender();}});
  window.agentAPI.onPermission(p=>{
    const chat=clChatById(p.chatId);if(!chat)return;
    chat.items.push({kind:'permission',chatId:p.chatId,requestId:p.requestId,title:p.title,toolName:p.toolName,rawInput:p.rawInput,options:p.options,state:'pending'});
    if(!CL.open)toast('Claude запрашивает разрешение: '+(p.title||p.toolName),'warn','Claude');
    clQueueRender();
  });
  window.agentAPI.onAction(p=>{
    const chat=clChatById(p.chatId);
    logEvent('ok','claude',(CL_TOOL_LABELS[p.tool]||p.tool)+' выполнено ('+p.result+'): '+String(p.summary).slice(0,200),clTarget(chat));
  });
  window.agentAPI.detect(false).then(d=>{CL.detect=d;renderClaudeSettings();if(CL.open)renderClaude();});
}
function renderClaudeSettings(){
  const el=$('#clSettingsState');if(!el)return;
  const d=CL.detect;
  el.innerHTML=!d?'<span class="hint" style="margin:0">проверка…</span>'
    :d.found?'<span class="pill on"><span class="sdot"></span>обнаружен</span> <span class="mono">'+esc(d.version||'')+'</span><div class="fpath" style="margin-top:9px">'+esc(d.path)+'</div>'
    :'<span class="pill err"><span class="sdot"></span>не найден</span><p class="hint" style="margin:8px 0 0">'+esc(d.error||'')+'</p>';
}
$('#btnClaudeDetect').onclick=async()=>{CL.detect=null;renderClaudeSettings();CL.detect=await window.agentAPI.detect(true);renderClaudeSettings();if(CL.open)renderClaude();};
