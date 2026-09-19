/* ---------------- WINDOWS HELLO (unlock the vault without the master password) ---------------- */
// The authenticator derives 32 bytes from a fixed salt (WebAuthn PRF); main wraps a copy of the
// vault key with them. Nothing here is stored in the renderer - it only carries out the ceremony.
const HELLO = { supported: false, configured: false, credentialId: '', salt: '' };
// One fixed user handle: re-enabling replaces the passkey instead of leaving orphans behind.
const HELLO_USER = new Uint8Array([115, 115, 104, 45, 99, 108, 105, 101, 110, 116, 45, 118, 97, 117, 108, 116]);

const helloB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const helloBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function helloRefresh(){
  if(!window.helloAPI)return;
  try{HELLO.supported=typeof PublicKeyCredential!=='undefined'&&await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();}
  catch(e){HELLO.supported=false;}
  const r=await window.helloAPI.state();
  if(r.ok){HELLO.configured=r.configured;HELLO.credentialId=r.credentialId;HELLO.salt=r.salt;}
  renderHelloRow();
  renderHelloUnlock();
}

function renderHelloRow(){
  const row=$('#helloRow'),btn=$('#btnHelloToggle'),hint=$('#helloHint');
  if(!row)return;
  row.hidden=!HELLO.supported;
  if(!HELLO.supported)return;
  btn.innerHTML=HELLO.configured?IC('x')+' Отключить':IC('shield')+' Настроить';
  hint.textContent=HELLO.configured
    ?'Включён. Сейф открывается через Windows Hello; мастер-пароль продолжает работать.'
    :'Открывать сейф PIN-кодом или отпечатком вместо мастер-пароля.';
}

function renderHelloUnlock(){
  const btn=$('#btnHelloUnlock');
  if(!btn)return;
  const st=S.vaultStatus||{};
  btn.hidden=!(HELLO.supported&&HELLO.configured&&st.exists&&!S.vaultOpen);
}

// PRF bytes only ever come from get(): at create() Windows reports prf.enabled=false even when it
// hands the bytes over afterwards, so asking there would look like a failure.
async function helloAssert(salt,credentialId){
  const a=await navigator.credentials.get({publicKey:{
    challenge:crypto.getRandomValues(new Uint8Array(32)),
    rpId:location.hostname,
    userVerification:'required',
    allowCredentials:credentialId?[{type:'public-key',id:helloBytes(credentialId)}]:[],
    extensions:{prf:{eval:{first:helloBytes(salt)}}},
  }});
  const ext=a.getClientExtensionResults();
  const first=ext&&ext.prf&&ext.prf.results&&ext.prf.results.first;
  if(!first)throw new Error('Windows Hello не выдал ключевой материал');
  return {prf:helloB64(first),credentialId:helloB64(a.rawId)};
}

async function helloEnable(){
  const salt=helloB64(crypto.getRandomValues(new Uint8Array(32)));
  const cred=await navigator.credentials.create({publicKey:{
    challenge:crypto.getRandomValues(new Uint8Array(32)),
    rp:{name:'SSH Client',id:location.hostname},
    user:{id:HELLO_USER,name:'vault',displayName:'SSH Client'},
    pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
    authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required',residentKey:'required'},
    extensions:{prf:{}},
  }});
  const {prf,credentialId}=await helloAssert(salt,helloB64(cred.rawId));
  const r=await window.helloAPI.enable(credentialId,prf,salt);
  if(!r.ok)throw new Error(r.error);
}

async function helloToggle(){
  const btn=$('#btnHelloToggle');
  if(!btn||btn.disabled)return;
  const old=btn.innerHTML;
  btn.disabled=true;btn.innerHTML='<span class="spinner dark"></span> Windows Hello…';
  try{
    if(HELLO.configured){
      const r=await window.helloAPI.disable();
      if(!r.ok)throw new Error(r.error);
      logEvent('info','vault','Вход по Windows Hello отключён','');
      toast('Вход по Windows Hello отключён','ok','Сейф');
    }else{
      await helloEnable();
      logEvent('ok','vault','Вход по Windows Hello настроен','');
      toast('Готово: сейф будет открываться через Windows Hello','ok','Сейф');
    }
  }catch(e){
    toast(helloError(e),'err','Сейф');
  }finally{
    btn.disabled=false;btn.innerHTML=old;
    await helloRefresh();
  }
}

async function helloUnlock(){
  const btn=$('#btnHelloUnlock');
  if(!btn||btn.disabled)return;
  const old=btn.innerHTML;
  btn.disabled=true;btn.innerHTML='<span class="spinner dark"></span> Windows Hello…';
  try{
    const {prf}=await helloAssert(HELLO.salt,HELLO.credentialId);
    const r=await window.helloAPI.unlock(prf);
    if(!r.ok)throw new Error(r.error);
    applyVaultData(r.data||{});
    S.vaultStatus=r.status;
    S.vaultOpen=true;
    lastSavedData=r.data||{};
    lastSnapKey=VaultMerge.canon(vaultSnapshot());
    lastActivity=Date.now();
    failedUnlocks=0;lockNote();
    if(journalQueue.length)S.journal.push(...journalQueue.splice(0));
    logEvent('ok','vault','Сейф разблокирован по Windows Hello','');
    renderVaultData();renderVault();syncTunnels();
    toast('Сейф открыт: '+S.sessions.length+' сессий, '+S.keys.length+' ключей','ok','Сейф');
  }catch(e){
    toast(helloError(e),'err','Сейф');
  }finally{
    btn.disabled=false;btn.innerHTML=old;
    renderHelloUnlock();
  }
}

function helloError(e){
  const name=(e&&e.name)||'';
  if(name==='NotAllowedError')return 'Windows Hello не подтвердил личность';
  if(name==='InvalidStateError')return 'Ключ для этого сейфа уже создан на этом компьютере';
  return (e&&e.message)||String(e);
}

if(window.helloAPI){
  $('#btnHelloToggle').onclick=helloToggle;
  $('#btnHelloUnlock').onclick=helloUnlock;
}
