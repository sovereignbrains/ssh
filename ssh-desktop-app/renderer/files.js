"use strict";
/* ---------------- FILES (SFTP) ---------------- */
const FX={connId:null,path:'',entries:[],sel:new Set(),anchor:null,showHidden:false,filter:'',sort:{key:'name',asc:true},loading:false,error:'',paths:{},transfers:{},jobMeta:{}};
const fxBase=p=>String(p).split(/[\\/]/).filter(Boolean).pop()||String(p);
const fxJoin=(dir,name)=>(dir==='/'?'':dir.replace(/\/+$/,''))+'/'+name;
const fxParent=p=>{const t=p.replace(/\/+$/,'');const i=t.lastIndexOf('/');return i<=0?'/':t.slice(0,i);};
function fxLiveTabs(){return S.tabs.filter(t=>!t.local&&t.connId&&!t.closed);}
function fxTab(){return fxLiveTabs().find(t=>t.connId===FX.connId)||null;}
function fxVisible(){
  const q=FX.filter.trim().toLowerCase();
  const list=FX.entries.filter(e=>(FX.showHidden||!e.name.startsWith('.'))&&(!q||e.name.toLowerCase().includes(q)));
  const k=FX.sort.key,dir=FX.sort.asc?1:-1;
  return list.sort((a,b)=>(b.dir-a.dir)||(k==='size'?(a.size-b.size)*dir:k==='mtime'?(a.mtime-b.mtime)*dir:a.name.localeCompare(b.name,'ru',{numeric:true})*dir));
}
function fxShown(){const g=activeGroup();return !!(g&&g.kind==='sftp');}
// Each server's files open in their own top tab; the listing state is shared and follows the tab in front.
function openFiles(connId){
  if(!connId){
    const f=focusedSshTab(),live=fxLiveTabs();
    connId=f?f.connId:(live.some(t=>t.connId===FX.connId)?FX.connId:(live[0]&&live[0].connId));
  }
  if(!connId){toast('Нет активных SSH-подключений — подключитесь к сессии, и её файлы откроются здесь','info','SFTP');go('sessions');return;}
  let g=S.groups.find(x=>x.kind==='sftp'&&x.connId===connId);
  if(!g){
    const t=fxLiveTabs().find(x=>x.connId===connId);
    const owner=t&&groupOfTab(t.id);
    g={id:uid('g'),kind:'sftp',connId:connId,name:t?t.name:''};
    const at=owner?S.groups.indexOf(owner)+1:S.groups.length;
    S.groups.splice(at,0,g);
  }
  activateGroup(g.id);
}
window.openFiles=openFiles;
function fxShow(connId){
  if(FX.connId!==connId){FX.connId=connId;FX.sel.clear();FX.entries=[];FX.path='';FX.filter='';FX.error='';FX.loadedFor=null;}
  if(fxTab()&&(FX.loadedFor!==connId||(!FX.entries.length&&!FX.error)))fxLoad(FX.paths[connId]||null);
  else renderFiles();
}
async function fxLoad(dir){
  if(!FX.connId){renderFiles();return;}
  const connId=FX.connId;
  FX.loading=true;FX.error='';renderFiles();
  if(!dir){const h=await window.sftpAPI.home(connId);if(!h.ok){FX.loading=false;FX.error=h.error;FX.entries=[];renderFiles();return;}dir=h.path;}
  const r=await window.sftpAPI.list(connId,dir);
  if(connId!==FX.connId)return;
  FX.loading=false;
  if(!r.ok){FX.error=r.error;if(!FX.path)FX.entries=[];renderFiles();toast(dir+': '+r.error,'err','SFTP');return;}
  if(r.path!==FX.path)FX.sel.clear();
  FX.path=r.path;FX.paths[connId]=r.path;FX.entries=r.entries;FX.loadedFor=connId;
  const names=new Set(r.entries.map(e=>e.path));FX.sel.forEach(p=>{if(!names.has(p))FX.sel.delete(p);});
  renderFiles();
}
function fxTransferRows(){
  const list=Object.values(FX.transfers).sort((a,b)=>b.startedAt-a.startedAt);
  if(!list.length)return '';
  return '<div class="card fx-transfers"><div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">'+
    '<b style="font-size:13px">Передачи</b><span class="hint" style="margin:0">'+list.filter(t=>t.state==='running'||t.state==='preparing').length+' активно</span>'+
    '<div style="flex:1"></div><button class="btn sm ghost" id="fxClearDone">'+IC('eraser')+' Убрать завершённые</button></div>'+
    list.map(t=>{
      const pct=t.totalBytes?Math.min(100,Math.round(t.bytes/t.totalBytes*100)):(t.state==='done'?100:0);
      const live=t.state==='running'||t.state==='preparing';
      const pill=t.state==='done'?'<span class="pill on"><span class="sdot"></span>готово</span>'
        :t.state==='error'?'<span class="pill err"><span class="sdot"></span>ошибка</span>'
        :t.state==='canceled'?'<span class="pill off"><span class="sdot"></span>отменено</span>'
        :'<span class="pill warn"><span class="sdot"></span>'+(t.state==='preparing'?'подготовка':pct+'%')+'</span>';
      const meta=t.state==='error'?esc(t.error||'')
        :(t.total?t.done+' из '+t.total+' файлов · ':'')+fmtBytes(t.bytes)+(t.totalBytes?' из '+fmtBytes(t.totalBytes):'')+
         (live&&t.speed?' · '+fmtBytes(Math.round(t.speed))+'/с':'')+(t.skipped?' · пропущено '+t.skipped:'')+(live&&t.current?' · '+esc(t.current):'');
      return '<div class="fx-tr" data-job="'+t.jobId+'">'+
        '<span class="fx-dir-ico">'+IC(t.direction==='download'?'download':'upload')+'</span>'+
        '<div style="min-width:0"><div style="display:flex;gap:8px;align-items:center"><b class="fx-tr-name">'+esc(t.label)+'</b>'+pill+'</div>'+
          '<div class="meta">'+meta+'</div>'+(live?'<div class="prog"><i style="width:'+pct+'%"></i></div>':'')+'</div>'+
        '<div class="row-actions" style="opacity:1">'+
          (live?'<button class="ibtn x" data-tact="cancel" title="Отменить">'+IC('x')+'</button>':'')+
          (t.state==='done'&&t.reveal?'<button class="ibtn" data-tact="show" title="Показать в папке">'+IC('folder')+'</button>':'')+
          (!live?'<button class="ibtn" data-tact="dismiss" title="Убрать из списка">'+IC('eraser')+'</button>':'')+
        '</div></div>';
    }).join('')+'</div>';
}
function renderFiles(){
  const box=$('#fxBody');if(!box)return;
  const tab=fxTab();
  const g=activeGroup();
  const owner=S.tabs.find(t=>!t.local&&t.connId===FX.connId);
  const head='<div class="ws-head"><span class="ws-head-ico">'+IC('folder')+'</span><div class="ws-head-t"><h2>Файлы · '+esc(owner?owner.name:(g&&g.name)||'SFTP')+'</h2>'+
    '<p class="sub">'+(owner?'<span class="mono">'+esc(owner.user+'@'+owner.host)+'</span> · ':'')+'SFTP поверх SSH-сессии. Перетащите файлы или папки из Проводника в список, чтобы загрузить их в текущую папку.</p></div>'+
    (owner&&groupOfTab(owner.id)?'<button class="btn ghost sm" data-do="openTab" data-arg="'+owner.id+'">'+IC('terminal')+' Терминал</button>':'')+'</div>';
  if(!tab){
    box.innerHTML=head+'<div class="table-wrap"><div class="empty"><div class="empty-ico">'+IC('plug')+'</div>'+
      '<h4>Соединение закрыто</h4><p>SFTP работает поверх SSH-сессии. Переподключитесь к серверу во вкладке терминала — файлы снова появятся здесь.</p>'+
      '<div style="display:flex;gap:9px;flex-wrap:wrap;justify-content:center">'+
      (owner&&owner.session?'<button class="btn primary" data-do="connect" data-arg="'+owner.session+'">'+IC('refresh')+' Переподключить</button>':'')+
      (g?'<button class="btn ghost" data-do="closeGroup" data-arg="'+g.id+'">'+IC('x')+' Закрыть вкладку</button>':'')+
      '</div></div></div>'+fxTransferRows();
    fxBindTransfers();
    return;
  }
  const rows=fxVisible();
  const crumbs=['/'].concat(FX.path.split('/').filter(Boolean));
  let acc='';
  const crumbHtml=crumbs.map((c,i)=>{acc=i===0?'/':fxJoin(acc,c);return '<button class="fx-crumb" data-go="'+esc(acc)+'">'+(i===0?IC('drive'):esc(c))+'</button>';}).join('<span class="fx-sep">/</span>');
  const selCount=FX.sel.size;
  box.innerHTML=head+
    '<div class="card fx-bar">'+
      '<button class="ibtn" id="fxUp" title="Вверх (Backspace)">'+IC('chev-left')+'</button>'+
      '<button class="ibtn" id="fxHome" title="Домашняя папка">'+IC('user')+'</button>'+
      '<button class="ibtn" id="fxRefresh" title="Обновить (F5)">'+IC('refresh')+'</button>'+
      '<div class="fx-crumbs" id="fxCrumbs" title="Клик — редактировать путь">'+crumbHtml+'</div>'+
      '<input class="inp mono fx-path" id="fxPath" value="'+esc(FX.path)+'" spellcheck="false" style="display:none">'+
      '<input class="inp" id="fxFilter" placeholder="Фильтр" value="'+esc(FX.filter)+'" style="flex:0 1 150px">'+
      '<button class="btn sm ghost '+(FX.showHidden?'on':'')+'" id="fxHidden" title="Скрытые файлы">'+IC(FX.showHidden?'eye':'eye-off')+' Скрытые</button>'+
      '<button class="btn sm ghost" id="fxMkdir">'+IC('plus')+' Папка</button>'+
      '<button class="btn sm ghost" id="fxUpDir">'+IC('folder')+' Загрузить папку</button>'+
      '<button class="btn sm primary" id="fxUpFiles">'+IC('upload')+' Загрузить файлы</button>'+
    '</div>'+
    (selCount?'<div class="fx-selbar">Выбрано: <b>'+selCount+'</b>'+
      '<button class="btn sm ghost" id="fxDl">'+IC('download')+' Скачать</button>'+
      (selCount===1?'<button class="btn sm ghost" id="fxRen">'+IC('pencil')+' Переименовать</button>':'')+
      '<button class="btn sm danger" id="fxDel">'+IC('x')+' Удалить</button>'+
      '<button class="btn sm ghost" id="fxUnsel">Снять выделение</button></div>':'')+
    '<div class="table-wrap fx-list" id="fxList" tabindex="0">'+
      (FX.loading?'<div class="fx-loading"><span class="spinner"></span> Загрузка…</div>':'')+
      (FX.error&&!FX.entries.length?'<div class="empty"><div class="empty-ico">'+IC('alert')+'</div><h4>Не удалось открыть папку</h4><p>'+esc(FX.error)+'</p></div>':
      '<table><thead><tr>'+
        [['name','Имя',''],['size','Размер','width:110px'],['mtime','Изменён','width:170px']].map(c=>
          '<th style="'+c[2]+';cursor:pointer" data-sort="'+c[0]+'">'+c[1]+(FX.sort.key===c[0]?(FX.sort.asc?' ↑':' ↓'):'')+'</th>').join('')+
        '<th style="width:110px">Права</th><th style="width:110px"></th></tr></thead><tbody>'+
        (FX.path!=='/'?'<tr data-up="1"><td class="fx-name">'+IC('folder','dir')+'..</td><td></td><td></td><td></td><td></td></tr>':'')+
        (rows.length?rows.map(e=>'<tr data-path="'+esc(e.path)+'" class="'+(FX.sel.has(e.path)?'sel':'')+'" draggable="false">'+
          '<td data-l="Имя"><span class="fx-name">'+IC(e.dir?'folder':(e.link?'link':'file'),e.dir?'dir':(e.link?'link':''))+'<span class="fx-n">'+esc(e.name)+'</span>'+(e.broken?'<span class="pill err" style="margin-left:6px">битая ссылка</span>':'')+'</span></td>'+
          '<td data-l="Размер" class="mono">'+(e.dir?'—':fmtBytes(e.size))+'</td>'+
          '<td data-l="Изменён" class="mono">'+(e.mtime?new Date(e.mtime).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'')+'</td>'+
          '<td data-l="Права" class="mono">'+esc(e.perms)+'</td>'+
          '<td data-l=""><div class="row-actions">'+
            '<button class="ibtn" data-act="dl" title="Скачать">'+IC('download')+'</button>'+
            '<button class="ibtn" data-act="ren" title="Переименовать (F2)">'+IC('pencil')+'</button>'+
            '<button class="ibtn x" data-act="del" title="Удалить (Delete)">'+IC('x')+'</button>'+
          '</div></td></tr>').join('')
        :'<tr><td colspan="5" class="hint" style="padding:22px;text-align:center">'+(FX.entries.length?'Все файлы скрыты фильтром':'Папка пуста — перетащите сюда файлы из Проводника')+'</td></tr>')+
      '</tbody></table>')+
    '</div>'+
    fxTransferRows();
  fxBind();
  fxBindTransfers();
}
function fxBind(){
  $('#fxUp').onclick=()=>FX.path!=='/'&&fxLoad(fxParent(FX.path));
  $('#fxHome').onclick=()=>fxLoad(null);
  $('#fxRefresh').onclick=()=>fxLoad(FX.path);
  const crumbs=$('#fxCrumbs'),pathInp=$('#fxPath');
  crumbs.scrollLeft=crumbs.scrollWidth;
  crumbs.onclick=e=>{
    const b=e.target.closest('[data-go]');
    if(b){fxLoad(b.dataset.go);return;}
    crumbs.style.display='none';pathInp.style.display='';pathInp.focus();pathInp.select();
  };
  pathInp.onkeydown=e=>{if(e.key==='Enter'){fxLoad(pathInp.value.trim()||'/');}if(e.key==='Escape')renderFiles();};
  pathInp.onblur=()=>setTimeout(()=>{if(document.activeElement!==pathInp&&pathInp.isConnected)renderFiles();},150);
  const filter=$('#fxFilter');
  filter.oninput=()=>{FX.filter=filter.value;const pos=filter.selectionStart;renderFiles();const f=$('#fxFilter');f.focus();f.setSelectionRange(pos,pos);};
  $('#fxHidden').onclick=()=>{FX.showHidden=!FX.showHidden;renderFiles();};
  $('#fxMkdir').onclick=fxMkdir;
  $('#fxUpFiles').onclick=()=>fxPickUpload(false);
  $('#fxUpDir').onclick=()=>fxPickUpload(true);
  if($('#fxDl'))$('#fxDl').onclick=()=>fxDownload([...FX.sel]);
  if($('#fxDel'))$('#fxDel').onclick=()=>fxDelete([...FX.sel]);
  if($('#fxRen'))$('#fxRen').onclick=()=>fxRename([...FX.sel][0]);
  if($('#fxUnsel'))$('#fxUnsel').onclick=()=>{FX.sel.clear();renderFiles();};
  $$('#fxList th[data-sort]').forEach(th=>{th.onclick=()=>{const k=th.dataset.sort;FX.sort=FX.sort.key===k?{key:k,asc:!FX.sort.asc}:{key:k,asc:true};renderFiles();};});
  const list=$('#fxList');
  const visible=fxVisible().map(e=>e.path);
  $$('#fxList tbody tr').forEach(tr=>{
    if(tr.dataset.up){tr.ondblclick=()=>fxLoad(fxParent(FX.path));return;}
    const p=tr.dataset.path;if(!p)return;
    const entry=FX.entries.find(e=>e.path===p);
    tr.onclick=e=>{
      const act=e.target.closest('[data-act]');
      if(act){
        if(act.dataset.act==='dl')fxDownload([p]);
        if(act.dataset.act==='ren')fxRename(p);
        if(act.dataset.act==='del')fxDelete([p]);
        return;
      }
      if(e.shiftKey&&FX.anchor&&visible.includes(FX.anchor)){
        const a=visible.indexOf(FX.anchor),b=visible.indexOf(p);
        if(!e.ctrlKey)FX.sel.clear();
        visible.slice(Math.min(a,b),Math.max(a,b)+1).forEach(x=>FX.sel.add(x));
      }else if(e.ctrlKey||e.metaKey){
        FX.sel.has(p)?FX.sel.delete(p):FX.sel.add(p);FX.anchor=p;
      }else{
        FX.sel.clear();FX.sel.add(p);FX.anchor=p;
      }
      renderFiles();$('#fxList').focus();
    };
    tr.ondblclick=e=>{
      if(e.target.closest('[data-act]'))return;
      if(entry.dir)fxLoad(p);else fxDownload([p]);
    };
  });
  list.onkeydown=e=>{
    if(e.key==='Delete'&&FX.sel.size){e.preventDefault();fxDelete([...FX.sel]);}
    else if(e.key==='F2'&&FX.sel.size===1){e.preventDefault();fxRename([...FX.sel][0]);}
    else if(e.key==='Backspace'){e.preventDefault();if(FX.path!=='/')fxLoad(fxParent(FX.path));}
    else if(e.key==='F5'){e.preventDefault();fxLoad(FX.path);}
    else if(e.key==='Enter'&&FX.sel.size===1){const en=FX.entries.find(x=>x.path===[...FX.sel][0]);if(en){e.preventDefault();en.dir?fxLoad(en.path):fxDownload([en.path]);}}
    else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();visible.forEach(x=>FX.sel.add(x));renderFiles();$('#fxList').focus();}
  };
  // Drag & drop from Explorer uploads into the current folder.
  let depth=0;
  list.ondragenter=e=>{if(![...e.dataTransfer.types].includes('Files'))return;e.preventDefault();depth++;list.classList.add('drop');};
  list.ondragover=e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';}};
  list.ondragleave=()=>{depth=Math.max(0,depth-1);if(!depth)list.classList.remove('drop');};
  list.ondrop=e=>{
    e.preventDefault();depth=0;list.classList.remove('drop');
    const paths=[...e.dataTransfer.files].map(f=>window.sftpAPI.pathForFile(f)).filter(Boolean);
    if(paths.length)fxUpload(paths);
  };
}
function fxBindTransfers(){
  const clr=$('#fxClearDone');
  if(clr)clr.onclick=()=>{Object.values(FX.transfers).forEach(t=>{if(t.state!=='running'&&t.state!=='preparing')delete FX.transfers[t.jobId];});renderFiles();};
  $$('.fx-tr [data-tact]').forEach(b=>{b.onclick=()=>{
    const id=b.closest('.fx-tr').dataset.job,t=FX.transfers[id];if(!t)return;
    if(b.dataset.tact==='cancel')window.sftpAPI.cancel(id);
    if(b.dataset.tact==='show')window.sftpAPI.showLocal(t.reveal);
    if(b.dataset.tact==='dismiss'){delete FX.transfers[id];renderFiles();}
  };});
}
function fxSessionTarget(){const t=fxTab();return t?t.name+' · '+t.user+'@'+t.host+':'+t.port:'';}
function fxPrompt(title,label,value,okText,selectStem){
  return new Promise(res=>{
    let done=false;
    const m=openModal({title:title,icon:'pencil',
      body:'<div class="field"><label class="field-label">'+IC('note')+' '+label+'</label><input class="inp mono" id="fxPromptInp" value="'+esc(value||'')+'" spellcheck="false"></div>',
      footer:'<button class="btn ghost left" data-close>'+IC('x')+' Отмена</button><button class="btn primary" id="fxPromptOk">'+IC('check')+' '+okText+'</button>',
      onMount:el=>{
        const inp=el.querySelector('#fxPromptInp');
        const fin=v=>{if(done)return;done=true;res(v);m.close();};
        el.querySelector('#fxPromptOk').onclick=()=>fin(inp.value.trim());
        inp.onkeydown=e=>{if(e.key==='Enter')fin(inp.value.trim());};
        setTimeout(()=>{inp.focus();const dot=selectStem?inp.value.lastIndexOf('.'):-1;inp.setSelectionRange(0,dot>0?dot:inp.value.length);},150);
      }});
    const close=m.close;m.close=()=>{if(!done){done=true;res(null);}close();};
  });
}
const fxBadName=n=>!n||n==='.'||n==='..'||n.includes('/');
async function fxMkdir(){
  const name=await fxPrompt('Новая папка','Имя папки','','Создать');
  if(name===null)return;
  if(fxBadName(name)){toast('Недопустимое имя папки','err','SFTP');return;}
  const target=fxJoin(FX.path,name);
  const r=await window.sftpAPI.mkdir(FX.connId,target);
  if(!r.ok){toast(r.error,'err','Папка не создана');return;}
  logEvent('info','sftp','Создана папка '+target,fxSessionTarget());
  await fxLoad(FX.path);
}
async function fxRename(p){
  const old=fxBase(p);
  const name=await fxPrompt('Переименовать','Новое имя',old,'Переименовать',true);
  if(name===null||name===old)return;
  if(fxBadName(name)){toast('Недопустимое имя','err','SFTP');return;}
  if(FX.entries.some(e=>e.name===name)){toast('«'+name+'» уже существует в этой папке','err','SFTP');return;}
  const to=fxJoin(fxParent(p),name);
  const r=await window.sftpAPI.rename(FX.connId,p,to);
  if(!r.ok){toast(r.error,'err','Не переименовано');return;}
  logEvent('info','sftp','Переименовано: '+p+' → '+to,fxSessionTarget());
  FX.sel.clear();FX.sel.add(to);
  await fxLoad(FX.path);
}
async function fxDelete(paths){
  if(!paths.length)return;
  const entries=paths.map(p=>FX.entries.find(e=>e.path===p)).filter(Boolean);
  const dirs=entries.filter(e=>e.dir).length;
  const ok=await confirmModal({title:'Удалить на сервере?',icon:'alert',ok:'Удалить',
    text:(paths.length===1?'«<b>'+esc(fxBase(paths[0]))+'</b>»':'<b>'+paths.length+'</b> объектов')+' будут удалены с сервера безвозвратно.'+
      (dirs?'<br><span style="color:var(--warn)">Папки удаляются вместе со всем содержимым.</span>':'')});
  if(!ok)return;
  const r=await window.sftpAPI.remove(FX.connId,paths);
  if(!r.ok){toast(r.error,'err','Удаление не завершено');logEvent('err','sftp','Ошибка удаления: '+r.error,fxSessionTarget());await fxLoad(FX.path);return;}
  logEvent('info','sftp','Удалено ('+r.removed+'): '+paths.join(', ').slice(0,300),fxSessionTarget());
  toast('Удалено объектов: '+r.removed,'ok','SFTP');
  FX.sel.clear();
  await fxLoad(FX.path);
}
async function fxDownload(paths){
  if(!paths.length||!FX.connId)return;
  const d=await window.sftpAPI.pickDownloadDir();
  if(!d.ok||!d.dir)return;
  const r=await window.sftpAPI.download(FX.connId,paths,d.dir);
  if(!r.ok){toast(r.error,'err','Скачивание');return;}
  FX.jobMeta[r.jobId]={target:fxSessionTarget(),where:d.dir};
}
async function fxPickUpload(folders){
  const r=await window.sftpAPI.pickUpload(folders);
  if(r.ok&&r.paths.length)fxUpload(r.paths);
}
function fxConflictChoice(names){
  return new Promise(res=>{
    let done=false;
    const m=openModal({title:'Файлы уже существуют',icon:'alert',
      body:'<p style="margin:0 0 10px;font-size:13px;color:var(--dim);line-height:1.6">В <span class="mono">'+esc(FX.path)+'</span> уже есть:</p>'+
        '<div class="fpath" style="margin:0;max-height:140px;overflow:auto">'+names.slice(0,20).map(esc).join('<br>')+(names.length>20?'<br>… и ещё '+(names.length-20):'')+'</div>'+
        '<p class="hint" style="margin:10px 0 0">Существующие папки объединяются, файлы с одинаковыми именами внутри заменяются.</p>',
      footer:'<button class="btn ghost left" data-close>'+IC('x')+' Отмена</button><button class="btn ghost" id="fxSkip">Пропустить существующие</button><button class="btn danger" id="fxReplace">'+IC('alert')+' Заменить</button>',
      onMount:el=>{
        const fin=v=>{if(done)return;done=true;res(v);m.close();};
        el.querySelector('#fxSkip').onclick=()=>fin('skip');
        el.querySelector('#fxReplace').onclick=()=>fin('replace');
      }});
    const close=m.close;m.close=()=>{if(!done){done=true;res(null);}close();};
  });
}
async function fxUpload(localPaths){
  if(!FX.connId||!FX.path){toast('Сначала откройте папку на сервере','err','Загрузка');return;}
  const existing=new Set(FX.entries.map(e=>e.name));
  const conflicts=localPaths.map(fxBase).filter(n=>existing.has(n));
  let skip=[];
  if(conflicts.length){
    const choice=await fxConflictChoice(conflicts);
    if(!choice)return;
    if(choice==='skip')skip=conflicts;
  }
  const remoteDir=FX.path,connId=FX.connId;
  const r=await window.sftpAPI.upload(connId,localPaths,remoteDir,skip);
  if(!r.ok){toast(r.error,'err','Загрузка');return;}
  FX.jobMeta[r.jobId]={target:fxSessionTarget(),remoteDir:remoteDir,connId:connId};
}
if(window.sftpAPI){
  window.sftpAPI.onTransfer(t=>{
    const prev=FX.transfers[t.jobId];
    FX.transfers[t.jobId]=t;
    const finished=(t.state==='done'||t.state==='error'||t.state==='canceled')&&(!prev||prev.state!==t.state);
    if(finished){
      const meta=FX.jobMeta[t.jobId]||{};
      const what=(t.direction==='download'?'Скачивание':'Загрузка')+' «'+t.label+'»';
      if(t.state==='done'){
        toast(what+' завершено · '+fmtBytes(t.totalBytes),'ok','SFTP');
        logEvent('ok','sftp',what+' · '+t.total+' файлов, '+fmtBytes(t.totalBytes)+(t.direction==='download'?' → '+(meta.where||''):' → '+(meta.remoteDir||'')),meta.target||'');
      }else if(t.state==='error'){
        toast(what+': '+t.error,'err','SFTP');
        logEvent('err','sftp',what+': '+t.error,meta.target||'');
      }else{
        logEvent('warn','sftp',what+' отменено',meta.target||'');
      }
      if(t.direction==='upload'&&meta.connId===FX.connId&&meta.remoteDir===FX.path&&fxShown())fxLoad(FX.path);
      delete FX.jobMeta[t.jobId];
    }
    if(fxShown()){
      const row=document.querySelector('.fx-tr[data-job="'+t.jobId+'"]');
      if(row&&!finished&&prev&&prev.state===t.state){
        // Update progress in place so a busy transfer doesn't rebuild the whole view several times a second.
        const tmp=document.createElement('div');tmp.innerHTML=fxTransferRows();
        const fresh=tmp.querySelector('.fx-tr[data-job="'+t.jobId+'"]');
        if(fresh){row.replaceWith(fresh);fxBindTransfers();}
      }else renderFiles();
    }
  });
}
// Dropping files anywhere else must not navigate the window to the file.
document.addEventListener('dragover',e=>{if(!e.target.closest||!e.target.closest('#fxList'))e.preventDefault();});
document.addEventListener('drop',e=>{if(!e.target.closest||!e.target.closest('#fxList'))e.preventDefault();});
