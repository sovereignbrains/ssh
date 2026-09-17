"use strict";
/* ---------------- SECRETS ----------------
   Values live in the vault like everything else. The agent never receives them: the main process
   substitutes a secret at the moment a command runs and cuts it back out of the output. */
const SECRET_NAME_RE=/^[A-Za-z_][A-Za-z0-9_]*$/;
const HOUR=3600000;
const secretLive=s=>!!s.agentAccess&&(!s.expiresAt||s.expiresAt>Date.now());
const secretClock=ts=>new Date(ts).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
const secretById=id=>S.secrets.find(x=>x.id===id);
const scopeName=id=>id==='local'?'этот компьютер':((S.sessions.find(s=>s.id===id)||{}).name||'удалённая сессия');

// Everything the main process needs to substitute and to redact — values included, metadata only
// from here on out: the renderer already holds the open vault, the agent process never does.
function pushAgentSecrets(){
  if(!window.secretsAPI)return;
  window.secretsAPI.sync(S.secrets.map(s=>({name:s.name,value:s.value,agentAccess:!!s.agentAccess,scope:s.scope||[],expiresAt:s.expiresAt||0})));
}

function renderSecrets(){
  persist();
  pushAgentSecrets();
  updateBadges();
  const box=$('#secretsBox');
  if(!box)return;
  $('#cntSecrets').textContent=S.secrets.length;
  if(!S.secrets.length){
    box.innerHTML='<div class="card set-panel"><div class="empty">'+
      '<div class="empty-ico">'+IC('shield')+'</div>'+
      '<h4>Отсеков пока нет</h4>'+
      '<p>Заведите отсек для API-ключа — например <span class="mono">GITHUB_TOKEN</span> или <span class="mono">CLOUDFLARE_API_TOKEN</span>. Claude сможет выполнить команду с ним, но значения не увидит: в его переписке останется метка <span class="mono">{{secret:ИМЯ}}</span>.</p>'+
      '</div></div>';
    return;
  }
  box.innerHTML='<div class="card set-panel klist">'+S.secrets.map(secretRow).join('')+'</div>';
}
function secretRow(s){
  const live=secretLive(s),expired=s.agentAccess&&s.expiresAt&&s.expiresAt<=Date.now();
  const scope=(s.scope||[]).length?(s.scope||[]).map(id=>'<span class="k-chip">'+esc(scopeName(id))+'</span>').join(''):'<span class="kr-none">везде</span>';
  return '<div class="krow secrow" data-id="'+s.id+'">'+
    '<span class="k-ico sec">'+IC('shield')+'</span>'+
    '<div class="kr-main">'+
      '<div class="kr-name"><b class="mono">'+esc(s.name)+'</b>'+(s.note?'<span class="tag">'+esc(s.note)+'</span>':'')+'</div>'+
      '<div class="kr-meta"><span>'+(s.expiresAt?(expired?'доступ истёк '+secretClock(s.expiresAt):'доступ до '+secretClock(s.expiresAt)):'бессрочно')+'</span>'+
        (s.createdAt?'<span class="kr-date">заведён '+secretClock(s.createdAt)+'</span>':'')+'</div>'+
    '</div>'+
    '<div class="kr-used">'+scope+'</div>'+
    '<div class="kr-acts">'+
      '<button class="ibtn" title="Показать значение" data-do="revealSecret" data-arg="'+s.id+'">'+IC('eye')+'</button>'+
      '<button class="ibtn" title="Изменить отсек" data-do="secretModal" data-arg="'+s.id+'">'+IC('pencil')+'</button>'+
      '<button class="ibtn" title="Открыть доступ агенту на час" data-do="secretHour" data-arg="'+s.id+'">'+IC('clock')+'</button>'+
      '<button class="ibtn x" title="Удалить отсек" data-do="delSecret" data-arg="'+s.id+'">'+IC('x')+'</button>'+
      '<button class="pill clickable '+(live?'on':expired?'warn':'off')+' kr-install" title="'+(live?'Агент может использовать этот секрет — нажмите, чтобы закрыть доступ':'Агент не получит этот секрет — нажмите, чтобы открыть доступ')+'" data-do="toggleSecret" data-arg="'+s.id+'"><span class="sdot"></span>'+(live?'доступен агенту':expired?'срок истёк':'скрыт')+'</button>'+
    '</div>'+
  '</div>';
}
window.revealSecret=id=>{
  const s=secretById(id);if(!s)return;
  openModal({title:'Значение секрета',sub:esc(s.name),icon:'shield',
    body:'<div class="field"><label class="field-label">'+IC('lock')+' Хранится в сейфе, в переписку с агентом не попадает</label>'+
      pwInput('secShow','',s.value)+'</div>',
    footer:'<button class="btn ghost left" data-close>'+IC('x')+' Закрыть</button><button class="btn primary" id="secCopy">'+IC('copy')+' Копировать</button>',
    onMount:el=>{
      el.querySelector('#secShow').readOnly=true;
      el.querySelector('#secCopy').onclick=()=>{navigator.clipboard&&navigator.clipboard.writeText(s.value).catch(()=>{});toast('Значение «'+s.name+'» скопировано','ok','Секреты');};
    }});
};
window.toggleSecret=id=>{
  const s=secretById(id);if(!s)return;
  const on=secretLive(s);
  s.agentAccess=!on;
  if(!on)s.expiresAt=0;
  renderSecrets();
  logEvent(on?'info':'warn','secret',(on?'Доступ агента закрыт: ':'Доступ агента открыт бессрочно: ')+s.name,'');
  toast(on?('«'+s.name+'» скрыт от агента'):('«'+s.name+'» доступен агенту — без срока'),on?'ok':'warn','Секреты');
};
window.secretHour=id=>{
  const s=secretById(id);if(!s)return;
  s.agentAccess=true;s.expiresAt=Date.now()+HOUR;
  renderSecrets();
  logEvent('warn','secret','Доступ агента открыт на час: '+s.name,'');
  toast('«'+s.name+'» доступен агенту до '+secretClock(s.expiresAt),'warn','Секреты');
};
window.delSecret=async(id,el)=>{
  const s=secretById(id);if(!s)return;
  const ok=await confirmModal({title:'Удалить отсек?',icon:'shield',
    text:'«<b>'+esc(s.name)+'</b>» будет удалён из сейфа вместе со значением. Сам ключ на стороне сервиса при этом продолжит работать — отзывать его нужно там.',ok:'Удалить'});
  if(!ok){toast('Удаление отменено','info','Секреты');return;}
  const row=el&&el.closest('.krow');
  if(row)row.classList.add('dying');
  setTimeout(()=>{
    S.secrets=S.secrets.filter(x=>x.id!==id);
    renderSecrets();
    logEvent('info','secret','Отсек удалён: '+s.name,'');
    toast('Отсек «'+s.name+'» удалён','ok','Секреты');
  },row?260:0);
};
window.secretModal=id=>{
  if(!S.vaultOpen){toast('Сейф заблокирован','err','Отказано');lockScreenFocus();return;}
  const s=id?secretById(id):null;
  if(id&&!s)return;
  let scope=(s&&s.scope||[]).slice();
  const targets=[{id:'local',name:'Этот компьютер'}].concat(S.sessions.map(x=>({id:x.id,name:x.name})));
  const m=openModal({title:s?'Изменить отсек':'Новый отсек',sub:s?esc(s.name):'секрет хранится в сейфе, агент видит только имя',icon:'shield',wide:true,
    body:'<div class="grid2">'+
        '<div class="field"><label class="field-label">'+IC('hash')+' Имя</label>'+
          '<input class="inp mono" id="secName" placeholder="GITHUB_TOKEN" value="'+esc(s?s.name:'')+'"></div>'+
        '<div class="field"><label class="field-label">'+IC('note')+' Заметка</label>'+
          '<input class="inp" id="secNote" placeholder="для чего этот ключ" value="'+esc(s?(s.note||''):'')+'"></div>'+
      '</div>'+
      '<div class="field" style="margin-top:14px"><label class="field-label">'+IC('lock')+' Значение</label>'+
        pwInput('secValue','вставьте ключ',s?s.value:'')+'</div>'+
      '<label class="upd-auto" style="margin-top:14px"><input type="checkbox" id="secAccess" '+(s&&s.agentAccess?'checked':'')+'> Доступен агенту — Claude сможет запускать команды с этим секретом</label>'+
      '<div class="field" style="margin-top:14px"><label class="field-label">'+IC('clock')+' Срок доступа</label>'+
        '<div class="seg" id="secTtl">'+
          '<button class="seg-item on" data-ttl="0">бессрочно</button>'+
          '<button class="seg-item" data-ttl="1">на час</button>'+
          '<button class="seg-item" data-ttl="24">на сутки</button>'+
        '</div></div>'+
      '<div class="field" style="margin-top:14px"><label class="field-label">'+IC('server')+' Где действует — ничего не выбрано, значит везде</label>'+
        '<div class="sec-scope" id="secScope">'+targets.map(t=>'<button class="k-chip clickable" data-sid="'+t.id+'">'+esc(t.name)+'</button>').join('')+'</div></div>'+
      '<p class="hint" style="margin:12px 0 0">'+IC('info')+' В переписке с Claude значение не появится: в команду его подставляет приложение, а из вывода вырезает обратно в метку <span class="mono">{{secret:ИМЯ}}</span>.</p>',
    footer:'<button class="btn ghost left" data-close>'+IC('x')+' Отмена</button><button class="btn primary" id="secSave">'+IC('save')+' Сохранить</button>',
    onMount:el=>{
      const paintScope=()=>el.querySelectorAll('#secScope .k-chip').forEach(b=>b.classList.toggle('on',scope.includes(b.dataset.sid)));
      paintScope();
      el.querySelector('#secScope').onclick=e=>{
        const b=e.target.closest('.k-chip');if(!b)return;
        scope=scope.includes(b.dataset.sid)?scope.filter(x=>x!==b.dataset.sid):scope.concat(b.dataset.sid);
        paintScope();
      };
      el.querySelectorAll('#secTtl .seg-item').forEach(b=>{b.onclick=()=>{
        el.querySelectorAll('#secTtl .seg-item').forEach(x=>x.classList.remove('on'));b.classList.add('on');
      };});
      el.querySelector('#secSave').onclick=()=>{
        const nameEl=el.querySelector('#secName'),valEl=el.querySelector('#secValue');
        const name=nameEl.value.trim().toUpperCase(),value=valEl.value;
        const bad=(x,msg)=>{x.classList.add('err');setTimeout(()=>x.classList.remove('err'),450);x.focus();toast(msg,'err','Секреты');};
        if(!SECRET_NAME_RE.test(name))return bad(nameEl,'Имя — как переменная окружения: латиница, цифры и подчёркивание');
        if(S.secrets.some(x=>x.name===name&&x.id!==(s&&s.id)))return bad(nameEl,'Отсек с таким именем уже есть');
        if(!value)return bad(valEl,'Вставьте значение секрета');
        const ttl=+el.querySelector('#secTtl .seg-item.on').dataset.ttl;
        const access=el.querySelector('#secAccess').checked;
        const rec=s||{id:uid('sec'),createdAt:Date.now()};
        Object.assign(rec,{name:name,value:value,note:el.querySelector('#secNote').value.trim(),
          agentAccess:access,scope:scope,expiresAt:access&&ttl?Date.now()+ttl*HOUR:0});
        if(!s)S.secrets.push(rec);
        m.close();
        renderSecrets();
        logEvent('info','secret',(s?'Отсек изменён: ':'Отсек заведён: ')+name+(access?(rec.expiresAt?' · доступ агенту до '+secretClock(rec.expiresAt):' · доступ агенту открыт'):' · доступ агенту закрыт'),'');
        toast(s?('Отсек «'+name+'» сохранён'):('Отсек «'+name+'» заведён'),'ok','Секреты');
      };
    }});
};
Object.assign(ACTIONS,{
  secretModal:a=>secretModal(a||undefined),
  revealSecret:a=>revealSecret(a),
  toggleSecret:a=>toggleSecret(a),
  secretHour:a=>secretHour(a),
  delSecret:(a,el)=>delSecret(a,el)
});
$('#btnAddSecret').onclick=()=>secretModal();
// An expired grant has to stop looking live even if nobody touches the section.
setInterval(()=>{if(S.vaultOpen&&S.secrets.some(s=>s.agentAccess&&s.expiresAt&&s.expiresAt<=Date.now()+1000))renderSecrets();},30000);
