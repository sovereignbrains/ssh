"use strict";
/* ---------------- SETTINGS ---------------- */
function renderSettings(){
  persist();
  $('#dataDir').value=S.dataDir||'';$('#dataDir').title=S.dataDir||'';
  $('#shellDir').value=S.shellDir||shellInfo.home||'';
  $('#footStore').textContent=S.store==='std'?'стандартное':'переносимое';
  $('#footLock').textContent=S.autolock===0?'никогда':(S.autolock===60?'1 час':S.autolock+' мин');
  $$('#storeOpts .opt').forEach(o=>o.classList.toggle('on',o.dataset.store===S.store));
  $$('#autolockSeg .seg-item').forEach(b=>b.classList.toggle('on',+b.dataset.min===S.autolock));
  $('#shellSel').value=S.shell;$('#fontSel').value=S.font;
  $('#fsVal').textContent=S.fontSize.toFixed(1).replace('.',',')+' px';
  $('#scrollback').value=S.scrollback;
  document.documentElement.style.setProperty('--term-font',S.font);
  document.documentElement.style.setProperty('--term-fs',S.fontSize+'px');
  Object.values(xtermState).forEach(st=>{st.term.options.fontFamily=S.font;st.term.options.fontSize=S.fontSize;st.term.options.scrollback=S.scrollback;try{st.fit.fit();}catch(e){}});
  const pv=$('#termPreview');pv.style.fontFamily=S.font;pv.style.fontSize=S.fontSize+'px';
  renderLocalStrip();
}
$$('#storeOpts .opt').forEach(o=>{o.onclick=()=>changeStore(o.dataset.store,false);});
$$('#autolockSeg .seg-item').forEach(b=>{b.onclick=()=>{
  S.autolock=+b.dataset.min;renderSettings();
  toast(S.autolock===0?'Автоблокировка отключена — сейф открыт, пока запущен процесс':'Сейф заблокируется после '+b.textContent.toLowerCase()+' бездействия','ok','Сейф');
};});
$('#shellSel').onchange=e=>{S.shell=e.target.value;persist();toast('Оболочка локального shell: '+e.target.selectedOptions[0].text,'ok','Локальный shell');};
$('#fontSel').onchange=e=>{S.font=e.target.value;renderSettings();toast('Шрифт терминала: '+e.target.selectedOptions[0].text,'ok','Терминал');};
$('#fsMinus').onclick=()=>{S.fontSize=Math.max(9,+(S.fontSize-0.5).toFixed(1));renderSettings();toast('Размер шрифта: '+S.fontSize.toFixed(1).replace('.',',')+' px','info','Терминал');};
$('#fsPlus').onclick=()=>{S.fontSize=Math.min(24,+(S.fontSize+0.5).toFixed(1));renderSettings();toast('Размер шрифта: '+S.fontSize.toFixed(1).replace('.',',')+' px','info','Терминал');};
$('#scrollback').addEventListener('change',e=>{
  const v=Math.max(100,Math.min(100000,+e.target.value||10000));e.target.value=v;S.scrollback=v;renderSettings();
  toast('Буфер прокрутки: '+v.toLocaleString('ru-RU')+' строк на вкладку','ok','Терминал');
});
$('#btnResetSettings').onclick=async()=>{
  const ok=await confirmModal({title:'Сбросить настройки?',icon:'refresh',danger:false,ok:'Сбросить',
    text:'Тема, автоблокировка, оболочка и параметры терминала вернутся к значениям по умолчанию. Сессии, ключи и пробросы не пострадают.'});
  if(!ok){toast('Сброс отменён','info','Настройки');return;}
  Object.assign(S,{themeMode:'auto',autolock:15,shellDir:'',shell:'pwsh',font:"'JetBrains Mono','Cascadia Mono',monospace",fontSize:13.5,scrollback:10000});
  applyTheme(true);renderSettings();toast('Настройки сброшены к значениям по умолчанию','ok','Настройки');
};
async function pickShellDir(){
  if(!window.localAPI)return;
  const p=await window.localAPI.pickDir(S.shellDir||shellInfo.home);
  if(!p)return;
  S.shellDir=p;renderSettings();toast('Локальные оболочки будут стартовать из '+p,'ok','Локальный shell');
}
window.pickShellDir=pickShellDir;
$('#btnPickShellDir').onclick=pickShellDir;
if(window.appAPI&&window.appAPI.about)window.appAPI.about().then(a=>{
  $('#aboutVer').textContent=a.version;
  $('#aboutStack').textContent='Electron '+a.electron+' · Chromium '+a.chrome.split('.')[0]+' · Node '+a.node;
});
async function refreshShells(){
  if(!window.localAPI)return;
  shellInfo=await window.localAPI.shells();
  $$('#shellSel option').forEach(o=>{
    const ok=shellInfo.available[o.value];
    o.disabled=!ok;
    o.textContent=SHELL_NAMES[o.value]+(ok?'':' — не установлен');
  });
  if(!shellInfo.available[S.shell]){const first=Object.keys(shellInfo.available).find(k=>shellInfo.available[k]);if(first)S.shell=first;}
  renderSettings();
}
const fmtBytes=n=>n<1024?n+' Б':n<1048576?(n/1024).toFixed(0)+' КБ':n<1073741824?(n/1048576).toFixed(1).replace('.',',')+' МБ':(n/1073741824).toFixed(2).replace('.',',')+' ГБ';
async function refreshTempInfo(){
  if(!window.appAPI)return;
  const r=await window.appAPI.tempInfo();
  if(r.ok)$('#tempInfo').textContent='кэш: '+fmtBytes(r.bytes);
}
$('#btnClearTemp').onclick=async e=>{
  if(!window.appAPI)return;
  const b=e.currentTarget,old=b.innerHTML;
  b.innerHTML='<span class="spinner"></span> Удаляю…';b.disabled=true;
  const r=await window.appAPI.clearTemp();
  b.innerHTML=old;b.disabled=false;
  if(!r.ok){toast(r.error,'err','Временные файлы');return;}
  $('#tempInfo').textContent='кэш: '+fmtBytes(r.bytes);
  toast('Освобождено '+fmtBytes(r.freed)+'. Сейф, настройки и known_hosts не затронуты.','ok','Временные файлы');
};
$('#btnChangePass').onclick=()=>{
  const m=openModal({title:'Смена мастер-пароля',sub:'сейф будет перешифрован заново',icon:'key',
    body:'<div class="field" style="margin-bottom:13px"><label class="field-label">'+IC('lock')+' Текущий пароль</label>'+pwInput('pOld','••••••••','')+'</div>'+
      '<div class="field" style="margin-bottom:13px"><label class="field-label">'+IC('key')+' Новый пароль</label>'+pwInput('pNew','минимум 8 символов','')+'</div>'+
      '<div class="field"><label class="field-label">'+IC('shield')+' Повторите новый</label>'+pwInput('pRep','••••••••','')+'</div>'+
      '<div class="prog" style="margin-top:15px"><i id="pBar"></i></div>'+
      '<p class="hint" id="pTxt" style="margin:10px 0 0">Стойкость: —</p>',
    footer:'<button class="btn ghost left" data-close>'+IC('x')+' Отмена</button><button class="btn primary" id="pGo">'+IC('save')+' Сменить пароль</button>',
    onMount:el=>{
      const bar=el.querySelector('#pBar'),txt=el.querySelector('#pTxt');
      el.querySelector('#pNew').addEventListener('input',e=>{
        const v=e.target.value.length;bar.style.width=Math.min(100,v*6)+'%';
        txt.textContent='Стойкость: '+(v===0?'—':v<8?'слишком короткий':v<12?'средняя':v<16?'хорошая':'отличная');
        txt.style.color=v<8?'var(--err)':v<12?'var(--warn)':'var(--ok)';
      });
      el.querySelector('#pGo').onclick=async e=>{
        const o=el.querySelector('#pOld'),n=el.querySelector('#pNew'),r=el.querySelector('#pRep');
        const fail=x=>{x.classList.add('err');setTimeout(()=>x.classList.remove('err'),450);};
        if(!o.value){fail(o);toast('Введите текущий мастер-пароль','err','Сейф');return;}
        if(n.value.length<8){fail(n);toast('Новый пароль: минимум 8 символов','err','Сейф');return;}
        if(n.value!==r.value){fail(r);toast('Пароли не совпадают','err','Сейф');return;}
        const b=e.currentTarget,old=b.innerHTML;b.innerHTML='<span class="spinner dark"></span> Перешифрую…';b.disabled=true;
        await flushPersist();
        const res=await window.vaultAPI.changePassword(o.value,n.value);
        b.innerHTML=old;b.disabled=false;
        if(!res.ok){fail(o);toast(res.error,'err','Сейф');return;}
        m.close();
        toast('Мастер-пароль изменён, сейф перешифрован','ok','Сейф');
      };
    }});
};
$('#btnBackup').onclick=async()=>{
  await flushPersist();
  const r=await window.vaultAPI.backup();
  if(!r.ok){toast(r.error,'err','Резервная копия');return;}
  if(!r.path)return;
  toast('Копия сохранена: '+r.path+' ('+Math.max(1,Math.round(r.size/1024))+' КБ). Открывается тем же мастер-паролем.','ok','Резервная копия');
};
