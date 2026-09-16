"use strict";
/* ---------------- JOURNAL ---------------- */
const JOURNAL_MAX=2000;
const journalQueue=[]; // events that happen while the vault is locked, merged on unlock
let errorEntries=[],journalTab='sessions';
const JTYPES={claude:'Claude',sftp:'SFTP',connect:'Подключение',disconnect:'Отключение',hostkey:'Ключ хоста',key:'Ключи',tunnel:'Проброс',local:'Локальный shell',vault:'Сейф',project:'Проект'};
const JLEVELS={ok:['on','успех'],info:['off','инфо'],warn:['warn','внимание'],err:['err','ошибка']};
const sessTarget=s=>s?s.name+' · '+s.user+'@'+s.host+':'+s.port:'';
const tunnelTarget=t=>'127.0.0.1:'+t.lport+' → '+t.host+':'+t.rport;
function fmtDuration(ms){
  const sec=Math.max(0,Math.round(ms/1000));
  if(sec<60)return sec+' с';
  const min=Math.floor(sec/60);
  return min<60?min+' мин '+(sec%60)+' с':Math.floor(min/60)+' ч '+(min%60)+' мин';
}
function jTime(ts){const d=new Date(ts);return d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'2-digit'})+' '+d.toLocaleTimeString('ru-RU');}
function logEvent(level,type,message,target){
  const e={id:uid('j'),ts:Date.now(),level:level,type:type,msg:String(message),target:target||''};
  if(!S.vaultOpen){journalQueue.push(e);if(journalQueue.length>200)journalQueue.shift();return;}
  S.journal.push(e);
  if(S.journal.length>JOURNAL_MAX)S.journal.splice(0,S.journal.length-JOURNAL_MAX);
  persist();
  if(S.view==='journal'&&journalTab==='sessions')renderJournal();
}
function journalRows(){
  const qs=($('#journalSearch').value||'').trim().toLowerCase(),lvl=$('#journalLevel').value;
  if(journalTab==='sessions')
    return S.journal.slice().reverse().filter(e=>(!lvl||e.level===lvl)&&(!qs||(e.msg+' '+e.target+' '+(JTYPES[e.type]||e.type)).toLowerCase().includes(qs)));
  return errorEntries.slice().reverse().filter(e=>!qs||(e.source+' '+e.message+' '+(e.stack||'')).toLowerCase().includes(qs));
}
function updateJournalBadge(){
  $('#bgJournal').textContent=errorEntries.length;
  $('#bgJournal').classList.toggle('alert',errorEntries.length>0);
  $('#errCount').textContent=errorEntries.length?' · '+errorEntries.length:'';
}
function renderJournal(){
  updateJournalBadge();
  const isS=journalTab==='sessions';
  $('#cntJournal').textContent=isS?S.journal.length:errorEntries.length;
  $$('#journalTabs .seg-item').forEach(b=>b.classList.toggle('on',b.dataset.j===journalTab));
  $('#journalLevel').style.display=isS?'':'none';
  const rows=journalRows(),box=$('#journalBox');
  if(!rows.length){
    const filtered=isS?S.journal.length:errorEntries.length;
    box.innerHTML='<div class="table-wrap"><div class="empty"><div class="empty-ico">'+IC(isS?'activity':'check')+'</div>'+
      '<h4>'+(filtered?'Ничего не найдено':(isS?'Журнал сессий пуст':'Сбоев не было'))+'</h4>'+
      '<p>'+(filtered?'Измените поиск или фильтр.':(isS?'Здесь появятся подключения, отключения, ключи хостов, пробросы и локальные оболочки.':'Если в приложении что-то упадёт, запись появится здесь.'))+'</p></div></div>';
    return;
  }
  const shown=rows.slice(0,500);
  box.innerHTML='<div class="table-wrap"><table><thead><tr>'+
    (isS?'<th style="width:172px">Время</th><th style="width:118px">Уровень</th><th style="width:140px">Событие</th><th style="width:250px">Объект</th><th>Подробности</th>'
        :'<th style="width:172px">Время</th><th style="width:170px">Источник</th><th>Сообщение</th>')+
    '</tr></thead><tbody>'+
    shown.map(e=>isS
      ? '<tr><td data-l="Время" class="mono">'+jTime(e.ts)+'</td>'+
        '<td data-l="Уровень"><span class="pill '+(JLEVELS[e.level]||['off'])[0]+'"><span class="sdot"></span>'+(JLEVELS[e.level]||[0,e.level])[1]+'</span></td>'+
        '<td data-l="Событие">'+esc(JTYPES[e.type]||e.type)+'</td>'+
        '<td data-l="Объект" class="mono" style="overflow-wrap:anywhere">'+esc(e.target).replace(/ · /g,' ·<wbr> ')+'</td>'+
        '<td data-l="Подробности" class="jr-msg">'+esc(e.msg)+'</td></tr>'
      : '<tr><td data-l="Время" class="mono">'+jTime(e.ts)+'</td>'+
        '<td data-l="Источник"><span class="pill err"><span class="sdot"></span>'+esc(e.source)+'</span></td>'+
        '<td data-l="Сообщение" class="jr-msg">'+esc(e.message)+
          (e.stack?'<details class="jr-stack"><summary>стек вызовов</summary><pre>'+esc(e.stack)+'</pre></details>':'')+'</td></tr>'
    ).join('')+'</tbody></table></div>'+
    (rows.length>shown.length?'<p class="hint" style="margin:10px 2px 0">Показаны последние 500 из '+rows.length+'. Полный журнал — через «Экспорт».</p>':'');
}
$$('#journalTabs .seg-item').forEach(b=>{b.onclick=()=>{journalTab=b.dataset.j;renderJournal();};});
$('#journalSearch').addEventListener('input',()=>renderJournal());
$('#journalLevel').addEventListener('change',()=>renderJournal());
$('#btnJournalClear').onclick=async()=>{
  const isS=journalTab==='sessions',count=isS?S.journal.length:errorEntries.length;
  if(!count){toast('Журнал уже пуст','info','Журнал');return;}
  const ok=await confirmModal({title:isS?'Очистить журнал сессий?':'Очистить журнал сбоев?',icon:'eraser',ok:'Очистить',
    text:isS?'Будут удалены все записи о подключениях ('+count+'). Сессии, ключи и пробросы не пострадают.'
            :'Файл <span class="mono">logs\\errors.log</span> будет удалён ('+count+' записей).'});
  if(!ok)return;
  if(isS){S.journal=[];S.journalClearedAt=Date.now();persist();}
  else{await window.appAPI.clearErrors();errorEntries=[];}
  renderJournal();
  toast(isS?'Журнал сессий очищен':'Журнал сбоев очищен','ok','Журнал');
};
$('#btnJournalExport').onclick=async()=>{
  const rows=journalRows();
  if(!rows.length){toast('Нечего экспортировать','info','Журнал');return;}
  const isS=journalTab==='sessions';
  const text=(isS
    ? rows.map(e=>[jTime(e.ts),(JLEVELS[e.level]||[0,e.level])[1],JTYPES[e.type]||e.type,e.target,e.msg].join('\t'))
    : rows.map(e=>jTime(e.ts)+'\t'+e.source+'\t'+e.message+(e.stack?'\r\n'+e.stack:''))).join('\r\n')+'\r\n';
  const p=await window.appAPI.exportJournal((isS?'ssh-journal-':'ssh-errors-')+new Date().toISOString().slice(0,10)+'.txt',text);
  if(p)toast('Сохранено: '+p,'ok','Журнал');
};
if(window.appAPI){
  window.appAPI.onError(e=>{
    errorEntries.push(e);
    if(errorEntries.length>1000)errorEntries.shift();
    if(S.view==='journal'&&journalTab==='errors')renderJournal();else updateJournalBadge();
  });
  window.appAPI.listErrors().then(list=>{errorEntries=list||[];updateJournalBadge();});
}
