"use strict";
/* ---------------- SYNC (Google Drive) ---------------- */
const SYNC={s:null,pwModal:null};
const syncClock=ts=>ts?new Date(ts).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'';

function renderSyncCard(){
  const box=$('#syncBox'),s=SYNC.s;if(!box||!s)return;
  if(!s.configured){
    box.innerHTML='<p class="hint" style="margin:0">В этой сборке вход через Google не настроен.</p>';
    return;
  }
  const where='<div class="sync-where">'+IC('folder')+'<span>Мой диск → <b>SSH Client</b> → secrets.vault</span></div>';
  if(!s.signedIn){
    const waiting=s.state==='login';
    box.innerHTML=
      '<p class="sync-lead">Сессии, ключи и пробросы появятся на всех ваших компьютерах. На Google Диск уходит только зашифрованный файл сейфа — мастер-пароль остаётся у вас.</p>'+
      where+
      (s.error?'<div class="upd-st err" style="margin-top:10px">'+IC('alert')+' '+esc(s.error)+'</div>':'')+
      '<div class="upd-actions">'+(waiting
        ?'<span class="upd-st"><span class="spinner"></span> Завершите вход в открывшемся браузере…</span><button class="btn ghost sm" data-do="syncCancelLogin">'+IC('x')+' Отмена</button>'
        :'<button class="btn primary sm" data-do="syncLogin">'+IC('cloud')+' Войти через Google</button>')+
      '</div>';
    return;
  }
  const status=s.state==='syncing'?'<span class="upd-st"><span class="spinner"></span> Синхронизация…</span>'
    :s.state==='error'?'<span class="upd-st err">'+IC('alert')+' '+esc(s.error)+'</span>'
    :s.state==='password'?'<span class="upd-st err">'+IC('lock')+' Нужен пароль облачной копии</span>'
    :s.lastSyncAt?'<span class="upd-st ok">'+IC('check-c')+' Синхронизировано '+syncClock(s.lastSyncAt)+'</span>'
    :'<span class="hint" style="margin:0">Ещё не синхронизировалось</span>';
  box.innerHTML=
    '<div class="sync-acc"><span class="sync-ava">'+esc((s.email||'?').slice(0,1).toUpperCase())+'</span><div><b>'+esc(s.email||'Google')+'</b><small>Google Диск</small></div></div>'+
    '<div class="upd-row" style="margin-top:12px">'+status+'</div>'+
    where+
    '<div class="upd-actions">'+
      '<button class="btn primary sm" data-do="syncNow" '+(s.state==='syncing'?'disabled':'')+'>'+IC('refresh')+' Синхронизировать</button>'+
      (s.link?'<button class="btn ghost sm" data-do="syncOpenDrive">'+IC('globe')+' Открыть на Google Диске</button>':'')+
      '<button class="btn ghost sm" data-do="syncLogout">'+IC('x')+' Выйти</button>'+
    '</div>'+
    '<label class="upd-auto"><input type="checkbox" id="syncAuto" '+(s.auto?'checked':'')+'> Автоматически — после изменений и раз в минуту</label>';
  const auto=$('#syncAuto');
  if(auto)auto.onchange=()=>window.syncAPI.setAuto(auto.checked);
}
function renderSyncIndicator(){
  const el=$('#syncInd'),s=SYNC.s;if(!el||!s)return;
  el.hidden=!s.signedIn;
  el.className='sync-ind '+s.state;
  el.title=s.state==='syncing'?'Синхронизация с Google Диском…':s.state==='error'?'Синхронизация: '+s.error:s.lastSyncAt?'Google Диск: синхронизировано '+syncClock(s.lastSyncAt):'Google Диск';
}
// The restore button makes sense only on a computer without a vault.
function syncRestoreVisibility(){
  const b=$('#btnLockRestore'),st=S.vaultStatus;if(!b)return;
  b.hidden=!(SYNC.s&&SYNC.s.configured&&st&&!st.exists&&!st.dirMissing);
}
function onSyncState(s){
  const prev=SYNC.s;SYNC.s=s;
  renderSyncCard();renderSyncIndicator();syncRestoreVisibility();
  if(s.notice)toast(s.notice,'warn','Синхронизация');
  if(prev&&prev.state!=='error'&&s.state==='error'&&/отозван/.test(s.error))toast(s.error,'warn','Синхронизация');
}

