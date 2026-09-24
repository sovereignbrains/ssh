"use strict";
/* ---------------- PROJECTS (GitHub repositories with a working copy on a server or on this computer) ----------------
   The panel is rendered whole on every change: a list of projects, and the page of one project with
   its changes, history, issues, pull requests and Actions runs. */
const PJ={sel:null,tab:'changes',repos:null,data:{},msg:{},busy:{},home:'',sep:'\\',pickedDir:''};
const PJ_TABS=[['changes','Изменения','commit'],['history','История','clock'],['issues','Задачи','issue'],['pulls','Пулл-реквесты','pr'],['runs','Сборки','zap']];
const PJ_CODES={M:'изменён',A:'добавлен',D:'удалён',R:'переименован',C:'скопирован','??':'новый',U:'конфликт'};

const pjProject=id=>S.projects.find(p=>p.id===id)||null;
const pjToken=()=>(S.github&&S.github.token)||'';
const pjAccount=()=>S.github?{login:S.github.login,name:S.github.name,email:S.github.email}:null;
const pjSess=p=>(p&&p.place==='server'&&p.session)?S.sessions.find(s=>s.id===p.session)||null:null;
const pjConnId=p=>{const t=(p&&p.place==='server'&&p.session)?liveTabForSession(p.session):null;return t?t.connId:null;};
const pjState=id=>PJ.data[id]||(PJ.data[id]={});
const pjIsBusy=id=>!!PJ.busy[id];
function pjAgo(iso){
  const t=Date.parse(iso||'');if(!t)return '';
  const d=Math.floor((Date.now()-t)/1000);
  if(d<60)return 'только что';
  if(d<3600)return Math.floor(d/60)+' мин назад';
  if(d<86400)return Math.floor(d/3600)+' ч назад';
  if(d<2592000)return Math.floor(d/86400)+' дн назад';
  return new Date(t).toLocaleDateString('ru-RU');
}
// Paths are stored as the user sees them («~/projects/x»); SFTP and file lists need the real one.
async function pjAbsDir(p,connId){
  if(!p.dir.startsWith('~'))return p.dir;
  const h=await window.sftpAPI.home(connId);
  return h.ok?h.path.replace(/\/+$/,'')+p.dir.slice(1):p.dir;
}
function pjDirShell(dir){
  return dir.startsWith('~/')?'"$HOME"/'+"'"+dir.slice(2).replace(/'/g,"'\\''")+"'":"'"+dir.replace(/'/g,"'\\''")+"'";
}

/* ---------------- где лежит проект ---------------- */
function pjPlaceHtml(p){
  if(p.place==='local')return '<span class="pr-where">'+IC('cpu')+'<span>Этот компьютер</span></span>';
  const s=pjSess(p);
  if(!s)return '<span class="pr-where gone">'+IC('alert')+'<span>сессия удалена</span></span>';
  const o=osOf(s.os);
  return '<span class="pr-where" style="--osc:'+o.color+'">'+IC(o.icon)+'<span>'+esc(s.name)+'</span>'+
    (pjConnId(p)?'<i class="pr-live" title="Сессия подключена"></i>':'')+'</span>';
}
// Git on the server needs a live SSH channel: connect the session first if it is not up yet.
async function pjEnsureConn(p){
  if(p.place!=='server')return true;
  if(pjConnId(p))return true;
  const s=pjSess(p);
  if(!s){toast('Сессия этого проекта удалена — измените проект или удалите его','err','Проекты');return false;}
  toast('Подключаюсь к «'+s.name+'» — проект лежит на этом сервере','info','Проекты');
  await connectSession(s.id);
  go('projects');
  if(!pjConnId(p))return false;
  return true;
}
async function pjGit(p,params){
  if(!window.githubAPI)return {ok:false,error:'Модуль GitHub недоступен в этой сборке'};
  if(!(await pjEnsureConn(p)))return {ok:false,error:'Нет подключения к серверу проекта'};
  return window.githubAPI.git(Object.assign({
    place:p.place,connId:pjConnId(p),dir:p.dir,repo:p.repo,token:pjToken(),account:pjAccount()
  },params));
}
async function pjRun(id,label,fn){
  if(pjIsBusy(id))return null;
  PJ.busy[id]=label;renderProjects();
  let r;
  try{r=await fn();}finally{delete PJ.busy[id];}
  renderProjects();
  return r;
}

/* ---------------- обновление состояния ---------------- */
async function pjRefresh(id,quiet){
  const p=pjProject(id);if(!p)return;
  const st=pjState(id);
  if(p.place==='server'&&!pjConnId(p)&&quiet){st.error='';st.offline=true;renderProjects();return;}
  const r=await pjGit(p,{op:'status'});
  st.offline=false;
  if(!r.ok){st.error=r.error;st.status=null;if(!quiet)toast(r.error,'err','Проект «'+p.name+'»');renderProjects();pjBadge();return;}
  st.error='';st.status=r.status;st.at=Date.now();
  if(r.status.branch&&r.status.branch!==p.branch){p.branch=r.status.branch;persist();}
  const b=await pjGit(p,{op:'branches'});
  if(b.ok){st.branches=b.branches;st.current=b.current;}
  renderProjects();pjBadge();
}
async function pjLoadTab(id,tab){
  const p=pjProject(id);if(!p)return;
  const st=pjState(id);
  const token=pjToken();
  if(tab==='history'){
    st.logLoading=true;renderProjects();
    const r=await pjGit(p,{op:'log'});
    st.logLoading=false;
    if(r.ok)st.commits=r.commits;else st.logError=r.error;
    renderProjects();return;
  }
  const map={issues:['issues','issues'],pulls:['pulls','pulls'],runs:['runs','runs']};
  const m=map[tab];if(!m)return;
  st[m[0]+'Loading']=true;renderProjects();
  const r=await window.githubAPI[m[1]](token,p.repo);
  st[m[0]+'Loading']=false;
  if(r.ok)st[m[0]]=r[m[0]];else st[m[0]+'Error']=r.error;
  renderProjects();
}
// Opening the panel: ask git about everything reachable without opening new connections.
function pjAutoRefresh(){
  const now=Date.now();
  for(const p of S.projects){
    const st=pjState(p.id);
    if(PJ.busy[p.id]||(st.at&&now-st.at<30000))continue;
    if(p.place==='server'&&!pjConnId(p)){st.offline=true;continue;}
    pjRefresh(p.id,true);
  }
  renderProjects();
}
window.pjAutoRefresh=pjAutoRefresh;
function pjBadge(){
  const b=$('#bgProjects');if(!b)return;
  const n=S.projects.filter(p=>{const s=pjState(p.id).status;return s&&s.files.length;}).length;
  b.textContent=n;
}

/* ---------------- список ---------------- */
// noBranch: the project page already has a branch selector next to these pills.
function pjStatusPills(p,noBranch){
  const st=pjState(p.id);
  if(PJ.busy[p.id])return '<span class="pill warn"><span class="spinner"></span>'+esc(PJ.busy[p.id])+'</span>';
  if(st.offline)return '<span class="pill off"><span class="sdot"></span>сервер не подключён</span>';
  if(st.error)return '<span class="pill err" title="'+esc(st.error)+'"><span class="sdot"></span>'+esc(st.error.slice(0,40))+'</span>';
  const s=st.status;
  if(!s)return '<span class="pill off"><span class="sdot"></span>нет данных</span>';
  const out=noBranch?[]:['<span class="pill'+(s.detached?' warn':'')+'" title="Текущая ветка">'+IC('branch')+esc(s.branch||'—')+'</span>'];
  if(s.files.length)out.push('<span class="pill warn"><span class="sdot"></span>'+s.files.length+' изм.</span>');
  else out.push('<span class="pill on"><span class="sdot"></span>чисто</span>');
  if(s.ahead)out.push('<span class="pill" title="Коммитов не отправлено на GitHub">'+IC('upload')+s.ahead+'</span>');
  if(s.behind)out.push('<span class="pill" title="Коммитов на GitHub, которых нет здесь">'+IC('download')+s.behind+'</span>');
  return out.join('');
}
function pjRowHtml(p){
  const busy=pjIsBusy(p.id);
  return '<div class="prow" data-id="'+p.id+'">'+
    '<span class="p-ico">'+IC('github')+'</span>'+
    '<button class="pr-main" data-pj="open" data-arg="'+p.id+'" title="Открыть проект">'+
      '<b>'+esc(p.name)+'</b>'+
      '<span class="pr-sub">'+pjPlaceHtml(p)+'<span class="pr-path mono">'+esc(p.dir)+'</span></span>'+
    '</button>'+
    '<div class="pr-st">'+pjStatusPills(p)+'</div>'+
    '<div class="pr-acts">'+
      '<button class="ibtn" title="Терминал в папке проекта" data-pj="term" data-arg="'+p.id+'"'+(busy?' disabled':'')+'>'+IC('terminal')+'</button>'+
      '<button class="ibtn" title="'+(p.place==='local'?'Открыть папку в Проводнике':'Файлы проекта (SFTP)')+'" data-pj="files" data-arg="'+p.id+'"'+(busy?' disabled':'')+'>'+IC('folder')+'</button>'+
      '<button class="ibtn" title="Claude по этому проекту" data-pj="claude" data-arg="'+p.id+'"'+(busy?' disabled':'')+'>'+IC('claude')+'</button>'+
      '<button class="ibtn ok" title="Обновить с GitHub (pull)" data-pj="pull" data-arg="'+p.id+'"'+(busy?' disabled':'')+'>'+IC('download')+'</button>'+
      '<button class="ibtn x" title="Убрать из списка" data-pj="remove" data-arg="'+p.id+'"'+(busy?' disabled':'')+'>'+IC('x')+'</button>'+
    '</div>'+
  '</div>';
}
function pjHeadHtml(){
  const acc=S.github&&S.github.login;
  return '<div class="view-head">'+
    '<div><h2>'+IC('github')+' Проекты <span class="count-pill" id="cntProjects">'+S.projects.length+'</span></h2>'+
    '<p class="sub">Репозитории GitHub с рабочей копией на сервере или на этом компьютере. Здесь же — изменения, задачи, пулл-реквесты и сборки.</p></div>'+
    '<div class="spacer"></div>'+
    (acc?'<button class="pj-acc" data-pj="account" title="Аккаунт GitHub — нажмите, чтобы сменить токен">'+IC('github')+'<span>'+esc(S.github.login)+'</span></button>':'')+
    (acc?'<button class="btn ghost" data-pj="refreshAll" title="Опросить все проекты"><svg class="ic"><use href="#ic-refresh"/></svg><span class="lbl">Обновить</span></button>':'')+
    (acc?'<button class="btn primary" data-pj="add"><svg class="ic"><use href="#ic-plus"/></svg><span class="lbl">Проект</span></button>':'')+
  '</div>';
}
function pjListHtml(){
  if(!pjToken()){
    return pjHeadHtml()+'<div class="card set-panel"><div class="empty">'+
      '<div class="empty-ico">'+IC('github')+'</div>'+
      '<h4>Подключите GitHub</h4>'+
      '<p>Вставьте personal access token — приложение покажет ваши репозитории, склонирует их на сервер или сюда и дальше всё будет делаться из этой панели. Токен шифруется в сейфе вместе с сессиями и ключами.</p>'+
      '<button class="btn primary" data-pj="account">'+IC('github')+' Подключить GitHub</button>'+
    '</div></div>';
  }
  if(!S.projects.length){
    return pjHeadHtml()+'<div class="card set-panel"><div class="empty">'+
      '<div class="empty-ico">'+IC('github')+'</div>'+
      '<h4>Проектов пока нет</h4>'+
      '<p>«Проект» — репозиторий GitHub плюс папка с его рабочей копией. Нажмите «Проект», выберите репозиторий и место: сервер из ваших сессий или этот компьютер.</p>'+
      '<button class="btn primary" data-pj="add">'+IC('plus')+' Добавить проект</button>'+
    '</div></div>';
  }
  return pjHeadHtml()+'<div class="card set-panel plist">'+S.projects.map(pjRowHtml).join('')+'</div>';
}

/* ---------------- страница проекта ---------------- */
function pjFileRow(p,f){
  const letter=f.code==='??'?'+':f.code[0];
  const kind=PJ_CODES[f.code]||PJ_CODES[f.code[0]]||f.code;
  return '<div class="pf-row" data-pj="diff" data-arg="'+p.id+'" data-file="'+esc(f.name)+'">'+
    '<span class="pf-code '+(f.code==='??'?'new':f.code[0]==='D'?'del':'mod')+'" title="'+esc(kind)+'">'+esc(letter)+'</span>'+
    '<span class="pf-name mono">'+esc(f.name)+'</span>'+
    '<span class="pf-kind">'+esc(kind)+'</span>'+
    '<button class="ibtn x" title="Отменить изменения в файле" data-pj="discard" data-arg="'+p.id+'" data-file="'+esc(f.name)+'">'+IC('refresh')+'</button>'+
  '</div>';
}
function pjChangesHtml(p){
  const st=pjState(p.id),s=st.status;
  if(st.offline)return '<div class="card set-panel"><div class="empty"><div class="empty-ico">'+IC('plug')+'</div><h4>Сервер не подключён</h4>'+
    '<p>Проект лежит на «'+esc((pjSess(p)||{}).name||'')+'». Нажмите «Обновить» — сессия подключится сама.</p>'+
    '<button class="btn primary" data-pj="refresh" data-arg="'+p.id+'">'+IC('refresh')+' Обновить</button></div></div>';
  if(st.error)return '<div class="card set-panel"><div class="empty"><div class="empty-ico">'+IC('alert')+'</div><h4>Не удалось прочитать проект</h4><p>'+esc(st.error)+'</p>'+
    '<button class="btn ghost" data-pj="refresh" data-arg="'+p.id+'">'+IC('refresh')+' Ещё раз</button></div></div>';
  if(!s)return '<div class="card set-panel"><div class="empty"><div class="empty-ico">'+IC('commit')+'</div><h4>Состояние неизвестно</h4><p>Нажмите «Обновить», чтобы спросить git.</p></div></div>';
  const msg=PJ.msg[p.id]||'';
  const files=s.files.length
    ?'<div class="card set-panel pflist">'+s.files.map(f=>pjFileRow(p,f)).join('')+'</div>'
    :'<div class="card set-panel"><div class="empty"><div class="empty-ico">'+IC('check-c')+'</div><h4>Изменений нет</h4>'+
      '<p>Рабочая копия совпадает с последним коммитом'+(s.ahead?', но '+s.ahead+' коммит(ов) ещё не на GitHub':'')+'.</p></div></div>';
  const commit=s.files.length?'<div class="card set-panel pad pj-commit">'+
      '<label class="field-label" for="pjMsg">Что изменилось</label>'+
      '<textarea class="inp" id="pjMsg" rows="2" placeholder="Например: поправил вход в админку">'+esc(msg)+'</textarea>'+
      '<div class="pj-commit-foot">'+
        '<label class="chk"><input type="checkbox" id="pjPushAfter" checked><span>и сразу отправить на GitHub</span></label>'+
        '<div class="spacer"></div>'+
        '<button class="btn primary" data-pj="commit" data-arg="'+p.id+'">'+IC('commit')+' Закоммитить</button>'+
      '</div></div>':'';
  return files+commit;
}
function pjHistoryHtml(p){
  const st=pjState(p.id);
  if(st.logLoading)return '<div class="card set-panel pad"><span class="spinner"></span> Читаю историю…</div>';
  if(st.logError)return '<div class="card set-panel pad"><p class="hint" style="margin:0">'+esc(st.logError)+'</p></div>';
  if(!st.commits||!st.commits.length)return '<div class="card set-panel"><div class="empty"><div class="empty-ico">'+IC('clock')+'</div><h4>Коммитов нет</h4><p>Похоже, в этой ветке ещё ничего не зафиксировано.</p></div></div>';
  return '<div class="card set-panel pjlist">'+st.commits.map(c=>
    '<div class="pj-item">'+
      '<span class="pj-ico">'+IC('commit')+'</span>'+
      '<div class="pj-item-main"><b>'+esc(c.subject)+'</b><small>'+esc(c.author)+' · '+esc(c.when)+'</small></div>'+
      '<span class="mono pj-hash">'+esc(c.hash)+'</span>'+
    '</div>').join('')+'</div>';
}
function pjRemoteListHtml(p,kind){
  const st=pjState(p.id);
  if(st[kind+'Loading'])return '<div class="card set-panel pad"><span class="spinner"></span> Спрашиваю GitHub…</div>';
  if(st[kind+'Error'])return '<div class="card set-panel pad"><p class="hint" style="margin:0">'+esc(st[kind+'Error'])+'</p></div>';
  const list=st[kind]||[];
  const empty={issues:['issue','Открытых задач нет','Всё закрыто — или задачи ещё не заводили.'],
    pulls:['pr','Пулл-реквестов нет','Ни одного открытого запроса на слияние.'],
    runs:['zap','Сборок нет','GitHub Actions в этом репозитории ещё не запускались.']}[kind];
  if(!list.length)return '<div class="card set-panel"><div class="empty"><div class="empty-ico">'+IC(empty[0])+'</div><h4>'+empty[1]+'</h4><p>'+empty[2]+'</p>'+
    (kind==='issues'?'<button class="btn primary" data-pj="newIssue" data-arg="'+p.id+'">'+IC('plus')+' Новая задача</button>':'')+'</div></div>';
  const rows=list.map(x=>{
    if(kind==='runs'){
      const good=x.conclusion==='success',bad=x.conclusion==='failure'||x.conclusion==='timed_out',run=x.status!=='completed';
      return '<div class="pj-item" data-pj="link" data-url="'+esc(x.url)+'">'+
        '<span class="pj-ico '+(run?'warn':good?'ok':bad?'err':'')+'">'+IC(run?'refresh':good?'check-c':bad?'xcircle':'zap')+'</span>'+
        '<div class="pj-item-main"><b>'+esc(x.title||x.name)+'</b><small>'+esc(x.name)+' · '+IC('branch')+' '+esc(x.branch||'')+' · '+esc(pjAgo(x.started))+'</small></div>'+
        '<span class="pill '+(run?'warn':good?'on':bad?'err':'off')+'"><span class="sdot"></span>'+esc(run?'идёт':x.conclusion||x.status)+'</span>'+
        '<span class="pj-go">'+IC('external')+'</span></div>';
    }
    const labels=(x.labels||[]).slice(0,3).map(l=>'<span class="pj-lbl" style="--lc:#'+esc(l.color||'888')+'">'+esc(l.name)+'</span>').join('');
    return '<div class="pj-item" data-pj="link" data-url="'+esc(x.url)+'">'+
      '<span class="pj-ico '+(kind==='pulls'?'accent':'ok')+'">'+IC(kind==='pulls'?'pr':'issue')+'</span>'+
      '<div class="pj-item-main"><b>#'+x.number+' '+esc(x.title)+'</b><small>'+esc(x.author)+' · '+esc(pjAgo(x.updated))+
        (kind==='pulls'?' · '+esc(x.head||'')+' → '+esc(x.base||''):'')+(x.draft?' · черновик':'')+'</small>'+(labels?'<span class="pj-lbls">'+labels+'</span>':'')+'</div>'+
      (kind==='issues'?'<button class="ibtn" title="Обсудить с Claude" data-pj="issueClaude" data-arg="'+p.id+'" data-num="'+x.number+'">'+IC('claude')+'</button>':'')+
      '<span class="pj-go">'+IC('external')+'</span></div>';
  }).join('');
  return (kind==='issues'?'<div class="pj-tools"><button class="btn ghost sm" data-pj="newIssue" data-arg="'+p.id+'">'+IC('plus')+' Новая задача</button></div>':'')+
    '<div class="card set-panel pjlist">'+rows+'</div>';
}
function pjDetailHtml(p){
  const st=pjState(p.id),s=st.status,busy=PJ.busy[p.id];
  const branches=st.branches&&st.branches.length?st.branches:(s&&s.branch?[s.branch]:[]);
  const cur=(s&&s.branch)||st.current||p.branch||'';
  return '<div class="view-head pj-head">'+
      '<button class="ibtn" data-pj="back" title="Ко всем проектам">'+IC('chev-left')+'</button>'+
      '<div><h2>'+IC('github')+' '+esc(p.name)+'</h2>'+
      '<p class="sub"><button class="pj-repo" data-pj="link" data-url="'+esc(p.url||('https://github.com/'+p.repo))+'">'+esc(p.repo)+' '+IC('external')+'</button> · '+
        pjPlaceHtml(p)+' · <span class="mono">'+esc(p.dir)+'</span></p></div>'+
      '<div class="spacer"></div>'+
      '<button class="btn ghost" data-pj="term" data-arg="'+p.id+'" title="Терминал в папке проекта">'+IC('terminal')+'<span class="lbl">Терминал</span></button>'+
      '<button class="btn ghost" data-pj="files" data-arg="'+p.id+'" title="'+(p.place==='local'?'Открыть папку':'Файлы проекта')+'">'+IC('folder')+'<span class="lbl">Файлы</span></button>'+
      '<button class="btn ghost" data-pj="claude" data-arg="'+p.id+'" title="Claude по этому проекту">'+IC('claude')+'<span class="lbl">Claude</span></button>'+
    '</div>'+
    '<div class="card set-panel pad pj-bar">'+
      '<span class="pj-branch">'+IC('branch')+
        (branches.length>1
          ?'<select class="sel sm" id="pjBranch">'+branches.map(b=>'<option'+(b===cur?' selected':'')+'>'+esc(b)+'</option>').join('')+'</select>'
          :'<b class="mono">'+esc(cur||'—')+'</b>')+
      '</span>'+
      '<div class="pj-bar-st">'+pjStatusPills(p,true)+'</div>'+
      '<div class="spacer"></div>'+
      '<button class="btn ghost sm" data-pj="refresh" data-arg="'+p.id+'"'+(busy?' disabled':'')+'>'+IC('refresh')+' Обновить состояние</button>'+
      '<button class="btn ghost sm" data-pj="pull" data-arg="'+p.id+'"'+(busy?' disabled':'')+'>'+IC('download')+' Забрать с GitHub</button>'+
      '<button class="btn '+(s&&s.ahead?'primary':'ghost')+' sm" data-pj="push" data-arg="'+p.id+'"'+(busy?' disabled':'')+'>'+IC('upload')+' Отправить'+(s&&s.ahead?' ('+s.ahead+')':'')+'</button>'+
    '</div>'+
    '<div class="seg pj-tabs" id="pjTabs">'+PJ_TABS.map(t=>'<button class="seg-item'+(PJ.tab===t[0]?' on':'')+'" data-pj="tab" data-arg="'+t[0]+'">'+IC(t[2])+' '+t[1]+'</button>').join('')+'</div>'+
    '<div id="pjTabBox">'+(
      PJ.tab==='changes'?pjChangesHtml(p):
      PJ.tab==='history'?pjHistoryHtml(p):
      pjRemoteListHtml(p,PJ.tab)
    )+'</div>';
}

function renderProjects(){
  const page=$('#pjPage');if(!page)return;
  if(PJ.sel&&!pjProject(PJ.sel))PJ.sel=null;
  const p=PJ.sel?pjProject(PJ.sel):null;
  const msgEl=$('#pjMsg');
  if(msgEl&&p)PJ.msg[p.id]=msgEl.value;
  const scroll=$('#content')?$('#content').scrollTop:0;
  page.innerHTML=p?pjDetailHtml(p):pjListHtml();
  const br=$('#pjBranch');
  if(br)br.onchange=()=>pjCheckout(p.id,br.value);
  const ta=$('#pjMsg');
  if(ta)ta.oninput=()=>{PJ.msg[p.id]=ta.value;};
  if($('#content'))$('#content').scrollTop=scroll;
  pjBadge();
}
window.renderProjects=renderProjects;

/* ---------------- действия ---------------- */
function pjOpen(id){
  PJ.sel=id;PJ.tab='changes';
  go('projects');
  renderProjects();
  const st=pjState(id);
  if(!st.status&&!st.error)pjRefresh(id,true);
}
window.pjOpen=pjOpen;
async function pjCheckout(id,branch){
  const p=pjProject(id);if(!p||!branch)return;
  const r=await pjRun(id,'переключаю ветку',()=>pjGit(p,{op:'checkout',branch:branch}));
  if(!r)return;
  if(!r.ok){toast(r.error,'err','Ветка не переключена');renderProjects();return;}
  toast('Ветка «'+branch+'»','ok','Проект «'+p.name+'»');
  logEvent('ok','project','Ветка «'+branch+'» в проекте «'+p.name+'»',p.repo);
  PJ.data[id].commits=null;
  await pjRefresh(id,true);
}
async function pjPull(id){
  const p=pjProject(id);if(!p)return;
  const r=await pjRun(id,'забираю с GitHub',()=>pjGit(p,{op:'pull'}));
  if(!r)return;
  if(!r.ok){toast(r.error,'err','Не обновлено: «'+p.name+'»');logEvent('err','project','Pull не удался: '+r.error,p.repo);renderProjects();return;}
  const fresh=/Already up to date|Уже обновлено/i.test(r.out||'');
  toast(fresh?'Уже актуально':'Обновлено с GitHub','ok','Проект «'+p.name+'»');
  logEvent('ok','project','Обновлён с GitHub'+(fresh?' (без изменений)':''),p.repo);
  PJ.data[id].commits=null;
  await pjRefresh(id,true);
}
async function pjPush(id,chained){
  const p=pjProject(id);if(!p)return false;
  const st=pjState(id).status;
  const run=()=>pjGit(p,{op:'push',branch:st&&st.branch});
  const r=chained?await run():await pjRun(id,'отправляю на GitHub',run);
  if(!r)return false;
  if(!r.ok){toast(r.error,'err','Не отправлено: «'+p.name+'»');logEvent('err','project','Push не удался: '+r.error,p.repo);renderProjects();return false;}
  toast('Отправлено на GitHub','ok','Проект «'+p.name+'»');
  logEvent('ok','project','Коммиты отправлены на GitHub',p.repo);
  if(!chained)await pjRefresh(id,true);
  return true;
}
async function pjCommit(id){
  const p=pjProject(id);if(!p)return;
  const ta=$('#pjMsg');
  const message=((ta&&ta.value)||PJ.msg[id]||'').trim();
  if(!message){
    if(ta){ta.classList.add('err');setTimeout(()=>ta.classList.remove('err'),450);ta.focus();}
    toast('Напишите, что изменилось — это сообщение коммита','err','Проекты');return;
  }
  const alsoPush=!$('#pjPushAfter')||$('#pjPushAfter').checked;
  await pjRun(id,'коммичу',async()=>{
    const r=await pjGit(p,{op:'commit',message:message});
    if(!r.ok){toast(r.error,'err','Коммит не создан');logEvent('err','project','Коммит не создан: '+r.error,p.repo);return r;}
    PJ.msg[id]='';
    toast('Коммит создан','ok','Проект «'+p.name+'»');
    logEvent('ok','project','Коммит: '+message.split('\n')[0].slice(0,120),p.repo);
    if(alsoPush)await pjPush(id,true);
    return r;
  });
  await pjRefresh(id,true);
}
async function pjDiff(id,file){
  const p=pjProject(id);if(!p)return;
  const m=openModal({title:'Изменения в файле',sub:esc(file),icon:'commit',wide:true,
    body:'<div class="pj-diff"><span class="spinner"></span> Смотрю, что изменилось…</div>',
    footer:'<button class="btn ghost" data-close>'+IC('x')+' Закрыть</button>'});
  const r=await pjGit(p,{op:'filediff',file:file});
  const box=m.el.querySelector('.pj-diff');
  if(!box)return;
  if(!r.ok){box.innerHTML='<p class="hint" style="margin:0">'+esc(r.error)+'</p>';return;}
  if(!r.out){box.innerHTML='<p class="hint" style="margin:0">Новый файл — в репозитории его ещё нет, поэтому сравнивать не с чем.</p>';return;}
  box.innerHTML='<pre>'+r.out.split('\n').map(line=>{
    const cls=/^\+\+\+|^---|^diff |^index /.test(line)?'meta':/^@@/.test(line)?'hunk':line.startsWith('+')?'add':line.startsWith('-')?'del':'';
    return '<span class="'+cls+'">'+esc(line)+'</span>';
  }).join('')+'</pre>';
}
async function pjDiscard(id,file){
  const p=pjProject(id);if(!p)return;
  const ok=await confirmModal({title:'Отменить изменения?',icon:'refresh',
    text:'Файл <span class="mono">'+esc(file)+'</span> вернётся к состоянию последнего коммита. Отменить это будет нельзя.',ok:'Отменить изменения'});
  if(!ok)return;
  const r=await pjRun(id,'откатываю файл',()=>pjGit(p,{op:'discard',file:file}));
  if(!r)return;
  if(!r.ok){toast(r.error,'err','Не откатилось');return;}
  toast('Изменения в «'+file+'» отменены','ok','Проект «'+p.name+'»');
  await pjRefresh(id,true);
}
async function pjTerm(id){
  const p=pjProject(id);if(!p)return;
  if(p.place==='local'){
    if(!window.localAPI){toast('Локальный shell недоступен в этой сборке','err','Проекты');return;}
    await localShell(S.shell,{dir:p.dir,name:p.name});
    return;
  }
  if(!(await pjEnsureConn(p)))return;
  const tab=liveTabForSession(p.session);
  if(!tab)return;
  openTab(tab.id);
  window.sshAPI.write(tab.connId,'cd '+pjDirShell(p.dir)+'\n');
}
async function pjFiles(id){
  const p=pjProject(id);if(!p)return;
  if(p.place==='local'){
    const r=await window.githubAPI.reveal(p.dir);
    if(!r.ok)toast(r.error,'err','Проекты');
    return;
  }
  if(!(await pjEnsureConn(p)))return;
  const connId=pjConnId(p);
  const dir=await pjAbsDir(p,connId);
  FX.paths[connId]=dir;
  openFiles(connId);
  if(FX.connId===connId&&FX.path!==dir)fxLoad(dir);
}
async function pjClaude(id,extra){
  const p=pjProject(id);if(!p)return;
  // One chat on this computer: a server project is reached by naming its user@host (the tools' `on`).
  let where='на этом компьютере';
  if(p.place!=='local'){
    if(!(await pjEnsureConn(p)))return;
    const t=fxLiveTabs().find(x=>x.connId===pjConnId(p));
    where=t?'на сервере '+t.user+'@'+t.host:'на сервере';
  }
  const intro='Проект «'+p.name+'» (репозиторий '+p.repo+') лежит '+where+' в папке '+p.dir+'. Работай в ней.\n';
  CL.drafts[CL_LOCAL.connId]=intro+(extra||'');
  openClaude();
}
async function pjIssueClaude(id,number){
  const p=pjProject(id);if(!p)return;
  const issue=(pjState(id).issues||[]).find(x=>x.number===+number);
  if(!issue)return;
  await pjClaude(id,'Задача #'+issue.number+': '+issue.title+'\n'+(issue.body?issue.body.slice(0,1500)+'\n':'')+'Разберись и предложи, что сделать.');
}
async function pjRemove(id){
  const p=pjProject(id);if(!p)return;
  const ok=await confirmModal({title:'Убрать проект из списка?',icon:'github',
    text:'«<b>'+esc(p.name)+'</b>» исчезнет из панели. Папка <span class="mono">'+esc(p.dir)+'</span> и репозиторий на GitHub останутся на месте.',ok:'Убрать'});
  if(!ok)return;
  S.projects=S.projects.filter(x=>x.id!==id);
  delete PJ.data[id];delete PJ.msg[id];
  if(PJ.sel===id)PJ.sel=null;
  persist();renderProjects();
  toast('Проект «'+p.name+'» убран из списка','ok','Проекты');
}
async function pjRefreshAll(){
  for(const p of S.projects){
    if(p.place==='server'&&!pjConnId(p)){pjState(p.id).offline=true;continue;}
    await pjRefresh(p.id,true);
  }
  renderProjects();
}

/* ---------------- токен GitHub ---------------- */
function pjAccountModal(){
  const cur=S.github||{};
  const m=openModal({title:cur.login?'Аккаунт GitHub':'Подключение GitHub',icon:'github',
    sub:cur.login?'Токен хранится в зашифрованном сейфе':'Personal access token — из настроек GitHub',
    body:'<div class="field"><label class="field-label" for="pjTok">Personal access token</label>'+
      pwInput('pjTok','ghp_… или github_pat_…',cur.token||'')+
      '<p class="hint">Создайте токен на <button class="lnk" data-pj="link" data-url="https://github.com/settings/tokens">github.com/settings/tokens</button>. '+
      'Classic — отметьте <b>repo</b> и <b>workflow</b>; fine-grained — доступ к нужным репозиториям и права Contents, Issues, Pull requests, Actions (чтение), Metadata.</p>'+
      '<p class="hint">Токен уедет вместе с сейфом на Google Диск в зашифрованном виде — на другом компьютере вводить его снова не нужно.</p></div>'+
      (cur.login?'<div class="pj-cur">'+IC('check-c')+' Сейчас подключён <b>'+esc(cur.login)+'</b></div>':''),
    footer:(cur.login?'<button class="btn danger" data-pj-out>'+IC('x')+' Отключить GitHub</button>':'')+
      '<div class="spacer"></div><button class="btn ghost" data-close>Отмена</button><button class="btn primary" data-pj-save>'+IC('check')+' Проверить и сохранить</button>'});
  const out=m.el.querySelector('[data-pj-out]');
  if(out)out.onclick=async()=>{
    m.close();
    const ok=await confirmModal({title:'Отключить GitHub?',icon:'github',text:'Токен будет стёрт из сейфа. Проекты останутся в списке, но перестанут работать, пока не подключите GitHub снова.',ok:'Отключить'});
    if(!ok)return;
    S.github=null;persist();renderProjects();
    toast('GitHub отключён','ok','Проекты');
  };
  const save=m.el.querySelector('[data-pj-save]');
  save.onclick=async()=>{
    const token=m.el.querySelector('#pjTok').value.trim();
    if(!token){toast('Вставьте токен','err','GitHub');return;}
    const old=save.innerHTML;save.innerHTML='<span class="spinner dark"></span> Проверяю…';save.disabled=true;
    const r=await window.githubAPI.user(token);
    save.innerHTML=old;save.disabled=false;
    if(!r.ok){toast(r.error,'err','GitHub');return;}
    S.github={token:token,login:r.user.login,name:r.user.name,email:r.user.email};
    PJ.repos=null;
    persist();renderProjects();
    m.close();
    toast('GitHub подключён: '+r.user.login,'ok','Проекты');
    logEvent('ok','project','Подключён аккаунт GitHub '+r.user.login,'');
  };
}

/* ---------------- добавление проекта ---------------- */
function pjDefaultDir(place,name){
  if(place==='local')return (PJ.pickedDir||(PJ.home?PJ.home+PJ.sep+'projects':'projects'))+PJ.sep+(name||'repo');
  return '~/projects/'+(name||'repo');
}
function pjRepoListHtml(filter){
  const list=(PJ.repos||[]).filter(r=>!filter||r.repo.toLowerCase().includes(filter)||(r.description||'').toLowerCase().includes(filter));
  return list.slice(0,60).map(r=>'<button class="pj-repo-row" data-repo="'+esc(r.repo)+'">'+
    '<span class="pj-ico">'+IC(r.private?'lock':'github')+'</span>'+
    '<span class="pj-item-main"><b>'+esc(r.repo)+'</b><small>'+esc(r.description||'без описания')+'</small></span>'+
    (r.language?'<span class="pill off">'+esc(r.language)+'</span>':'')+
    '<span class="pj-when">'+esc(pjAgo(r.pushed))+'</span></button>').join('');
}
async function pjAddModal(){
  if(!PJ.home&&window.githubAPI){const h=await window.githubAPI.home();PJ.home=h.home;PJ.sep=h.sep;}
  const sessions=S.sessions;
  const state={repo:null,place:sessions.length?'server':'local',session:sessions.length?(focusedSshTab()?focusedSshTab().session:sessions[0].id):'',dir:''};
  const m=openModal({title:'Новый проект',icon:'github',sub:'Репозиторий GitHub и место для его рабочей копии',wide:true,
    body:'<div class="pj-add">'+
      '<div class="field"><label class="field-label">Репозиторий</label>'+
        '<div class="pj-search"><svg class="ic"><use href="#ic-search"/></svg><input class="inp" id="pjSearch" placeholder="Поиск по вашим репозиториям…" autocomplete="off"></div>'+
        '<div class="pj-repos" id="pjRepos"><div class="pad"><span class="spinner"></span> Спрашиваю GitHub…</div></div>'+
      '</div>'+
      '<div class="field"><label class="field-label">Где будет рабочая копия</label>'+
        '<div class="seg" id="pjPlace">'+
          '<button class="seg-item'+(state.place==='server'?' on':'')+'" data-place="server">'+IC('server')+' Сервер</button>'+
          '<button class="seg-item'+(state.place==='local'?' on':'')+'" data-place="local">'+IC('cpu')+' Этот компьютер</button>'+
        '</div></div>'+
      '<div class="field" id="pjSessField"><label class="field-label" for="pjSess">Сессия</label>'+
        '<select class="sel" id="pjSess">'+(sessions.length?sessions.map(s=>'<option value="'+s.id+'"'+(s.id===state.session?' selected':'')+'>'+esc(s.name)+' · '+esc(s.host)+(liveTabForSession(s.id)?' · подключена':'')+'</option>').join(''):'<option value="">— нет сессий —</option>')+'</select></div>'+
      '<div class="field"><label class="field-label" for="pjDir">Папка проекта</label>'+
        '<div class="pj-dir"><input class="inp mono" id="pjDir" placeholder="~/projects/repo" autocomplete="off">'+
        '<button class="btn ghost" id="pjPick" title="Выбрать папку на этом компьютере">'+IC('folder')+'</button></div>'+
        '<p class="hint" id="pjDirHint">Если папки нет — репозиторий склонируется в неё. Если там уже лежит этот репозиторий, проект просто привяжется к ней.</p></div>'+
      '<div class="pj-add-log" id="pjAddLog" hidden></div>'+
    '</div>',
    footer:'<button class="btn ghost" data-close>Отмена</button><button class="btn primary" id="pjAddGo">'+IC('download')+' Добавить проект</button>'});

  const reposBox=m.el.querySelector('#pjRepos'),dirEl=m.el.querySelector('#pjDir'),hint=m.el.querySelector('#pjDirHint');
  const sessField=m.el.querySelector('#pjSessField'),pick=m.el.querySelector('#pjPick');
  const syncPlace=()=>{
    sessField.style.display=state.place==='server'?'':'none';
    pick.style.display=state.place==='local'?'':'none';
    dirEl.placeholder=state.place==='local'?pjDefaultDir('local','repo'):'~/projects/repo';
    if(state.repo)dirEl.value=pjDefaultDir(state.place,state.repo.name);
    hint.textContent=state.place==='local'
      ?'Папка на этом компьютере. Нужен установленный git.'
      :'Путь на сервере; «~» — домашняя папка пользователя сессии. Нужен установленный на сервере git.';
  };
  const drawRepos=()=>{
    const f=(m.el.querySelector('#pjSearch').value||'').trim().toLowerCase();
    reposBox.innerHTML=PJ.repos&&PJ.repos.length?pjRepoListHtml(f):'<div class="pad"><p class="hint" style="margin:0">Репозитории не найдены.</p></div>';
    reposBox.querySelectorAll('.pj-repo-row').forEach(b=>{b.onclick=()=>{
      state.repo=PJ.repos.find(r=>r.repo===b.dataset.repo)||null;
      reposBox.querySelectorAll('.pj-repo-row').forEach(x=>x.classList.toggle('on',x===b));
      if(state.repo)dirEl.value=pjDefaultDir(state.place,state.repo.name);
    };});
  };
  m.el.querySelector('#pjSearch').oninput=drawRepos;
  m.el.querySelectorAll('#pjPlace .seg-item').forEach(b=>{b.onclick=()=>{
    state.place=b.dataset.place;
    m.el.querySelectorAll('#pjPlace .seg-item').forEach(x=>x.classList.toggle('on',x===b));
    syncPlace();
  };});
  m.el.querySelector('#pjSess').onchange=e=>{state.session=e.target.value;};
  pick.onclick=async()=>{
    const d=await window.githubAPI.pickDir(PJ.pickedDir||PJ.home);
    if(!d)return;
    PJ.pickedDir=d;
    dirEl.value=d+(state.repo?PJ.sep+state.repo.name:'');
  };
  syncPlace();

  if(!PJ.repos){
    const r=await window.githubAPI.repos(pjToken());
    if(!r.ok){reposBox.innerHTML='<div class="pad"><p class="hint" style="margin:0">'+esc(r.error)+'</p></div>';}
    else PJ.repos=r.repos;
  }
  if(PJ.repos)drawRepos();

  m.el.querySelector('#pjAddGo').onclick=async()=>{
    const btn=m.el.querySelector('#pjAddGo'),log=m.el.querySelector('#pjAddLog');
    const dir=dirEl.value.trim();
    if(!state.repo){toast('Выберите репозиторий','err','Проекты');return;}
    if(state.place==='server'&&!state.session){toast('Нет сессии — сначала создайте подключение к серверу','err','Проекты');return;}
    if(!dir){dirEl.classList.add('err');setTimeout(()=>dirEl.classList.remove('err'),450);toast('Укажите папку проекта','err','Проекты');return;}
    const p={id:uid('pj'),name:state.repo.name,repo:state.repo.repo,url:state.repo.url,branch:state.repo.branch||'',
      place:state.place,session:state.place==='server'?state.session:'',dir:dir,addedAt:Date.now()};
    if(S.projects.some(x=>x.place===p.place&&x.session===p.session&&x.dir===p.dir)){toast('Проект с этой папкой уже есть в списке','warn','Проекты');return;}
    const say=t=>{log.hidden=false;log.innerHTML='<span class="spinner"></span> '+esc(t);};
    const stop=t=>{log.hidden=false;log.innerHTML='<span class="pill err"><span class="sdot"></span>'+esc(t)+'</span>';btn.disabled=false;btn.innerHTML=IC('download')+' Добавить проект';};
    btn.disabled=true;btn.innerHTML='<span class="spinner dark"></span> Готовлю…';
    if(p.place==='server'&&!pjConnId(p)){
      say('Подключаюсь к серверу…');
      if(!(await pjEnsureConn(p))){stop('Не удалось подключиться к серверу');return;}
    }
    say('Смотрю, что уже лежит в папке…');
    const probe=await pjGit(p,{op:'probe'});
    if(!probe.ok){stop(probe.error);return;}
    if(probe.repo){
      const remote=(probe.remote||'').toLowerCase();
      if(remote&&!remote.includes(p.repo.toLowerCase())){stop('В этой папке уже другой репозиторий: '+probe.remote);return;}
      say('Папка уже содержит этот репозиторий — привязываю');
    }else if(probe.exists&&!probe.empty){
      stop('Папка занята и это не репозиторий — выберите другую');return;
    }else{
      say('Клонирую '+p.repo+' — это может занять минуту…');
      const r=await pjGit(p,{op:'clone'});
      if(!r.ok){stop(r.error);return;}
    }
    S.projects.push(p);
    persist();
    m.close();
    toast('Проект «'+p.name+'» добавлен','ok','Проекты');
    logEvent('ok','project','Проект «'+p.name+'» добавлен ('+(p.place==='local'?'этот компьютер':'сервер')+': '+p.dir+')',p.repo);
    pjOpen(p.id);
  };
}
async function pjNewIssue(id){
  const p=pjProject(id);if(!p)return;
  const m=openModal({title:'Новая задача',icon:'issue',sub:esc(p.repo),
    body:'<div class="field"><label class="field-label" for="pjIssueT">Заголовок</label><input class="inp" id="pjIssueT" placeholder="Что не так или что сделать" autocomplete="off"></div>'+
      '<div class="field"><label class="field-label" for="pjIssueB">Описание</label><textarea class="inp" id="pjIssueB" rows="5" placeholder="Подробности — можно оставить пустым"></textarea></div>',
    footer:'<button class="btn ghost" data-close>Отмена</button><button class="btn primary" id="pjIssueGo">'+IC('plus')+' Создать</button>'});
  m.el.querySelector('#pjIssueGo').onclick=async()=>{
    const btn=m.el.querySelector('#pjIssueGo');
    const title=m.el.querySelector('#pjIssueT').value.trim();
    if(!title){toast('Напишите заголовок','err','Задача');return;}
    btn.disabled=true;btn.innerHTML='<span class="spinner dark"></span> Создаю…';
    const r=await window.githubAPI.createIssue(pjToken(),p.repo,title,m.el.querySelector('#pjIssueB').value);
    if(!r.ok){btn.disabled=false;btn.innerHTML=IC('plus')+' Создать';toast(r.error,'err','Задача не создана');return;}
    m.close();
    toast('Задача #'+r.number+' создана','ok','Проект «'+p.name+'»');
    logEvent('ok','project','Создана задача #'+r.number+': '+title,p.repo);
    pjState(p.id).issues=null;
    if(PJ.tab==='issues')pjLoadTab(p.id,'issues');
  };
}

/* ---------------- события панели ---------------- */
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-pj]');if(!el)return;
  const page=$('#pjPage');
  if(!page)return;
  e.preventDefault();
  const id=el.dataset.arg,file=el.dataset.file;
  switch(el.dataset.pj){
    case 'open':pjOpen(id);break;
    case 'back':PJ.sel=null;renderProjects();break;
    case 'add':pjAddModal();break;
    case 'account':pjAccountModal();break;
    case 'refresh':pjRefresh(id);break;
    case 'refreshAll':pjRefreshAll();break;
    case 'pull':pjPull(id);break;
    case 'push':pjPush(id);break;
    case 'commit':pjCommit(id);break;
    case 'term':pjTerm(id);break;
    case 'files':pjFiles(id);break;
    case 'claude':pjClaude(id);break;
    case 'issueClaude':pjIssueClaude(id,el.dataset.num);break;
    case 'newIssue':pjNewIssue(id);break;
    case 'remove':pjRemove(id);break;
    case 'discard':pjDiscard(id,file);break;
    case 'diff':if(!e.target.closest('button[data-pj="discard"]'))pjDiff(id,file);break;
    case 'link':window.githubAPI.open(el.dataset.url);break;
    case 'tab':{
      PJ.tab=id;renderProjects();
      const st=pjState(PJ.sel);
      const need={history:'commits',issues:'issues',pulls:'pulls',runs:'runs'}[id];
      if(need&&!st[need])pjLoadTab(PJ.sel,id);
      break;
    }
  }
});
