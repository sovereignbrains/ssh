"use strict";
/* ---------------- CONNECT UI ---------------- */
const connEl={
  card:$('#connCard'),os:$('#connOs'),title:$('#connTitle'),sub:$('#connSub'),
  bar:$('#connBar'),steps:$('#connSteps'),log:$('#connLog'),err:$('#connErr'),
  hint:$('#connHint'),cancel:$('#connCancel'),retry:$('#connRetry'),screen:$('#connectScreen')
};
let connAbort=null;
let errSessionId=null;

function buildSteps(list){
  connEl.steps.innerHTML=list.map((s,i)=>'<li class="step" data-i="'+i+'"><span class="s-ico"></span><span class="s-txt">'+s.t+'</span><span class="s-meta"></span></li>').join('');
}
function stepState(i,st,meta){
  const el=connEl.steps.querySelector('[data-i="'+i+'"]');if(!el)return;
  el.className='step '+st;
  el.querySelector('.s-ico').innerHTML = st==='active' ? '<span class="spinner" style="width:11px;height:11px;border-width:2px"></span>'
    : st==='done' ? IC('check') : st==='fail' ? IC('x') : '';
  if(meta!==undefined)el.querySelector('.s-meta').textContent=meta;
}
function clog(text,cls){
  const d=document.createElement('div');d.className=cls||'';d.textContent=text;
  connEl.log.appendChild(d);connEl.log.scrollTop=connEl.log.scrollHeight;
}
function openConnUI(s){
  const o=osOf(s.os);
  connEl.card.className='conn-card';
  connEl.os.style.setProperty('--osc',o.color);
  connEl.os.innerHTML=IC(o.icon);
  connEl.title.textContent='Подключение к '+s.name;
  connEl.sub.innerHTML=esc(s.user)+'@'+esc(s.host)+':'+s.port+' &nbsp;·&nbsp; <b style="color:'+o.color+'">'+esc(osLabel(s.os,s.osName))+'</b>';
  connEl.bar.style.width='0%';
  connEl.log.innerHTML='';
  connEl.err.textContent='';
  connEl.hint.innerHTML='<span class="spinner"></span> <b>Установление защищённого канала…</b>';
  connEl.cancel.style.display='';
  connEl.cancel.innerHTML=IC('x')+' Отмена';
  connEl.retry.style.display='none';
  connEl.screen.classList.add('on');
}
function closeConnUI(){
  connEl.screen.classList.remove('on');
  connAbort=null;
  if(errSessionId){
    const s=S.sessions.find(x=>x.id===errSessionId);
    if(s&&s.status==='error'){s.status='idle';renderSessions();}
    errSessionId=null;
  }
}
connEl.cancel.onclick=()=>{if(typeof connAbort==='function')connAbort('cancel');else closeConnUI();};
$('#connX').onclick=()=>{if(typeof connAbort==='function')connAbort('cancel');else closeConnUI();};
connEl.retry.onclick=()=>{const id=connEl.retry.dataset.id;closeConnUI();if(id)connectSession(id);};

const STEP_DEFS=[
  {t:'TCP-подключение и SSH-рукопожатие'},{t:'Key exchange (обмен ключами)'},
  {t:'Проверка ключа хоста'},{t:'Аутентификация пользователя'},
  {t:'Открытие интерактивной сессии'}
];

