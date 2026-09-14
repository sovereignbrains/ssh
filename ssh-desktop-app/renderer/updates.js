"use strict";
/* ---------------- UPDATES (GitHub Releases via electron-updater) ---------------- */
const UPD={s:null,noticed:{}};
const updTime=ts=>ts?new Date(ts).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
function renderUpdatePill(){
  const s=UPD.s,pill=$('#updPill');if(!s||!pill)return;
  const show=['available','downloading','downloaded'].includes(s.state);
  pill.hidden=!show;
  if(!show)return;
  const pct=Math.round(s.percent||0);
  pill.className='upd-pill '+s.state;
  pill.innerHTML=s.state==='downloaded'?IC('refresh')+'<span>Перезапустить и обновить</span>'
    :s.state==='downloading'?'<span class="upd-ring" style="--p:'+pct+'"></span><span>'+pct+'%</span>'
    :IC('download')+'<span>Обновление '+esc(s.version)+'</span>';
  pill.title=s.state==='downloaded'?'Версия '+s.version+' загружена — перезапустить приложение и установить'
    :s.state==='downloading'?'Загрузка версии '+s.version:'Доступна версия '+s.version+' — нажмите, чтобы скачать';
}
function renderUpdateBox(){
  const s=UPD.s,box=$('#updBox');if(!s||!box)return;
  const pct=Math.round(s.percent||0);
  let status,action='';
  if(!s.supported)status='<span class="hint">Обновления работают только в установленной версии приложения.</span>';
  else if(s.state==='checking')status='<span class="upd-st"><span class="spinner"></span> Проверка обновлений…</span>';
  else if(s.state==='none')status='<span class="upd-st ok">'+IC('check-c')+' Установлена последняя версия</span>';
  else if(s.state==='available'){status='<span class="upd-st new">'+IC('download')+' Доступна версия <b>'+esc(s.version)+'</b></span>';action='<button class="btn primary sm" data-do="updDownload">'+IC('download')+' Скачать и установить</button>';}
  else if(s.state==='downloading')status='<span class="upd-st">Загрузка '+esc(s.version)+': '+pct+'%'+(s.total?' · '+fmtBytes(s.transferred)+' из '+fmtBytes(s.total):'')+(s.bytesPerSecond?' · '+fmtBytes(Math.round(s.bytesPerSecond))+'/с':'')+'</span><div class="prog" style="margin-top:8px"><i style="width:'+pct+'%"></i></div>';
  else if(s.state==='downloaded'){status='<span class="upd-st ok">'+IC('check-c')+' Версия <b>'+esc(s.version)+'</b> загружена</span>';action='<button class="btn primary sm" data-do="updInstall">'+IC('refresh')+' Перезапустить и установить</button>';}
  else if(s.state==='error')status='<span class="upd-st err">'+IC('alert')+' '+esc(s.error)+'</span>';
  else status='<span class="hint">'+(s.checkedAt?'Последняя проверка: '+updTime(s.checkedAt):'Ещё не проверялось')+'</span>';
  const busy=s.state==='checking'||s.state==='downloading';
  box.innerHTML=
    '<div class="upd-row">'+status+'</div>'+
    (s.checkedAt&&s.state==='none'?'<div class="hint" style="margin-top:3px">Проверено: '+updTime(s.checkedAt)+'</div>':'')+
    (s.notes&&(s.state==='available'||s.state==='downloading'||s.state==='downloaded')?'<details class="upd-notes" open><summary>Что нового в '+esc(s.version)+'</summary><pre>'+esc(s.notes)+'</pre></details>':'')+
    '<div class="upd-actions">'+action+
      (s.state!=='downloaded'&&s.supported?'<button class="btn ghost sm" data-do="updCheck" '+(busy?'disabled':'')+'>'+IC('refresh')+' Проверить обновления</button>':'')+
    '</div>'+
    '<label class="upd-auto"><input type="checkbox" id="updAuto" '+(s.autoCheck?'checked':'')+(s.supported?'':' disabled')+'> Проверять автоматически — при запуске и каждые 4 часа</label>';
  const auto=$('#updAuto');
  if(auto)auto.onchange=()=>window.updateAPI.setAuto(auto.checked);
}
function onUpdateState(s){
  const prev=UPD.s;UPD.s=s;
  renderUpdatePill();renderUpdateBox();
  if(!prev)return;
  if(s.state==='available'&&prev.state!=='available'&&!UPD.noticed['a'+s.version]){
    UPD.noticed['a'+s.version]=true;
    toast('Доступна версия '+s.version+' — кнопка «Обновление» в заголовке окна','info','Обновление');
  }
  if(s.state==='downloaded'&&prev.state!=='downloaded')toast('Версия '+s.version+' загружена. Установится при перезапуске — или нажмите «Перезапустить и обновить».','ok','Обновление');
  if(s.state==='none'&&prev.state==='checking'&&s.manual)toast('У вас последняя версия ('+s.current+')','ok','Обновление');
}
async function updInstall(){
  const live=S.tabs.filter(t=>t.local?!t.exited:!t.closed).length;
  const ok=await confirmModal({title:'Перезапустить и обновить?',icon:'refresh',danger:false,ok:'Перезапустить',
    text:'Приложение закроется, установится версия <b>'+esc(UPD.s.version)+'</b> и запустится снова.'+
      (live?'<br><br><span style="color:var(--warn)">Открытые вкладки ('+live+') будут закрыты: SSH-соединения разорваны, локальные оболочки завершены.</span>':'')+
      '<br>Данные сейфа сохранятся.'});
  if(!ok)return;
  const r=await window.updateAPI.install();
  if(!r.ok)toast('Не удалось запустить установку','err','Обновление');
}
if(window.updateAPI){
  window.updateAPI.onState(onUpdateState);
  window.updateAPI.get().then(s=>{if(!UPD.s)onUpdateState(s);});
  ACTIONS.updCheck=()=>window.updateAPI.check();
  ACTIONS.updDownload=()=>window.updateAPI.download();
  ACTIONS.updInstall=()=>updInstall();
  $('#updPill').onclick=()=>{
    const s=UPD.s;if(!s)return;
    if(s.state==='available')window.updateAPI.download();
    else if(s.state==='downloaded')updInstall();
    else{go('settings');setTimeout(()=>{const b=$('#updBox');if(b)b.scrollIntoView({behavior:'smooth',block:'center'});},250);}
  };
}