// Records changed elsewhere are updated in place, so open dialogs and tabs keep valid references.
function applyMergedData(d){
  const LOCAL_ONLY={sessions:['status'],keys:[],tunnels:['on']};
  const update=(list,incoming,kind,fresh)=>{
    const byId=new Map(list.map(x=>[x.id,x]));
    return (incoming||[]).map(x=>{
      const clean=Object.assign({},x);delete clean.updatedAt;
      const cur=byId.get(x.id);
      if(!cur)return Object.assign(clean,fresh(clean));
      for(const k of Object.keys(cur))if(!(k in clean)&&!LOCAL_ONLY[kind].includes(k))delete cur[k];
      return Object.assign(cur,clean);
    });
  };
  for(const t of S.tunnels)if(t.on&&!(d.tunnels||[]).some(x=>x.id===t.id))stopTunnelNow(t);
  S.sessions=update(S.sessions,d.sessions,'sessions',s=>({status:S.tabs.some(t=>!t.local&&t.session===s.id&&!t.closed)?'active':'idle'}));
  S.keys=update(S.keys,d.keys,'keys',()=>({}));
  S.tunnels=update(S.tunnels,d.tunnels,'tunnels',()=>({on:false}));
  S.journal=d.journal||[];S.journalClearedAt=d.journalClearedAt||0;
  if(d.settings){const st=Object.assign({},d.settings);LOCAL_PREFS.forEach(k=>delete st[k]);Object.assign(S,st);}
  applyTheme(true);renderSettings();renderSessions();renderKeys();renderTunnelForm();renderTunnels();renderJournal();updateBadges();
}
function onSyncRemote(p){
  // Queued behind local saves so a merge never interleaves with a write.
  savePromise=savePromise.then(async()=>{
    try{
      if(!S.vaultOpen)throw new Error('Сейф заблокирован');
      const local=VaultMerge.stamp(lastSavedData,vaultSnapshot(),Date.now());
      const {data,stats}=VaultMerge.merge(local,p.data);
      if(stats.changed||VaultMerge.canon(local)!==VaultMerge.canon(lastSavedData||{})){
        if(stats.changed)applyMergedData(data);
        const r=await window.vaultAPI.save(data);
        if(!r.ok)throw new Error(r.error);
        lastSavedData=data;lastSnapKey=VaultMerge.canon(vaultSnapshot());
      }
      window.syncAPI.merged(p.id,true);
      const text=VaultMerge.describe(stats);
      if(text&&!p.own){
        toast('С другого компьютера: '+text,'ok','Google Диск');
        logEvent('info','vault','Синхронизация с Google Диском: '+text,'');
      }
    }catch(e){
      window.syncAPI.merged(p.id,false,e.message);
    }
  });
}
function onSyncNeedPassword(){
  if(SYNC.pwModal)return;
  let done=false;
  const m=SYNC.pwModal=openModal({title:'Другой пароль на Google Диске',sub:'копия сейфа зашифрована другим мастер-паролем',icon:'lock',
    body:'<p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:var(--dim)">Пароль сменили на другом компьютере, или сейф там создавался отдельно. Введите мастер-пароль облачной копии — данные объединятся, и дальше все компьютеры будут открывать сейф этим паролем.</p>'+
      pwInput('syncPw','Мастер-пароль копии на Google Диске',''),
    footer:'<button class="btn ghost left" id="syncPwSkip">'+IC('x')+' Не сейчас</button><button class="btn primary" id="syncPwGo">'+IC('unlock')+' Объединить</button>',
    onMount:el=>{
      const inp=el.querySelector('#syncPw'),go=el.querySelector('#syncPwGo');
      const submit=async()=>{
        if(!inp.value){inp.classList.add('err');setTimeout(()=>inp.classList.remove('err'),450);return;}
        go.disabled=true;go.innerHTML='<span class="spinner dark"></span> Проверка…';
        const r=await window.syncAPI.password(inp.value);
        go.disabled=false;go.innerHTML=IC('unlock')+' Объединить';
        if(!r.ok){inp.value='';inp.classList.add('err');setTimeout(()=>inp.classList.remove('err'),450);toast(r.error,'err','Синхронизация');return;}
        done=true;m.close();
        toast('Сейф объединён с копией на Google Диске. Теперь он открывается её паролем.','ok','Синхронизация');
      };
      go.onclick=submit;
      inp.addEventListener('keydown',e=>{if(e.key==='Enter')submit();});
      el.querySelector('#syncPwSkip').onclick=()=>m.close();
    }});
  const close=m.close;
  m.close=()=>{SYNC.pwModal=null;if(!done)window.syncAPI.skipPassword();close();};
}
async function syncRestore(){
  const b=$('#btnLockRestore'),old=b.innerHTML;
  b.disabled=true;b.innerHTML='<span class="spinner"></span> Вход в Google и загрузка…';
  const r=await window.syncAPI.restore();
  b.disabled=false;b.innerHTML=old;
  if(!r.ok){if(!r.cancelled)toast(r.error,'err','Восстановление');return;}
  await refreshVaultStatus();
  toast('Сейф загружен с Google Диска ('+r.email+'). Введите его мастер-пароль.','ok','Восстановление');
}
async function syncLogout(){
  const ok=await confirmModal({title:'Выйти из Google?',icon:'cloud',danger:false,ok:'Выйти',
    text:'Синхронизация на этом компьютере остановится. Локальный сейф останется как есть.'+
      '<label class="upd-auto" style="margin-top:12px"><input type="checkbox" id="syncDelRemote"> Удалить копию сейфа с Google Диска</label>'});
  if(!ok)return;
  const del=!!($('#syncDelRemote')&&$('#syncDelRemote').checked);
  const r=await window.syncAPI.logout(del);
  if(!r.ok){toast(r.error,'err','Синхронизация');return;}
  toast(del?'Вы вышли из Google, копия на Диске удалена':'Вы вышли из Google','ok','Синхронизация');
}

if(window.syncAPI){
  window.syncAPI.onState(onSyncState);
  window.syncAPI.onRemote(onSyncRemote);
  window.syncAPI.onNeedPassword(onSyncNeedPassword);
  window.syncAPI.status().then(s=>{if(!SYNC.s)onSyncState(s);});
  Object.assign(ACTIONS,{
    syncLogin:async()=>{const r=await window.syncAPI.login();if(r.ok)toast('Вход выполнен: '+r.email,'ok','Google Диск');else if(!r.cancelled)toast(r.error,'err','Google Диск');},
    syncCancelLogin:()=>window.syncAPI.cancelLogin(),
    syncNow:()=>window.syncAPI.now(),
    syncOpenDrive:()=>window.syncAPI.openDrive(),
    syncLogout:()=>syncLogout()
  });
  $('#btnLockRestore').onclick=syncRestore;
}