/* ---- global SSH data/close dispatch: connId -> tab ---- */
const connIdToTab={};
// The shell starts talking (banner, MOTD, prompt) before the tab exists; hold that output until it does.
const earlyData={};
function takeEarlyData(connId){const d=earlyData[connId];delete earlyData[connId];return d?d.chunks.join(''):'';}
// While the agent runs a command in this shell, its fence markers are cut out line by line: the user
// should see the command and its output, not the bookkeeping around them. Buffering only kicks in
// during an agent command, so interactive programs are never held back.
function writeTerm(tab,st,data){
  if(!tab.agentBusy){if(tab.mbuf){st.term.write(tab.mbuf);tab.mbuf='';}st.term.write(data,()=>st.term.scrollToBottom());return;}
  const buf=(tab.mbuf||'')+data;
  const cut=buf.lastIndexOf('\n');
  if(cut===-1){tab.mbuf=buf;return;}
  tab.mbuf=buf.slice(cut+1);
  const shown=buf.slice(0,cut+1).split('\n').filter(l=>!l.includes('__CC_')).join('\n');
  if(shown)st.term.write(shown,()=>st.term.scrollToBottom());
}
if(window.sshAPI){
  window.sshAPI.onData((p)=>{
    const tab=connIdToTab[p.connId];
    if(!tab){
      const d=earlyData[p.connId]||(earlyData[p.connId]={chunks:[],size:0});
      if(d.size<262144){d.chunks.push(p.data);d.size+=p.data.length;}
      return;
    }
    const st=xtermState[tab.id];
    if(st)writeTerm(tab,st,p.data);
  });
  window.sshAPI.onAgentBusy&&window.sshAPI.onAgentBusy((p)=>{
    const tab=connIdToTab[p.connId];if(!tab)return;
    tab.agentBusy=!!p.busy;
    const st=xtermState[tab.id];
    if(p.busy){if(st)st.term.write('\r\n\x1b[38;5;43m▸ Claude\x1b[0m\r\n');}
    else{if(st&&tab.mbuf&&!tab.mbuf.includes('__CC_'))st.term.write(tab.mbuf);tab.mbuf='';}
    refreshTab(tab);
  });
  window.sshAPI.onClosed((p)=>{
    const tab=connIdToTab[p.connId];if(!tab){delete earlyData[p.connId];return;}
    const st=xtermState[tab.id];
    if(st)st.term.write('\r\n\x1b[33mСоединение с '+tab.host+' закрыто. «Переподключить», чтобы открыть снова.\x1b[0m\r\n');
    tab.closed=true;
    const s=S.sessions.find(x=>x.id===tab.session);
    logEvent('warn','disconnect','Соединение закрыто сервером'+(tab.connectedAt?' · длительность '+fmtDuration(Date.now()-tab.connectedAt):''),s?sessTarget(s):tab.user+'@'+tab.host+':'+tab.port);
    if(s&&s.status==='active'&&!S.tabs.some(x=>x!==tab&&!x.local&&x.session===s.id&&!x.closed)){s.status='idle';renderSessions();}
    delete connIdToTab[p.connId];
    renderTunnelForm();updateBadges();
    if(fxShown())renderFiles();
    if(CL.open)renderClaude();
    refreshTab(tab);
  });
}

/* ---- remote OS auto-detection (/etc/os-release) ---- */
const pendingOs={};
function applyDetectedOs(tab,p){
  const os=osKeyFromRelease(p.id||'',p.idLike||'');
  tab.os=os;tab.osName=p.name||'';
  const s=S.sessions.find(x=>x.id===tab.session);
  if(s){s.os=os;s.osName=p.name||'';}
  renderSessions();renderTunnelForm();
  refreshTab(tab);
}
function osKeyFromRelease(id,idLike){
  const ids=(id+' '+idLike).split(/\s+/);
  const map={ubuntu:'ubuntu',debian:'debian',alpine:'alpine',arch:'arch',manjaro:'arch',fedora:'fedora',rocky:'rocky',rhel:'rocky',centos:'rocky',almalinux:'rocky',opensuse:'suse','opensuse-tumbleweed':'suse','opensuse-leap':'suse',sles:'suse',suse:'suse',freebsd:'freebsd'};
  for(const x of ids){if(map[x])return map[x];}
  return 'generic';
}
if(window.sshAPI){
  window.sshAPI.onOsDetected((p)=>{
    const tab=connIdToTab[p.connId];
    // The reply can beat tab creation on fast links — keep it until the tab exists.
    if(!tab){pendingOs[p.connId]=p;return;}
    applyDetectedOs(tab,p);
  });
}

/* ---- host key confirmation (TOFU), driven by main process ---- */
if(window.sshAPI){
  window.sshAPI.onHostKeyPrompt(async(p)=>{
    const ok=await confirmModal({
      title:p.isNew?'Неизвестный ключ хоста':'Ключ хоста изменился!',
      icon:p.isNew?'shield':'alert',
      danger:!p.isNew,
      text:(p.isNew
        ? 'Хост «<b>'+esc(p.host)+':'+p.port+'</b>» ранее не подключался. Отпечаток его ключа:'
        : '<b style="color:var(--err)">Внимание:</b> отпечаток ключа хоста «<b>'+esc(p.host)+':'+p.port+'</b>» не совпадает с ранее сохранённым — возможна подмена сервера (MITM) либо сервер был переустановлен.')+
        '<br><span class="mono" style="display:inline-block;margin-top:8px;word-break:break-all">'+esc(p.fingerprint)+'</span>'+
        (p.previous?'<br><span class="mono t-dim" style="display:inline-block;margin-top:4px;word-break:break-all">ранее: '+esc(p.previous)+'</span>':''),
      ok:p.isNew?'Доверять и продолжить':'Всё равно продолжить'
    });
    window.sshAPI.hostKeyDecision(p.promptId,ok);
    logEvent(ok?(p.isNew?'info':'warn'):'err','hostkey',
      (p.isNew?(ok?'Новый ключ хоста принят: ':'Новый ключ хоста отклонён: '):(ok?'Ключ хоста ИЗМЕНИЛСЯ и принят вручную: ':'Ключ хоста изменился — подключение отклонено: '))+p.fingerprint,
      p.host+':'+p.port);
  });
}

