"use strict";
/* ---------------- TUNNELS (local forward over SSH) ---------------- */
const tunnelActive={}; // tunnelId -> open client connections
function liveTabForSession(sid){return S.tabs.find(t=>!t.local&&t.session===sid&&t.connId&&!t.closed);}
function renderTunnelForm(){
  const cur=$('#tSession').value;
  $('#tSession').innerHTML=S.sessions.length
    ?S.sessions.map(s=>'<option value="'+s.id+'" '+(s.id===cur?'selected':'')+'>'+esc(s.name)+' · '+esc(s.host)+(liveTabForSession(s.id)?' · подключена':'')+'</option>').join('')
    :'<option value="">— нет сессий —</option>';
}
function renderTunnels(){
  persist();
  const box=$('#tunnelsBox');
  $('#cntTunnels').textContent=S.tunnels.length;
  updateBadges();
  if(!S.tunnels.length){
    box.innerHTML='<div class="table-wrap"><div class="empty">'+
      '<div class="empty-ico">'+IC('tunnels')+'</div>'+
      '<h4>Пробросов портов нет</h4>'+
      '<p>Например, <span class="mono">5433 → 127.0.0.1:5432</span>: база PostgreSQL сервера станет доступна на этом компьютере как <span class="mono">127.0.0.1:5433</span>.</p>'+
      '<button class="btn primary" data-do="focusTunnelForm">'+IC('plus')+' Заполнить форму</button>'+
      (S.sessions.length?'':'<p class="hint">Сначала создайте хотя бы одну сессию — туннель строится поверх неё.</p>')+
      '</div></div></div>';
    return;
  }
  box.innerHTML='<div class="table-wrap"><table><thead><tr><th style="width:190px">Статус</th><th>Имя</th><th style="width:150px">Локально</th><th style="width:210px">На сервере</th><th>Через сессию</th><th style="width:96px"></th></tr></thead><tbody>'+
    S.tunnels.map(t=>{
      const s=S.sessions.find(x=>x.id===t.session);
      const active=tunnelActive[t.id]||0;
      const status=t.on
        ? '<span class="pill on"><span class="sdot"></span>активен'+(active?' · '+active+' соед.':'')+'</span>'
        : (t.auto&&s)
          ? '<span class="pill warn"><span class="sdot"></span>ждёт подключения</span>'
          : '<span class="pill off"><span class="sdot"></span>остановлен</span>';
      return '<tr data-id="'+t.id+'">'+
        '<td data-l="Статус">'+status+'</td>'+
        '<td data-l="Имя" class="name">'+esc(t.name)+'</td>'+
        '<td data-l="Локально" class="mono">127.0.0.1:'+t.lport+'</td>'+
        '<td data-l="На сервере" class="mono">'+esc(t.host)+':'+t.rport+'</td>'+
        '<td data-l="Через сессию">'+(s?'<a href="#" class="sess-link" data-s="'+s.id+'" style="text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:6px">'+IC('link')+' '+esc(s.name)+' <span class="osb" style="--osc:'+osOf(s.os).color+';font-size:11px">'+IC(osOf(s.os).icon)+' '+esc(osLabel(s.os,s.osName))+'</span></a>':'<span class="pill err"><span class="sdot"></span>сессия удалена</span>')+'</td>'+
        '<td data-l=""><div class="row-actions">'+
          '<button class="ibtn ok" title="'+(t.on?'Остановить':(t.auto?'Отменить автозапуск':'Запустить'))+'" data-do="toggleTunnel" data-arg="'+t.id+'">'+IC(t.on||t.auto?'pause':'play')+'</button>'+
          '<button class="ibtn x" title="Удалить проброс" data-do="delTunnel" data-arg="'+t.id+'">'+IC('x')+'</button>'+
        '</div></td></tr>';
    }).join('')+'</tbody></table></div>';
  $$('#tunnelsBox .sess-link').forEach(a=>{a.onclick=e=>{
    e.preventDefault();go('sessions');S.selSession=a.dataset.s;renderSessions();
    const tr=document.querySelector('#sessionsBox tr[data-id="'+a.dataset.s+'"]');
    if(tr){tr.classList.add('sel');tr.scrollIntoView({block:'center',behavior:'smooth'});}
  };});
}
async function startTunnel(t,tab,verbose){
  const r=await window.tunnelAPI.start({tunnelId:t.id,connId:tab.connId,lport:t.lport,host:t.host,rport:t.rport});
  if(!r.ok){t.on=false;renderTunnels();toast('«'+t.name+'»: '+r.error,'err','Проброс не запущен');logEvent('err','tunnel','«'+t.name+'» не запущен: '+r.error,tunnelTarget(t));return false;}
  t.on=true;t.auto=true;renderTunnels();
  logEvent('ok','tunnel','«'+t.name+'» запущен через «'+tab.name+'»',tunnelTarget(t));
  if(verbose)toast('127.0.0.1:'+t.lport+' → '+t.host+':'+t.rport+' через «'+tab.name+'»','ok','Туннель активен');
  return true;
}
async function autostartTunnels(sessionId){
  const tab=liveTabForSession(sessionId);if(!tab||!window.tunnelAPI)return;
  let n=0;
  for(const t of S.tunnels.filter(x=>x.session===sessionId&&x.auto&&!x.on)){if(await startTunnel(t,tab,false))n++;}
  if(n)toast('Поднято пробросов портов: '+n,'ok','Пробросы портов');
}
async function syncTunnels(){
  if(!window.tunnelAPI)return;
  const list=await window.tunnelAPI.list();
  list.forEach(x=>{const t=S.tunnels.find(y=>y.id===x.tunnelId);if(t){t.on=true;tunnelActive[t.id]=x.active;}});
  renderTunnels();
}
async function stopTunnelNow(t){
  if(t.on&&window.tunnelAPI)await window.tunnelAPI.stop(t.id);
  t.on=false;delete tunnelActive[t.id];
}
if(window.tunnelAPI){
  window.tunnelAPI.onStopped(p=>{
    const t=S.tunnels.find(x=>x.id===p.tunnelId);if(!t)return;
    t.on=false;delete tunnelActive[t.id];renderTunnels();
    logEvent('warn','tunnel','«'+t.name+'» остановлен: '+p.reason,tunnelTarget(t));
    toast('«'+t.name+'» остановлен: '+p.reason+(t.auto?'. Поднимется снова при подключении.':''),'warn','Пробросы портов');
  });
  window.tunnelAPI.onActivity(p=>{
    tunnelActive[p.tunnelId]=p.active;
    if(S.view==='tunnels')renderTunnels();
  });
  window.tunnelAPI.onError(p=>{
    const t=S.tunnels.find(x=>x.id===p.tunnelId);
    toast((t?'«'+t.name+'»: ':'')+p.message,'err','Сервер не открыл соединение');
    logEvent('err','tunnel','Сервер не открыл соединение: '+p.message,t?tunnelTarget(t):'');
  });
}
window.toggleTunnel=async id=>{
  const t=S.tunnels.find(x=>x.id===id);if(!t)return;
  if(t.on){
    await stopTunnelNow(t);t.auto=false;renderTunnels();
    logEvent('info','tunnel','«'+t.name+'» остановлен вручную',tunnelTarget(t));
    toast('Проброс «'+t.name+'» остановлен','info','Пробросы портов');return;
  }
  const s=S.sessions.find(x=>x.id===t.session);
  const tab=s&&liveTabForSession(s.id);
  if(tab){await startTunnel(t,tab,true);return;}
  t.auto=!t.auto;renderTunnels();
  if(!s)toast('Сессия этого проброса удалена','err','Пробросы портов');
  else toast(t.auto?'«'+s.name+'» не подключена — проброс запустится при подключении':'Автозапуск «'+t.name+'» отменён','info','Пробросы портов');
};
window.delTunnel=async(id,tr)=>{
  const t=S.tunnels.find(x=>x.id===id);if(!t)return;
  const ok=await confirmModal({title:'Удалить проброс?',icon:'tunnels',text:'«<b>'+esc(t.name)+'</b>»: <span class="mono">127.0.0.1:'+t.lport+' → '+esc(t.host)+':'+t.rport+'</span>'+(t.on?'<br>Активные соединения будут закрыты.':''),ok:'Удалить'});
  if(!ok)return;
  await stopTunnelNow(t);
  tr.classList.add('dying');
  setTimeout(()=>{S.tunnels=S.tunnels.filter(x=>x.id!==id);renderTunnels();toast('Проброс «'+t.name+'» удалён','ok','Пробросы портов');},260);
};
$('#btnAddTunnel').onclick=async()=>{
  const name=$('#tName').value.trim(),sid=$('#tSession').value,
        lport=+$('#tLPort').value,host=$('#tHost').value.trim()||'127.0.0.1',rport=+$('#tRPort').value;
  let bad=null,msg='';
  if(!S.sessions.length){toast('Нет сессий — туннель не на чём строить','err','Пробросы портов');go('sessions');return;}
  if(!name){bad=$('#tName');msg='Укажите имя проброса';}
  else if(!lport||lport<1||lport>65535){bad=$('#tLPort');msg='Локальный порт: 1–65535';}
  else if(S.tunnels.some(t=>t.lport===lport)){bad=$('#tLPort');msg='Порт '+lport+' уже используется другим пробросом';}
  else if(!rport||rport<1||rport>65535){bad=$('#tRPort');msg='Порт на сервере: 1–65535';}
  if(bad){bad.classList.add('err');setTimeout(()=>bad.classList.remove('err'),450);toast(msg,'err','Не добавлено');return;}
  const t={id:uid('f'),name:name,session:sid,lport:lport,host:host,rport:rport,on:false,auto:true};
  S.tunnels.push(t);
  $('#tName').value='';$('#tLPort').value='';$('#tHost').value='';$('#tRPort').value='';
  const tab=liveTabForSession(sid);
  if(tab){await startTunnel(t,tab,true);}
  else{renderTunnels();toast('Проброс «'+name+'» сохранён — запустится при подключении сессии','info','Проброс добавлен');}
};
['#tLPort','#tRPort'].forEach(sel=>{$(sel).addEventListener('input',e=>{e.target.value=e.target.value.replace(/\D/g,'').slice(0,5);});});
['#tName','#tHost','#tLPort','#tRPort'].forEach(sel=>{$(sel).addEventListener('keydown',e=>{if(e.key==='Enter')$('#btnAddTunnel').click();});});
