"use strict";
/* ---------------- VAULT ---------------- */
function vaultSnapshot(){
  return {
    version:1,
    sessions:S.sessions.map(s=>({id:s.id,name:s.name,note:s.note||'',host:s.host,port:s.port,user:s.user,os:s.os||'generic',osName:s.osName||'',
      auth:s.auth,password:s.password||'',keyId:s.keyId||'',keyPath:s.keyPath||'',passphrase:s.passphrase||'',last:s.last||'никогда'})),
    keys:S.keys.map(k=>({id:k.id,name:k.name,type:k.type,fp:k.fp,publicKey:k.publicKey,privateKey:k.privateKey,passphrase:k.passphrase||'',created:k.created})),
    tunnels:S.tunnels.map(t=>({id:t.id,name:t.name,session:t.session,lport:t.lport,host:t.host,rport:t.rport,auto:!!t.auto})),
    projects:S.projects.map(p=>({id:p.id,name:p.name,repo:p.repo,url:p.url||'',branch:p.branch||'',place:p.place,session:p.session||'',dir:p.dir,addedAt:p.addedAt||0})),
    journal:S.journal,journalClearedAt:S.journalClearedAt||0,
    // shell and shellDir are per computer (installed shells, local paths): kept in localStorage, not synced.
    // The GitHub token rides with the settings: encrypted in the vault, so it travels with the sync.
    settings:{themeMode:S.themeMode,autolock:S.autolock,sessView:S.sessView,font:S.font,fontSize:S.fontSize,scrollback:S.scrollback,sortAsc:S.sortAsc,github:S.github||null}
  };
}
const LOCAL_PREFS=['shell','shellDir'];
function loadLocalPrefs(fromVault){
  for(const k of LOCAL_PREFS){
    let v=null;try{v=localStorage.getItem('ssh.'+k);}catch(e){}
    if(v!==null)S[k]=v;else if(fromVault&&fromVault[k]!=null){S[k]=fromVault[k];saveLocalPrefs();}
  }
}
function saveLocalPrefs(){for(const k of LOCAL_PREFS){try{localStorage.setItem('ssh.'+k,S[k]||'');}catch(e){}}}
function applyVaultData(d){
  S.sessions=(d.sessions||[]).map(s=>Object.assign({},s,{status:S.tabs.some(t=>!t.local&&t.session===s.id)?'active':'idle'}));
  S.keys=d.keys||[];
  S.tunnels=(d.tunnels||[]).map(t=>Object.assign({},t,{on:false}));
  S.projects=d.projects||[];
  S.journal=Array.isArray(d.journal)?d.journal:[];
  S.journalClearedAt=d.journalClearedAt||0;
  if(d.settings){const st=Object.assign({},d.settings);LOCAL_PREFS.forEach(k=>delete st[k]);Object.assign(S,st);}
  if(!S.github||!S.github.token)S.github=null;
  loadLocalPrefs(d.settings);
}
function renderVaultData(){
  applyTheme(true);renderSettings();renderSessions();renderKeys();renderTunnelForm();renderTunnels();renderProjects();updateBadges();
}

// lastSavedData: the versioned data last written (updatedAt per record, tombstones) — the base for stamping changes.
// lastSnapKey: canonical plain snapshot at that moment, so timestamps alone never trigger a save.
let persistTimer=null,lastSavedData=null,lastSnapKey='',savePromise=Promise.resolve();
function persist(){
  if(!S.vaultOpen||!window.vaultAPI)return;
  clearTimeout(persistTimer);
  persistTimer=setTimeout(flushPersist,400);
}
function flushPersist(){
  clearTimeout(persistTimer);persistTimer=null;
  if(!S.vaultOpen||!window.vaultAPI)return savePromise;
  saveLocalPrefs();
  const snap=vaultSnapshot(),key=VaultMerge.canon(snap);
  if(key===lastSnapKey)return savePromise;
  savePromise=savePromise.then(async()=>{
    const data=VaultMerge.stamp(lastSavedData,snap,Date.now());
    const r=await window.vaultAPI.save(data);
    if(r.ok){lastSavedData=data;lastSnapKey=key;}
    else toast('Не удалось сохранить сейф: '+r.error,'err','Сейф');
  });
  return savePromise;
}