// ipcRenderer.invoke wraps rejections as "Error invoking remote method 'x': Error: ..."; strip that and explain common failures.
function humanSshError(err){
  const raw=String((err&&err.message)||err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
  const known=[
    [/All configured authentication methods failed/i,'Сервер отклонил вход: неверный пользователь, пароль или ключ'],
    [/ECONNREFUSED/,'Соединение отклонено: на этом порту SSH не слушает'],
    [/ETIMEDOUT|Timed out while waiting for handshake/i,'Хост не отвечает (таймаут)'],
    [/ENOTFOUND|EAI_AGAIN/,'Хост не найден: проверьте имя или DNS'],
    [/EHOSTUNREACH|ENETUNREACH/,'Хост недоступен из этой сети'],
    [/ECONNRESET/,'Сервер разорвал соединение'],
    [/Host denied|verification failed/i,'Подключение отменено: ключ хоста не принят']
  ];
  const hit=known.find(k=>k[0].test(raw));
  return hit&&hit[1]!==raw?hit[1]+' ('+raw+')':raw;
}
async function connectSession(id,rowOrBtn,opts){
  const s=S.sessions.find(x=>x.id===id);
  if(!s)return;
  if(!window.sshAPI){toast('SSH-модуль недоступен в этой сборке','err','Ошибка');return;}
  if(s.status==='connecting'){toast('Подключение уже выполняется — смотрите окно прогресса','warn','Занято');return;}
  if(!S.vaultOpen){toast('Сейф заблокирован — сначала введите мастер-пароль','err','Отказано');lockScreenFocus();return;}
  const open=S.tabs.find(t=>!t.local&&t.session===id&&!t.closed);
  if(open&&!(opts&&opts.replace)){
    toast('«'+s.name+'» уже открыта — переключаю на вкладку','info','Терминал');
    openTab(open.id);return;
  }
  // A tab whose connection dropped is reused: same place in the strip, same scrollback.
  const stale=S.tabs.find(t=>t.id===(opts&&opts.replace))||S.tabs.find(t=>!t.local&&t.session===id&&t.closed);
  let keyEntry=null;
  if(s.auth==='key'){
    if(s.keyId){
      keyEntry=S.keys.find(k=>k.id===s.keyId&&k.privateKey);
      if(!keyEntry){toast('Ключ этой сессии удалён из клиента — выберите другой в «Изменить»','err','Нет ключа');return;}
    }else if(!s.keyPath){toast('У сессии не указан ключ — откройте «Изменить»','err','Нет ключа');return;}
  }

  const btn=(rowOrBtn&&rowOrBtn.classList&&rowOrBtn.classList.contains('ibtn'))?rowOrBtn:(rowOrBtn?rowOrBtn.querySelector('.ibtn.ok'):null);
  s.status='connecting';renderSessions();
  if(btn){btn.innerHTML='<span class="spinner"></span>';btn.classList.add('spin');}

  buildSteps(STEP_DEFS);
  openConnUI(s);

  const startedAt=performance.now();
  const connId=uid('c');
  let aborted=false;

  connAbort=()=>{aborted=true;window.sshAPI.disconnect(connId);delete earlyData[connId];closeConnUI();s.status='idle';renderSessions();toast('Подключение к «'+s.name+'» прервано пользователем','warn','Отменено');logEvent('warn','connect','Подключение отменено пользователем',sessTarget(s));};

  const onProgress=(p)=>{
    if(p.connId!==connId)return;
    connEl.bar.style.width=Math.round(((p.step+(p.status==='done'?1:0))/STEP_DEFS.length)*100)+'%';
    stepState(p.step,p.status,p.status==='fail'?'сбой':(p.meta||(p.status==='active'?'…':'')));
  };
  const onLog=(p)=>{ if(p.connId===connId)clog(p.text,p.cls); };
  window.sshAPI.onProgress(onProgress);
  window.sshAPI.onLog(onLog);

  let result;
  try{
    result=await window.sshAPI.connect({
      connId,host:s.host,port:s.port||22,username:s.user,authType:s.auth,
      password:s.password||'',keyPath:keyEntry?'':(s.keyPath||''),
      privateKeyText:keyEntry?keyEntry.privateKey:'',
      passphrase:keyEntry?(keyEntry.passphrase||''):(s.passphrase||'')
    });
  }catch(err){
    delete earlyData[connId];
    if(aborted)return;
    const total=Math.round(performance.now()-startedAt);
    const errMsg=humanSshError(err);
    connEl.card.classList.add('fail');
    connEl.err.textContent=errMsg;
    connEl.hint.innerHTML=IC('xcircle')+' <b style="color:var(--err)">Не удалось подключиться за '+total+' мс</b>';
    connEl.cancel.innerHTML=IC('x')+' Закрыть';
    connEl.retry.style.display='';
    connEl.retry.dataset.id=s.id;
    s.status='error';renderSessions();
    errSessionId=s.id;
    connAbort=()=>{closeConnUI();};
    toast(s.name+' → '+s.host+':'+s.port+' · '+errMsg,'err','Не удалось подключиться');
    logEvent('err','connect',errMsg,sessTarget(s));
    return;
  }
  if(aborted)return;

  const total=Math.round(performance.now()-startedAt);
  connEl.bar.style.width='100%';
  connEl.card.classList.add('good');
  connEl.hint.innerHTML=IC('check-c')+' <b style="color:var(--ok)">Канал установлен за '+total+' мс</b>';
  connEl.cancel.style.display='none';
  await wait(320);
  closeConnUI();

  s.status='active';s.last='только что';renderSessions();
  const fields={connId:connId,session:id,name:s.name,host:s.host,user:s.user,port:s.port,os:s.os,osName:s.osName||'',local:false,
    closed:false,stats:null,statsOff:false,statsFails:0,statsPrimed:false};
  let tab;
  if(stale&&S.tabs.includes(stale)&&stale.closed){
    const oldConn=stale.connId;
    tab=Object.assign(stale,fields);
    S.groups.forEach(g=>{if(g.kind==='sftp'&&g.connId===oldConn)g.connId=connId;});
    connIdToTab[connId]=tab;
    const st=xtermState[tab.id];
    if(st){
      st.term.write('\r\n\x1b[32m— переподключено к '+s.host+' —\x1b[0m\r\n');
      window.sshAPI.resize(connId,st.term.cols,st.term.rows);
    }
    openTab(tab.id);
  }else{
    tab=Object.assign({id:uid('t')},fields);
    connIdToTab[connId]=tab;
    S.tabs.push(tab);
    addTermGroup(tab);
  }
  const early=takeEarlyData(connId);
  if(early)ensureXterm(tab).term.write(early);
  const earlyOs=pendingOs[connId];
  toast('Подключено за '+total+' мс · '+s.user+'@'+s.host,'ok','Сессия активна');
  tab.connectedAt=Date.now();
  logEvent('ok','connect','Подключено за '+total+' мс · вход по '+(s.auth==='key'?'ключу':'паролю'),sessTarget(s));
  if(earlyOs){delete pendingOs[connId];applyDetectedOs(tab,earlyOs);}
  renderTunnelForm();
  if(CL.open)renderClaude();
  autostartTunnels(id);
}
window.connectSession=connectSession;

/* ---------------- SESSIONS ---------------- */
function statusPill(st){
  if(st==='active')return '<span class="pill on"><span class="sdot"></span>активна</span>';
  if(st==='error')return '<span class="pill err"><span class="sdot"></span>ошибка</span>';
  if(st==='connecting')return '<span class="pill warn"><span class="sdot"></span>подключение…</span>';
  return '<span class="pill off"><span class="sdot"></span>не подключена</span>';
}
function renderSessions(){
  persist();
  const box=$('#sessionsBox');
  $('#cntSessions').textContent=S.sessions.length;
  updateBadges();
  if(!S.sessions.length){
    box.innerHTML='<div class="table-wrap"><div class="empty">'+
      '<div class="empty-ico">'+IC('sessions')+'</div>'+
      '<h4>Сессий пока нет</h4>'+
      '<p>Сейф пуст: ни одного сохранённого подключения. Создайте первую сессию — хост, порт и учётные данные сохранятся в зашифрованном сейфе.</p>'+
      '<div style="display:flex;gap:9px;flex-wrap:wrap;justify-content:center">'+
      '<button class="btn primary" data-do="sessionModal">'+IC('plus')+' Новая сессия</button>'+
      '</div></div></div>';
    return;
  }
  const list=S.sessions.slice().sort((a,b)=>S.sortAsc?a.name.localeCompare(b.name):b.name.localeCompare(a.name));
  $$('#sessView .seg-item').forEach(b=>b.classList.toggle('on',b.dataset.v===S.sessView));
  if(S.sessView!=='list'){
    box.innerHTML='<div class="scards">'+
      '<button class="scard sc-new" data-do="sessionModal"><span class="sc-new-ico">'+IC('plus')+'</span>Новая сессия</button>'+
      list.map(sessionCard).join('')+'</div>';
    $$('#sessionsBox .scard[data-id]').forEach(c=>c.addEventListener('click',e=>{
      if(e.target.closest('button'))return;
      S.selSession=c.dataset.id;
      $$('#sessionsBox .scard[data-id]').forEach(x=>x.classList.toggle('sel',x.dataset.id===S.selSession));
    }));
    return;
  }
  box.innerHTML='<div class="table-wrap"><table><thead><tr>'+
    '<th style="width:158px">Статус</th><th>Имя</th><th style="width:196px">ОС</th><th>Хост</th><th style="width:70px">Порт</th>'+
    '<th style="width:148px">Пользователь</th><th style="width:120px">Последнее</th><th style="width:130px"></th>'+
    '</tr></thead><tbody>'+
    list.map(s=>
      '<tr data-id="'+s.id+'" class="'+(S.selSession===s.id?'sel':'')+'" data-dbl="connect" data-arg="'+s.id+'">'+
      '<td data-l="Статус">'+statusPill(s.status)+'</td>'+
      '<td data-l="Имя" class="name">'+esc(s.name)+'<div class="hint" style="margin-top:3px">'+esc(s.note||'')+'</div></td>'+
      '<td data-l="ОС">'+osBadge(s.os,s.osName)+'</td>'+
      '<td data-l="Хост" class="mono">'+esc(s.host)+'</td>'+
      '<td data-l="Порт" class="mono">'+s.port+'</td>'+
      '<td data-l="Пользователь" class="mono">'+esc(s.user)+' '+(s.auth==='key'?'<span class="tag">'+IC('key')+' key</span>':'<span class="tag pass">'+IC('lock')+' pass</span>')+'</td>'+
      '<td data-l="Последнее" style="color:var(--dim);font-size:12px">'+esc(s.last)+'</td>'+
      '<td data-l=""><div class="row-actions">'+
        '<button class="ibtn ok" title="Подключиться" data-do="connect" data-arg="'+s.id+'">'+IC('play')+'</button>'+
        '<button class="ibtn" title="Изменить" data-do="sessionModal" data-arg="'+s.id+'">'+IC('pencil')+'</button>'+
        '<button class="ibtn x" title="Удалить" data-do="delSession" data-arg="'+s.id+'">'+IC('x')+'</button>'+
      '</div></td></tr>'
    ).join('')+'</tbody></table></div>'+
    '<button class="sl-new" data-do="sessionModal">'+IC('plus')+' Новая сессия</button>';
  $$('#sessionsBox tbody tr').forEach(tr=>tr.addEventListener('click',e=>{
    if(e.target.closest('button'))return;
    S.selSession=tr.dataset.id;
    $$('#sessionsBox tbody tr').forEach(x=>x.classList.toggle('sel',x.dataset.id===S.selSession));
  }));
}
// Card: a small «terminal preview» tinted with the OS colour on top, details below; actions show on hover.
function sessionCard(s){
  const o=osOf(s.os);
  const pill=s.status==='active'||s.status==='error'||s.status==='connecting'?statusPill(s.status):'';
  return '<div class="scard'+(S.selSession===s.id?' sel':'')+'" data-id="'+s.id+'" data-do="connect" data-arg="'+s.id+'" style="--osc:'+o.color+'" title="Подключиться">'+
    '<div class="sc-prev">'+
      '<span class="sc-os">'+IC(o.icon)+'</span>'+
      '<div class="sc-top">'+pill+'<div class="sc-acts">'+
        '<button class="ibtn" title="Изменить" data-do="sessionModal" data-arg="'+s.id+'">'+IC('pencil')+'</button>'+
        '<button class="ibtn x" title="Удалить" data-do="delSession" data-arg="'+s.id+'">'+IC('x')+'</button>'+
      '</div></div>'+
      '<div class="sc-term"><span class="p">'+esc(s.user)+'@'+esc(s.host)+'</span><span class="dim">:</span><span class="d">~</span><span class="dim">'+(s.user==='root'?'#':'$')+'</span><i></i></div>'+
    '</div>'+
    '<div class="sc-body">'+
      '<div class="sc-name">'+esc(s.name)+'</div>'+
      '<div class="sc-note">'+esc(s.note||(String(s.port)!=='22'?'порт '+s.port:''))+'</div>'+
      '<div class="sc-meta">'+osBadge(s.os,s.osName)+
        (s.auth==='key'
          ?(s.keyPath&&!s.keyId
            ?'<span class="tag pass" title="Ключ из файла на этом компьютере ('+esc(s.keyPath)+'). На другом компьютере его может не быть — импортируйте ключ в клиент, чтобы он синхронизировался.">'+IC('key')+' файл</span>'
            :'<span class="tag">'+IC('key')+' key</span>')
          :'<span class="tag pass">'+IC('lock')+' pass</span>')+
        '<span class="sc-last">'+esc(s.last)+'</span></div>'+
    '</div></div>';
}
$$('#sessView .seg-item').forEach(b=>{b.onclick=()=>{if(S.sessView===b.dataset.v)return;S.sessView=b.dataset.v;renderSessions();};});
window.delSession=async(id,tr)=>{
  const s=S.sessions.find(x=>x.id===id);if(!s)return;
  const ok=await confirmModal({title:'Удалить сессию?',text:'«<b>'+esc(s.name)+'</b>» ('+esc(s.host)+':'+s.port+', '+esc(osLabel(s.os,s.osName))+') будет удалена из сейфа вместе с учётными данными. Привязанные пробросы портов тоже исчезнут.',ok:'Удалить'});
  if(!ok){toast('Удаление отменено','info','Сессии');return;}
  for(const t of S.tunnels.filter(x=>x.session===id))await stopTunnelNow(t);
  tr.classList.add('dying');
  setTimeout(()=>{
    S.sessions=S.sessions.filter(x=>x.id!==id);
    const removed=S.tunnels.filter(t=>t.session===id).length;
    S.tunnels=S.tunnels.filter(t=>t.session!==id);
    if(S.selSession===id)S.selSession=null;
    renderSessions();renderTunnels();renderTunnelForm();
    toast('Сессия «'+s.name+'» удалена из сейфа'+(removed?(' + '+removed+' проброс(а)'):''),'ok','Сессии');
  },260);
};
$('#btnSortSessions').onclick=()=>{S.sortAsc=!S.sortAsc;renderSessions();toast('Сортировка по имени: '+(S.sortAsc?'А→Я':'Я→А'),'info','Сессии');};
$('#btnNewSession').onclick=()=>sessionModal();

function sessionModal(id){
  const s=id?S.sessions.find(x=>x.id===id):null;
  const m=openModal({
    title:s?'Изменить сессию':'Новая сессия',
    sub:s?esc(s.name):'Подключение к удалённому серверу по SSH',
    icon:s?'pencil':'plus',wide:true,
    body:
      '<div class="grid2" style="margin-bottom:14px">'+
        '<div class="field"><label class="field-label">'+IC('note')+' Имя</label><input class="inp" id="mName" value="'+(s?esc(s.name):'')+'" placeholder="home-lab"></div>'+
        '<div class="field"><label class="field-label">'+IC('note')+' Заметка</label><input class="inp" id="mNote" value="'+(s?esc(s.note||''):'')+'" placeholder="Raspberry Pi 5 · домашний сервер"></div>'+
      '</div>'+
      '<div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">'+
        '<div class="field" style="flex:1 1 150px"><label class="field-label">'+IC('user')+' Пользователь</label><input class="inp mono" id="mUser" value="'+(s?esc(s.user):'')+'" placeholder="root"></div>'+
        '<div class="field" style="flex:3 1 230px"><label class="field-label">'+IC('globe')+' Хост</label><input class="inp mono" id="mHost" value="'+(s?esc(s.host):'')+'" placeholder="192.168.1.10 или example.com"></div>'+
        '<div class="field" style="flex:1 1 110px"><label class="field-label">'+IC('hash')+' Порт</label><input class="inp mono" id="mPort" value="'+(s?s.port:22)+'" inputmode="numeric"></div>'+
      '</div>'+
      '<div class="field"><label class="field-label">'+IC('shield')+' Учётные данные</label>'+
        '<div class="seg" id="mAuth" style="margin-bottom:10px">'+
          '<button class="seg-item '+((!s||s.auth==='key')?'on':'')+'" data-a="key">'+IC('key')+' SSH-ключ</button>'+
          '<button class="seg-item '+((s&&s.auth==='password')?'on':'')+'" data-a="password">'+IC('lock')+' Пароль</button>'+
        '</div>'+
        '<div id="mAuthBox"></div>'+
      '</div>',
    footer:'<button class="btn ghost left" data-close>'+IC('x')+' Отмена</button>'+
           '<button class="btn" id="mTest">'+IC('wifi')+' Проверить</button>'+
           '<button class="btn primary" id="mSave">'+IC(s?'save':'plus')+' '+(s?'Сохранить':'Создать')+'</button>',
    onMount:el=>{
      let auth=s?s.auth:'key';
      const usable=S.keys.filter(k=>k.privateKey);
      let keySrc=(s&&s.auth==='key'&&(s.keyId||s.keyPath))?(s.keyId?'client':'file'):(usable.length?'client':'file');
      let keyId=(s&&s.keyId&&usable.some(k=>k.id===s.keyId))?s.keyId:(usable[0]?usable[0].id:'');
      const vals={password:s?(s.password||''):'',keyPath:s?(s.keyPath||''):'',passphrase:s?(s.passphrase||''):''};
      const box=el.querySelector('#mAuthBox');
      const grab=()=>{
        const q=sel=>box.querySelector(sel);
        if(q('#mPass'))vals.password=q('#mPass').value;
        if(q('#mKeyPath'))vals.keyPath=q('#mKeyPath').value;
        if(q('#mKeyPass'))vals.passphrase=q('#mKeyPass').value;
        if(q('#mKeyId'))keyId=q('#mKeyId').value;
      };
      const paint=()=>{
        if(auth==='password'){
          box.innerHTML=pwInput('mPass','Пароль',vals.password)+
            '<p class="hint" style="margin:9px 0 0">'+IC('info')+' Пароль хранится только в зашифрованном сейфе.</p>';
          return;
        }
        const opts=usable.map(k=>'<option value="'+k.id+'" '+(k.id===keyId?'selected':'')+'>'+esc(k.name)+' · '+esc(k.type)+' · '+esc(k.fp.slice(7,23))+'…</option>').join('');
        box.innerHTML=
          '<div class="seg" id="mKeySrc" style="margin-bottom:10px">'+
            '<button type="button" class="seg-item '+(keySrc==='client'?'on':'')+'" data-k="client">'+IC('key')+' Из клиента'+(usable.length?' ('+usable.length+')':'')+'</button>'+
            '<button type="button" class="seg-item '+(keySrc==='file'?'on':'')+'" data-k="file">'+IC('upload')+' Файл на диске</button>'+
          '</div>'+
          (keySrc==='client'
            ? (usable.length
                ? '<select class="sel" id="mKeyId">'+opts+'</select>'+
                  '<p class="hint" style="margin:9px 0 0">'+IC('info')+' Ключи добавляются в разделе <a href="#" id="mGoKeys">«Ключи»</a> — импорт или генерация.</p>'
                : '<div class="fpath" style="margin-top:0;color:var(--dim)">В клиенте пока нет ключей.</div>'+
                  '<p class="hint" style="margin:9px 0 0"><a href="#" id="mGoKeys">Импортировать или сгенерировать ключ в разделе «Ключи»</a></p>')
            : '<div style="display:flex;gap:8px;align-items:center;margin-bottom:9px">'+
                '<input class="inp mono" id="mKeyPath" readonly value="'+esc(vals.keyPath)+'" placeholder="Путь к приватному ключу (id_ed25519, id_rsa…)" style="flex:1 1 auto">'+
                '<button type="button" class="btn ghost sm" id="mKeyBrowse" style="flex:0 0 auto">'+IC('upload')+' Обзор…</button>'+
              '</div>'+
              pwInput('mKeyPass','Парольная фраза ключа (если есть)',vals.passphrase)+
              '<p class="hint" style="margin:9px 0 0">'+IC('info')+' Нужен приватный ключ (id_ed25519, id_rsa), а не .pub. Файл читается только в момент подключения.</p>');
        box.querySelectorAll('#mKeySrc .seg-item').forEach(b=>{b.onclick=()=>{grab();keySrc=b.dataset.k;paint();};});
        const toKeys=box.querySelector('#mGoKeys');
        if(toKeys)toKeys.onclick=e=>{e.preventDefault();m.close();go('keys');};
        const br=box.querySelector('#mKeyBrowse');
        if(br)br.onclick=async()=>{
          if(!window.sshAPI){toast('SSH-модуль недоступен','err','Ключ');return;}
          let p=await window.sshAPI.selectKeyFile();
          if(!p)return;
          if(/\.pub$/i.test(p)){p=p.replace(/\.pub$/i,'');toast('Выбран публичный ключ (.pub) — подставлен приватный: '+p,'warn','Ключ');}
          box.querySelector('#mKeyPath').value=p;
        };
      };
      paint();
      el.querySelectorAll('#mAuth .seg-item').forEach(b=>{b.onclick=()=>{
        el.querySelectorAll('#mAuth .seg-item').forEach(x=>x.classList.remove('on'));
        b.classList.add('on');grab();auth=b.dataset.a;paint();
      };});
      el.querySelector('#mTest').onclick=async e=>{
        const host=el.querySelector('#mHost').value.trim(),port=+el.querySelector('#mPort').value||22;
        if(!host){toast('Укажите хост для проверки','err','Проверка');return;}
        if(!window.sshAPI){toast('SSH-модуль недоступен','err','Проверка');return;}
        const b=e.currentTarget,old=b.innerHTML;
        b.innerHTML='<span class="spinner"></span> Проверка…';b.disabled=true;
        const r=await window.sshAPI.testTcp(host,port);
        b.innerHTML=old;b.disabled=false;
        if(r.ok)toast('TCP '+host+':'+port+' доступен · '+r.rtt+' мс','ok','Хост отвечает');
        else toast('TCP '+host+':'+port+' — '+r.error,'err','Проверка не прошла');
      };
      el.querySelector('#mSave').onclick=()=>{
        const name=el.querySelector('#mName').value.trim(),host=el.querySelector('#mHost').value.trim();
        const port=+el.querySelector('#mPort').value||22,user=el.querySelector('#mUser').value.trim()||'root';
        const note=el.querySelector('#mNote').value.trim();
        let bad=null;
        if(!name)bad=el.querySelector('#mName');else if(!host)bad=el.querySelector('#mHost');
        if(bad){bad.classList.add('err');setTimeout(()=>bad.classList.remove('err'),450);toast('Заполните имя и хост','err','Не сохранено');return;}
        grab();
        if(auth==='key'&&keySrc==='client'&&!usable.some(k=>k.id===keyId)){
          toast('Выберите ключ из клиента или файл на диске','err','Не сохранено');return;
        }
        if(auth==='key'&&keySrc==='file'&&!vals.keyPath.trim()){
          const kp=box.querySelector('#mKeyPath');kp.classList.add('err');setTimeout(()=>kp.classList.remove('err'),450);
          toast('Выберите файл приватного ключа','err','Не сохранено');return;
        }
        const creds=auth==='password'
          ? {password:vals.password,keyId:'',keyPath:'',passphrase:''}
          : keySrc==='client'
            ? {keyId:keyId,keyPath:'',passphrase:'',password:''}
            : {keyId:'',keyPath:vals.keyPath.trim(),passphrase:vals.passphrase,password:''};
        const b=el.querySelector('#mSave');b.innerHTML='<span class="spinner dark"></span> Сохраняю…';b.disabled=true;
        setTimeout(()=>{
          if(s){Object.assign(s,{name:name,host:host,port:port,user:user,note:note,auth:auth},creds);toast('Сессия «'+name+'» обновлена','ok','Сохранено');}
          else{S.sessions.push(Object.assign({id:uid('s'),name:name,host:host,port:port,user:user,note:note,os:'generic',auth:auth,last:'никогда',status:'idle'},creds));toast('Сессия «'+name+'» добавлена','ok','Создано');}
          m.close();renderSessions();renderTunnelForm();
        },200);
      };
    }
  });
  return m;
}
window.sessionModal=sessionModal;
