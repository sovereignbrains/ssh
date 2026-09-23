"use strict";
/* ---------------- CLAUDE (Claude Code over ACP, acting on the SSH server) ---------------- */
const CL={detect:null,connId:null,chats:{},drafts:{},attach:{},freshWanted:{},loaded:{},renderQueued:false,open:false,big:false,
  stick:true,render:{connId:null,html:[]}};
let clPersistTimer=null;
function clPersistItem(it){
  // dataUrl is derived from data+mimeType — drop it before saving to halve image storage.
  if(it.attachments&&it.attachments.length)return {...it,attachments:it.attachments.map(a=>({id:a.id,mimeType:a.mimeType,data:a.data}))};
  return it;
}
function clSchedulePersist(){
  if(clPersistTimer)return;
  clPersistTimer=setTimeout(()=>{
    clPersistTimer=null;
    for(const chat of Object.values(CL.chats)){
      const pid=clProfileId(chat.connId);
      if(pid)window.agentAPI.saveTranscript(pid,(chat.items||[]).map(clPersistItem));
    }
  },900);
}
function clHydrate(connId){
  if(CL.loaded[connId]||CL.chats[connId]||CL.freshWanted[connId])return;
  CL.loaded[connId]=true;
  const pid=clProfileId(connId);
  if(!pid||!window.agentAPI)return;
  window.agentAPI.loadTranscript(pid).then(r=>{
    if(!r||!r.ok||!r.items||!r.items.length||CL.chats[connId])return;
    const items=r.items.map(it=>{
      if(it.attachments&&it.attachments.length)it={...it,attachments:it.attachments.map(a=>({...a,dataUrl:'data:'+a.mimeType+';base64,'+a.data}))};
      if((it.kind==='approval'||it.kind==='permission')&&it.state==='pending')it={...it,state:'expired'};
      if(it.approval&&it.approval.state==='pending')it={...it,approval:{...it.approval,state:'expired'}};
      return it;
    });
    CL.chats[connId]={connId,state:'closed',busy:false,items};
    if(CL.open)renderClaude();
  });
}
const CL_MAX_IMG=8,CL_MAX_DIM=1568,CL_MAX_TEXT_BYTES=256*1024;
const CL_TEXT_EXT=/\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|conf|cfg|log|csv|tsv|xml|html?|css|scss|less|jsx?|mjs|cjs|tsx?|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|env|gitignore|dockerfile)$/i;
function clIsTextFile(f){return f.type.startsWith('text/')||f.type==='application/json'||CL_TEXT_EXT.test(f.name);}
function clReadTextFile(file){
  return new Promise((resolve,reject)=>{
    const fr=new FileReader();
    fr.onerror=()=>reject(fr.error||new Error('read failed'));
    fr.onload=()=>resolve({id:uid('att'),kind:'text',name:file.name,mimeType:file.type||'text/plain',text:String(fr.result)});
    fr.readAsText(file);
  });
}
function clAttachList(connId){connId=connId||CL.connId;return CL.attach[connId]||(CL.attach[connId]=[]);}
function clReadImageFile(file){
  return new Promise((resolve,reject)=>{
    // CSP is img-src 'self' data: (no blob:) — read as a data: URL directly, not via createObjectURL.
    const fr=new FileReader();
    fr.onerror=()=>reject(fr.error||new Error('read failed'));
    fr.onload=()=>{
      const img=new Image();
      img.onload=()=>{
        const scale=Math.min(1,CL_MAX_DIM/Math.max(img.naturalWidth,img.naturalHeight));
        const w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale));
        const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
        canvas.getContext('2d').drawImage(img,0,0,w,h);
        const mime=scale<1||file.type!=='image/png'?'image/jpeg':'image/png';
        const dataUrl=canvas.toDataURL(mime,0.88);
        resolve({id:uid('att'),kind:'image',mimeType:mime,dataUrl,data:dataUrl.slice(dataUrl.indexOf(',')+1)});
      };
      img.onerror=()=>reject(new Error('bad image'));
      img.src=fr.result;
    };
    fr.readAsDataURL(file);
  });
}
async function clAddFiles(files){
  const list=clAttachList();
  const arr=Array.from(files||[]).filter(Boolean);
  const imgs=arr.filter(f=>f.type.startsWith('image/'));
  const texts=arr.filter(f=>!f.type.startsWith('image/')&&clIsTextFile(f));
  const rejected=arr.filter(f=>!imgs.includes(f)&&!texts.includes(f));
  if(rejected.length)toast('Не поддерживается (только изображения и текстовые файлы): '+rejected.map(f=>f.name).join(', '),'warn','Claude');
  if(imgs.length){
    const room=CL_MAX_IMG-list.filter(a=>a.kind==='image').length;
    if(room<=0)toast('Не больше '+CL_MAX_IMG+' изображений в одном сообщении','warn','Claude');
    else{
      if(imgs.length>room)toast('Добавлены первые '+room+' — лимит '+CL_MAX_IMG+' изображений','warn','Claude');
      for(const f of imgs.slice(0,room)){
        try{list.push(await clReadImageFile(f));}catch(e){toast('Не удалось прочитать изображение','err','Claude');}
      }
    }
  }
  for(const f of texts){
    if(f.size>CL_MAX_TEXT_BYTES){toast('Файл «'+f.name+'» больше 256 КБ — пропущен','warn','Claude');continue;}
    try{list.push(await clReadTextFile(f));}catch(e){toast('Не удалось прочитать «'+f.name+'»','err','Claude');}
  }
  clRenderAttach();clSyncSend();
}
function clRenderAttach(){
  const box=$('#clAttach');if(!box)return;
  const list=clAttachList();
  box.hidden=!list.length;
  box.innerHTML=list.map(a=>a.kind==='text'
    ?'<span class="cl-att-chip cl-att-file" title="'+esc(a.name)+'">'+IC('file')+'<b>'+esc(a.name.length>16?a.name.slice(0,14)+'…':a.name)+'</b><button type="button" data-att="'+a.id+'" title="Убрать">'+IC('x')+'</button></span>'
    :'<span class="cl-att-chip"><img src="'+a.dataUrl+'" alt=""><button type="button" data-att="'+a.id+'" title="Убрать">'+IC('x')+'</button></span>').join('');
}
function clBuildContent(text,atts){
  if(!atts.length)return text;
  const blocks=atts.map(a=>a.kind==='text'
    ?{type:'resource',resource:{uri:'attachment:///'+encodeURIComponent(a.name),mimeType:a.mimeType,text:a.text}}
    :{type:'image',data:a.data,mimeType:a.mimeType});
  if(text)blocks.push({type:'text',text:text});
  return blocks;
}
function clOpenLightbox(src){
  const el=document.createElement('div');
  el.className='cl-lightbox';
  el.innerHTML='<button class="cl-lb-x" title="Закрыть (Esc)">'+IC('x')+'</button><img src="'+src+'" alt="">';
  document.body.appendChild(el);
  const onKey=e=>{if(e.key==='Escape')close();};
  const close=()=>{el.remove();document.removeEventListener('keydown',onKey);};
  el.addEventListener('click',e=>{if(e.target===el)close();});
  el.querySelector('.cl-lb-x').onclick=close;
  el.querySelector('img').onclick=e=>e.currentTarget.classList.toggle('full');
  document.addEventListener('keydown',onKey);
}
const CL_LOCAL={connId:'local',local:true,name:'Этот компьютер'};
function clTargets(){return [CL_LOCAL,...fxLiveTabs()];}
function clIsLocal(connId){return connId===CL_LOCAL.connId;}
function clProfileId(connId){const t=clTab(connId);return t?(t.local?'local':t.session):null;}
function clTargetIco(t){return t.local?'<span class="cl-pk-os cl-pk-local">'+IC('terminal')+'</span>':'<span class="cl-pk-os" style="--osc:'+osOf(t.os).color+'">'+IC(osOf(t.os).icon)+'</span>';}
function clTargetSub(t){return t.local?'этот компьютер':t.user+'@'+t.host+(String(t.port)!=='22'?':'+t.port:'');}
const CL_TOOL_LABELS={run_command:'Команда',run_command_secret:'Команда с секретом',read_file:'Чтение файла',list_directory:'Список папки',write_file:'Запись файла',edit_file:'Правка файла'};
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
  clSchedulePersist();
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
function clCopyBtn(text){return text?'<button type="button" class="cl-copy" data-copy="'+esc(text)+'" title="Копировать текст">'+IC('copy')+'</button>':'';}
function clItemHtml(it){
  if(it.kind==='user')return '<div class="cl-msg user">'+(it.attachments&&it.attachments.length?'<div class="cl-msg-imgs">'+it.attachments.map(a=>'<img src="'+a.dataUrl+'" alt="">').join('')+'</div>':'')+(it.text?clMd(it.text):'')+clCopyBtn(it.text)+'</div>';
  if(it.kind==='agent')return '<div class="cl-msg agent">'+clMd(it.text)+clCopyBtn(it.text)+'</div>';
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
// Incremental render: only items whose HTML changed are swapped, so text selection, open
// details and the scroll position survive a streaming answer.
function clNodeFrom(html){const t=document.createElement('template');t.innerHTML=html;return t.content.firstElementChild;}
function clStripHtml(chat){
  return (chat&&chat.busy?'<div class="cl-typing"><span class="cl-think">'+IC('claude')+'</span> Claude работает…</div>':'')+
    (CL.stick?'':'<button class="cl-jump" id="clJump" title="Прокрутить к новым сообщениям">'+IC('chev-down')+'<span>вниз</span></button>');
}
function renderClaudeLog(){
  const log=$('#clLog');if(!log){renderClaude();return;}
  const chat=CL.chats[CL.connId];
  const list=chat?chat.items.map(clItemHtml).filter(Boolean):[];
  if(CL.render.connId!==CL.connId){CL.render={connId:CL.connId,html:[]};log.innerHTML='';}
  if(!list.length){
    if(CL.render.html.length||!log.firstElementChild){
      log.innerHTML='<div class="cl-empty">'+IC('claude','xl')+'<h4>Спросите Claude о сервере</h4><p>Например: «почему не стартует nginx?», «сколько места на дисках и что занимает больше всего?», «обнови пакеты и перезапусти сервис».</p></div>';
      CL.render.html=[];
    }
  }else{
    if(!CL.render.html.length)log.innerHTML='';
    const prev=CL.render.html;
    for(let i=0;i<list.length;i++){
      if(list[i]===prev[i])continue;
      const node=clNodeFrom(list[i]),cur=log.children[i];
      if(cur&&cur.tagName===node.tagName&&cur.className===node.className){cur.innerHTML=node.innerHTML;continue;}
      if(cur)log.replaceChild(node,cur);else log.appendChild(node);
    }
    while(log.children.length>list.length)log.lastElementChild.remove();
    CL.render.html=list;
  }
  const strip=$('#clStrip');if(strip)strip.innerHTML=clStripHtml(chat);
  if(CL.stick)log.scrollTop=log.scrollHeight;
  const top=$('#clStatus');if(top)top.outerHTML=clStatusHtml(chat);
  const cfg=$('#clConfigRow');if(cfg)cfg.innerHTML=clCfgPills(chat);
  const usg=$('#clUsage');if(usg)usg.innerHTML=clUsageHtml(chat);
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
  b.disabled=mode==='wait'||(mode==='send'&&!ta.value.trim()&&!clAttachList().length);
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
function clCfgValues(o){return (o.options||[]).flatMap(x=>x.options?x.options:[x]);}
// Own dark menu instead of a native <select>: the OS popup ignores the app theme.
function clOpenCfgMenu(btn){
  const chat=CL.chats[CL.connId];if(!chat)return;
  const o=((chat.configOptions)||[]).find(x=>x.id===btn.dataset.config);if(!o)return;
  const m=$('#clCfgMenu');
  m.dataset.config=o.id;
  m.innerHTML='<div class="cl-menu-h">'+esc(o.name)+'</div>'+clCfgValues(o).map(v=>
    '<button class="cl-mi'+(v.value===o.currentValue?' on':'')+'" data-value="'+esc(v.value)+'">'+
      '<span class="cl-mi-t"><b>'+esc(v.name)+'</b>'+(v.description?'<small>'+esc(v.description)+'</small>':'')+'</span>'+
      '<span class="cl-mi-ck">'+(v.value===o.currentValue?IC('check'):'')+'</span></button>').join('');
  m.hidden=false;
  const pop=$('#clPop').getBoundingClientRect(),r=btn.getBoundingClientRect();
  m.style.left=Math.max(8,Math.min(r.left-pop.left,pop.width-m.offsetWidth-8))+'px';
  m.style.bottom=(pop.bottom-r.top+8)+'px';
  btn.classList.add('open');
}
function closeClCfgMenu(){
  const m=$('#clCfgMenu');if(!m||m.hidden)return;
  m.hidden=true;
  $$('.cl-pill.open').forEach(b=>b.classList.remove('open'));
}
function clCfgPills(chat){
  if(!chat||chat.state!=='ready')return '';
  return ((chat.configOptions)||[]).filter(o=>o.type==='select').map(o=>{
    const cur=clCfgValues(o).find(v=>v.value===o.currentValue);
    return '<button class="cl-pill" data-config="'+esc(o.id)+'" title="'+esc(o.name)+'">'+
      esc((cur&&cur.name)||o.currentValue)+IC('chev-down','cl-pill-chev')+'</button>';
  }).join('');
}
// Context fill is what runs out first, so it leads; session cost rides along when the agent reports it.
// Context fill reads like a battery gauge in the header; the session cost lives in its tooltip.
function clUsageHtml(chat){
  const u=chat&&chat.usage;
  if(!u||!u.size)return '';
  const pct=Math.min(100,Math.round(u.used/u.size*100));
  const level=pct>=85?' hot':pct>=60?' warn':'';
  const title='Контекст: '+u.used.toLocaleString('ru-RU')+' из '+u.size.toLocaleString('ru-RU')+' токенов ('+pct+'%)'+
    (u.cost?'. Стоимость сессии: $'+u.cost.amount.toFixed(4):'');
  return '<span class="cl-batt'+level+'" title="'+esc(title)+'">'+
    '<span class="cl-batt-bar"><i style="width:'+Math.max(pct,3)+'%"></i></span>'+
    '<span class="cl-batt-t">'+pct+'%</span></span>';
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
  clHydrate(CL.connId);
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
      '<span id="clUsage"></span>'+
      '<button class="ibtn" id="clForget" title="Забыть разговор и все «разрешать всегда» для этого сервера">'+IC('trash')+'</button>'+
      '<button class="btn sm ghost" id="clNew">'+IC('plus')+' Новый чат</button></div>'+
    '<div class="cl-log" id="clLog"></div>'+
    '<div class="cl-strip" id="clStrip"></div>'+
    '<div class="cl-compose"><div class="cl-attach" id="clAttach" hidden></div><div class="cl-box">'+
      '<textarea id="clText" rows="1" placeholder="'+(clIsLocal(CL.connId)?'Спросите Claude об этом компьютере…':'Спросите Claude о сервере…')+'" spellcheck="false"></textarea>'+
      '<input type="file" id="clFile" accept="image/*,text/*,.md,.json,.yml,.yaml,.toml,.ini,.conf,.cfg,.log,.csv,.tsv,.xml,.css,.scss,.less,.js,.mjs,.cjs,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.hpp,.cs,.php,.sh,.bash,.ps1,.sql,.env" multiple hidden>'+
      '<div class="cl-tools">'+
        '<button class="ibtn cl-clip" id="clClip" title="Прикрепить изображение или текстовый файл">'+IC('file')+'</button>'+
        '<span class="cl-config-row" id="clConfigRow"></span>'+
        '<span style="flex:1"></span>'+
        '<button class="cl-send" id="clSend"></button>'+
      '</div></div>'+
      '<div class="cl-hint"><span><span class="kbd">Enter</span> отправить</span><span><span class="kbd">Shift+Enter</span> новая строка</span><span>вставьте скриншот или перетащите файл</span></div>'+
    '</div>'+
  '</div>';
  const ta=$('#clText');
  ta.value=CL.drafts[CL.connId]||'';
  CL.render={connId:null,html:[]}; // the box was just rebuilt, so nothing is rendered yet
  renderClaudeLog();
  clGrow(ta);
  clRenderAttach();
  ta.oninput=()=>{CL.drafts[CL.connId]=ta.value;clGrow(ta);clSyncSend();};
  ta.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();clSend();}};
  ta.onpaste=e=>{
    const items=e.clipboardData?Array.from(e.clipboardData.items):[];
    const files=items.filter(it=>it.kind==='file'&&it.type.startsWith('image/')).map(it=>it.getAsFile()).filter(Boolean);
    if(files.length){e.preventDefault();clAddFiles(files);}
  };
  const clBox=$('.cl-box');
  clBox.ondragover=e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();clBox.classList.add('drag');}};
  clBox.ondragleave=()=>clBox.classList.remove('drag');
  clBox.ondrop=e=>{
    e.preventDefault();clBox.classList.remove('drag');
    const files=Array.from(e.dataTransfer.files||[]);
    if(files.length)clAddFiles(files);
  };
  $('#clConfigRow').onclick=e=>{
    const b=e.target.closest('.cl-pill');if(!b)return;
    if(b.classList.contains('open')){closeClCfgMenu();return;}
    closeClCfgMenu();clOpenCfgMenu(b);
  };
  $('#clClip').onclick=()=>$('#clFile').click();
  $('#clFile').onchange=e=>{if(e.target.files.length)clAddFiles(e.target.files);e.target.value='';};
  $('#clAttach').onclick=e=>{
    const b=e.target.closest('[data-att]');if(!b)return;
    const list=clAttachList();
    const i=list.findIndex(a=>a.id===b.dataset.att);
    if(i>=0)list.splice(i,1);
    clRenderAttach();clSyncSend();
  };
  $('#clSend').onclick=()=>{
    const c=CL.chats[CL.connId];
    if($('#clSend').dataset.mode==='stop'){if(c)window.agentAPI.cancel(c.chatId);return;}
    clSend();
  };
  $('#clNew').onclick=async()=>{
    {const pid=clProfileId(CL.connId);if(pid)window.agentAPI.saveTranscript(pid,[]);}
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
  // Scrolling up pins the view; coming back to the bottom resumes following the answer.
  log.onscroll=()=>{
    const atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<40;
    if(atBottom!==CL.stick){CL.stick=atBottom;clQueueRender();}
  };
  $('#clStrip').onclick=e=>{
    if(!e.target.closest('#clJump'))return;
    CL.stick=true;log.scrollTop=log.scrollHeight;clQueueRender();
  };
  log.onclick=e=>{
    const cp=e.target.closest('.cl-copy');
    if(cp){navigator.clipboard&&navigator.clipboard.writeText(cp.dataset.copy).catch(()=>{});toast('Скопировано','ok','Claude');return;}
    const img=e.target.closest('.cl-msg-imgs img');
    if(img){clOpenLightbox(img.src);return;}
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
  const text=ta.value.trim();
  const atts=clAttachList().slice();
  if((!text&&!atts.length)||!CL.connId)return;
  let chat=CL.chats[CL.connId];
  if(chat&&(chat.busy||chat.state==='starting'))return;
  ta.value='';delete CL.drafts[CL.connId];clGrow(ta);CL.stick=true;
  CL.attach[CL.connId]=[];clRenderAttach();clSyncSend();
  const content=clBuildContent(text,atts);
  if(!chat||chat.state==='closed'){
    const fresh=!!CL.freshWanted[CL.connId];delete CL.freshWanted[CL.connId];
    const r=await window.agentAPI.start(CL.connId,clProfileId(CL.connId),fresh);
    if(!r.ok){toast(r.error,'err','Claude');ta.value=text;CL.drafts[CL.connId]=text;CL.attach[CL.connId]=atts;clGrow(ta);clRenderAttach();clSyncSend();return;}
    const prev=chat?chat.items:[];
    chat=CL.chats[CL.connId]={chatId:r.chatId,connId:CL.connId,state:'starting',busy:true,items:prev,pendingPrompt:content};
    if(fresh&&prev.length)chat.items.push({kind:'info',text:'Начат новый чат — предыдущий контекст сброшен'});
    logEvent('info','claude','Запущен Claude Code',clTarget(chat));
    chat.items.push({kind:'user',text:text,attachments:atts});
    clQueueRender();
    return;
  }
  chat.busy=true;
  chat.items.push({kind:'user',text:text,attachments:atts});
  clQueueRender();
  const r=await window.agentAPI.prompt(chat.chatId,content);
  if(!r.ok){chat.busy=false;chat.items.push({kind:'info',error:true,text:r.error});clQueueRender();}
}
/* ---- floating chat: launcher bottom-right, panel opens above it ---- */
function openClaude(connId){
  const f=focusedSshTab();
  if(connId)CL.connId=connId;
  else if(f&&!(CL.chats[CL.connId]&&CL.chats[CL.connId].busy))CL.connId=f.connId;
  CL.open=true;CL.stick=true;
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
const CL_MIN_W=360,CL_MIN_H=380,CL_PUSH_MAX=520;
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
  if(CL.open)root.style.setProperty('--cl-w',Math.min($('#clPop').offsetWidth,CL_PUSH_MAX)+'px');
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
  if(b.dataset.conn!==CL.connId){CL.connId=b.dataset.conn;CL.stick=true;renderClaude();}
  const t=$('#clText');if(t)t.focus();
};
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#clMenu,#clPicker'))closeClMenu();});
$('#clCfgMenu').onclick=e=>{
  const b=e.target.closest('[data-value]');if(!b)return;
  const chat=CL.chats[CL.connId],configId=$('#clCfgMenu').dataset.config;
  closeClCfgMenu();
  if(!chat||!chat.chatId)return;
  window.agentAPI.setConfigOption(chat.chatId,configId,b.dataset.value).then(r=>{if(!r.ok)toast(r.error,'err','Claude');});
};
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#clCfgMenu,.cl-pill'))closeClCfgMenu();});
/* ---- custom right-click menu, scoped to the chat panel only ---- */
async function clCtxPaste(){
  const ta=$('#clText');
  try{
    // A screenshot (Win+Shift+S etc.) has no text representation - readText() below would just
    // insert nothing. Check for image data first, same clAddFiles path as the native Ctrl+V handler.
    if(navigator.clipboard.read){
      try{
        const items=await navigator.clipboard.read();
        const files=[];
        for(const item of items){
          const type=item.types.find(t=>t.startsWith('image/'));
          if(type)files.push(new File([await item.getType(type)],'clipboard.'+type.split('/')[1],{type}));
        }
        if(files.length){await clAddFiles(files);return;}
      }catch(_){}
    }
    const t=await navigator.clipboard.readText();
    const s=ta.selectionStart,en=ta.selectionEnd;
    ta.focus();ta.setRangeText(t,s,en,'end');
    ta.dispatchEvent(new Event('input',{bubbles:true}));
  }catch(err){ta.focus();document.execCommand('paste');}
}
function clCtxItems(e){
  const ta=$('#clText'),inTextarea=e.target===ta;
  const sel=inTextarea?ta.value.slice(ta.selectionStart,ta.selectionEnd):String(window.getSelection());
  const msg=e.target.closest('.cl-msg');
  const items=[];
  if(inTextarea){
    if(sel)items.push({label:'Вырезать',ic:'eraser',run:()=>document.execCommand('cut')});
    if(sel)items.push({label:'Копировать',ic:'copy',run:()=>document.execCommand('copy')});
    items.push({label:'Вставить',ic:'download',run:clCtxPaste});
    items.push({sep:true});
    items.push({label:'Выделить всё',ic:'check',run:()=>ta.select()});
  }else if(sel){
    items.push({label:'Копировать',ic:'copy',run:()=>{navigator.clipboard&&navigator.clipboard.writeText(sel).catch(()=>{});}});
  }
  if(msg&&msg.querySelector('.cl-copy')){
    if(items.length)items.push({sep:true});
    items.push({label:'Скопировать сообщение',ic:'copy',run:()=>{const b=msg.querySelector('.cl-copy');if(b)b.click();}});
  }
  if(items.length)items.push({sep:true});
  items.push({label:'Прикрепить файл',ic:'file',run:()=>$('#clFile').click()});
  return items;
}
function closeClCtxMenu(){const m=$('#clCtxMenu');if(m)m.hidden=true;}
function openClCtxMenu(e){
  if(!CL.open)return;
  e.preventDefault();
  closeClMenu();closeClCfgMenu();
  const m=$('#clCtxMenu'),items=clCtxItems(e);
  m.innerHTML=items.map((it,i)=>it.sep?'<div class="cl-ctx-sep"></div>':'<button type="button" class="cl-ctx-item" data-i="'+i+'"'+(it.disabled?' disabled':'')+'>'+IC(it.ic)+'<span>'+esc(it.label)+'</span></button>').join('');
  m._items=items;
  m.hidden=false;
  const pop=$('#clPop').getBoundingClientRect();
  const x=Math.max(8,Math.min(e.clientX-pop.left,pop.width-m.offsetWidth-8));
  const y=Math.max(8,Math.min(e.clientY-pop.top,pop.height-8-m.offsetHeight));
  m.style.left=x+'px';m.style.top=y+'px';
}
$('#clPop').addEventListener('contextmenu',openClCtxMenu);
$('#clCtxMenu').onclick=e=>{
  const b=e.target.closest('.cl-ctx-item');if(!b||b.disabled)return;
  const it=$('#clCtxMenu')._items[+b.dataset.i];
  closeClCtxMenu();
  if(it)it.run();
};
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#clCtxMenu'))closeClCtxMenu();});
$('#clBig').onclick=()=>setClaudeBig(!CL.big);
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&CL.open&&!modalStack.length&&e.target.closest&&e.target.closest('#clPop')){e.preventDefault();if(!$('#clCtxMenu').hidden)closeClCtxMenu();else if(!$('#clCfgMenu').hidden)closeClCfgMenu();else if(!$('#clMenu').hidden)closeClMenu();else closeClaude();}
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
    }else if(u.sessionUpdate==='config_option_update'){
      chat.configOptions=u.configOptions||[];
    }else if(u.sessionUpdate==='usage_update'){
      chat.usage={used:u.used,size:u.size,cost:u.cost||null};
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