function renderVault(){
  const open=S.vaultOpen,st=S.vaultStatus;
  $('#vaultIco').innerHTML=IC(open?'unlock':'lock');
  $('#vaultTitle').textContent=open?'Сейф открыт':'Сейф заблокирован';
  $('#vaultSub').textContent=open?'AES-256-GCM · scrypt':(st&&!st.exists?'сейф не создан':'введите мастер-пароль');
  $('#vaultDot').className='dot'+(open?'':' locked');
  $('#vaultPill').classList.toggle('locked',!open);
  $('#vaultStateTxt').textContent=open?'открыт':'заблокирован';
  $('#vaultStateTxt').style.color=open?'var(--ok)':'var(--warn)';
  $('#lockScreen').classList.toggle('on',!open);
  const appEl=$('#app');
  if(appEl){if(open)appEl.removeAttribute('inert');else appEl.setAttribute('inert','');}
  if(!open){renderLock();lockScreenFocus();}
}
function renderLock(){
  const st=S.vaultStatus||{exists:true};
  const title=$('#lockTitle'),text=$('#lockText'),fields=$('#lockFields'),btn=$('#btnUnlock'),alt=$('#btnLockAlt');
  const p=st.path||'',shortP=p.length>44?'…'+p.slice(-43):p;
  const where='<span class="lock-path mono" title="'+esc(p)+'">'+esc(shortP)+'</span>';
  alt.style.display='';
  if(st.dirMissing){
    title.textContent='Папка сейфа недоступна';
    text.innerHTML='Не найдена папка с сейфом — возможно, не подключён съёмный диск.'+where;
    fields.innerHTML='';
    btn.innerHTML=IC('refresh')+' Проверить снова';
    alt.innerHTML=IC('folder')+' Использовать стандартную папку';
    alt.onclick=()=>changeStore('std');
  }else if(!st.exists){
    title.textContent='Создайте сейф';
    text.innerHTML='Сессии, пароли и ключи будут храниться в зашифрованном файле (AES-256-GCM). Мастер-пароль восстановить нельзя — запомните его.'+where;
    fields.innerHTML=pwInput('lockPass','Мастер-пароль (минимум 8 символов)','')+pwInput('lockPass2','Повторите мастер-пароль','');
    btn.innerHTML=IC('shield')+' Создать сейф';
    alt.innerHTML=IC('folder')+' Открыть существующий сейф из папки…';
    alt.onclick=()=>changeStore('portable',true);
  }else{
    title.textContent='Сейф заблокирован';
    text.innerHTML='Введите мастер-пароль, чтобы продолжить.'+
      (S.tabs.some(t=>!t.local)?'<br>Активные подключения продолжают работать.':'')+where;
    fields.innerHTML=pwInput('lockPass','Мастер-пароль','');
    btn.innerHTML=IC('unlock')+' Разблокировать';
    alt.style.display='none';
    alt.onclick=null;
  }
  fields.querySelectorAll('input').forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter')lockPrimary();}));
  if(typeof syncRestoreVisibility==='function')syncRestoreVisibility();
}
async function refreshVaultStatus(){
  const r=await window.vaultAPI.status();
  if(r.ok){S.vaultStatus=r;S.store=r.store;S.dataDir=r.dataDir;}
  renderSettings();renderVault();
}
async function lockPrimary(){
  const st=S.vaultStatus||{};
  if(st.dirMissing){await refreshVaultStatus();return;}
  const p1=$('#lockPass'),p2=$('#lockPass2'),b=$('#btnUnlock');
  if(!p1)return;
  const bad=(x,msg)=>{if(x){x.classList.add('err');setTimeout(()=>x.classList.remove('err'),450);x.focus();}toast(msg,'err','Сейф');};
  if(!st.exists){
    if(p1.value.length<8)return bad(p1,'Мастер-пароль: минимум 8 символов');
    if(p1.value!==p2.value)return bad(p2,'Пароли не совпадают');
  }else if(!p1.value)return bad(p1,'Введите мастер-пароль');
  const old=b.innerHTML;
  b.innerHTML='<span class="spinner dark"></span> '+(st.exists?'Проверка…':'Создание…');b.disabled=true;
  const r=st.exists?await window.vaultAPI.unlock(p1.value):await window.vaultAPI.create(p1.value);
  b.innerHTML=old;b.disabled=false;
  if(!r.ok){p1.value='';if(p2)p2.value='';if(st.exists)logEvent('warn','vault','Неудачная попытка разблокировки: '+r.error,'');return bad(p1,r.error);}
  applyVaultData(st.exists?(r.data||{}):{});
  S.vaultStatus=st.exists?r.status:r;
  S.vaultOpen=true;
  lastSavedData=st.exists?(r.data||{}):null;
  lastSnapKey=st.exists?VaultMerge.canon(vaultSnapshot()):'';
  lastActivity=Date.now();
  if(journalQueue.length)S.journal.push(...journalQueue.splice(0));
  logEvent('ok','vault',st.exists?'Сейф разблокирован':'Сейф создан','');
  renderVaultData();renderVault();syncTunnels();
  toast(st.exists?('Сейф открыт: '+S.sessions.length+' сессий, '+S.keys.length+' ключей'):'Сейф создан — всё сохраняется автоматически','ok','Сейф');
}
async function lockVault(reason){
  if(!S.vaultOpen)return;
  logEvent('info','vault',reason==='auto'?'Автоблокировка после бездействия':'Сейф заблокирован','');
  await flushPersist();
  S.vaultOpen=false;
  if($('#connectScreen').classList.contains('on')&&typeof connAbort==='function')connAbort('lock');
  modalStack.slice().forEach(m=>m.close());
  S.sessions=[];S.keys=[];S.tunnels=[];S.journal=[];S.journalClearedAt=0;S.projects=[];S.github=null;
  PJ.sel=null;PJ.data={};PJ.msg={};PJ.repos=null;
  lastSavedData=null;lastSnapKey='';
  if(window.vaultAPI)await window.vaultAPI.lock();
  renderSessions();renderKeys();renderTunnelForm();renderTunnels();renderJournal();renderProjects();updateBadges();
  renderVault();
  toast(reason==='auto'?'Сейф заблокирован после бездействия':'Ключ стёрт из памяти','warn','Сейф заблокирован');
}
function lockScreenFocus(){if(!S.vaultOpen)setTimeout(()=>{const i=$('#lockPass');if(i)i.focus();},80);}
async function changeStore(store,pick){
  if(!window.vaultAPI)return;
  await flushPersist();
  const r=await window.vaultAPI.setLocation(store,pick);
  if(!r.ok){toast(r.error,'err','Хранилище');return;}
  if(r.canceled)return;
  S.vaultStatus=r;S.store=r.store;S.dataDir=r.dataDir;
  renderSettings();
  if(!S.vaultOpen){renderVault();return;}
  toast('Сейф хранится в '+r.dataDir,'ok','Хранилище');
}

let lastActivity=Date.now();
['keydown','pointerdown','wheel'].forEach(ev=>document.addEventListener(ev,()=>{lastActivity=Date.now();},true));
setInterval(()=>{
  if(S.vaultOpen&&S.autolock>0&&Date.now()-lastActivity>S.autolock*60000)lockVault('auto');
},10000);
if(window.vaultAPI)window.vaultAPI.onFlushRequest(()=>flushPersist());

$('#vaultPill').onclick=()=>S.vaultOpen?lockVault():lockScreenFocus();
$('#btnUnlock').onclick=lockPrimary;
$('#btnLockNow').onclick=()=>lockVault();
