"use strict";
const $  = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>Array.from(r.querySelectorAll(s));
const rnd = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const esc = s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = p=>p+Math.random().toString(36).slice(2,8);
const wait = ms=>new Promise(r=>setTimeout(r,ms));
const IC = (n,cls)=>'<svg class="ic '+(cls||'')+'"><use href="#ic-'+n+'"/></svg>';
const pwInput = (id,placeholder,value)=>'<div class="pw-wrap"><input class="inp" type="password" id="'+id+'" placeholder="'+esc(placeholder)+'" value="'+esc(value||'')+'" autocomplete="off">'+
  '<button type="button" class="ibtn pw-eye" title="Показать пароль" tabindex="-1">'+IC('eye')+'</button></div>';
document.addEventListener('click',e=>{
  const btn=e.target.closest('.pw-eye');if(!btn)return;
  const inp=btn.parentElement.querySelector('input');if(!inp)return;
  const show=inp.type==='password';
  inp.type=show?'text':'password';
  btn.classList.toggle('on',show);
  btn.title=show?'Скрыть пароль':'Показать пароль';
  btn.innerHTML=IC(show?'eye-off':'eye');
  inp.focus();
});

window.addEventListener('error',e=>{
  toast('Внутренняя ошибка: '+e.message,'err','Ошибка');
  if(window.appAPI)window.appAPI.reportError('окно',e.message+(e.filename?' ('+e.filename.split('/').pop()+':'+e.lineno+')':''),e.error&&e.error.stack);
});
const ACTIONS={
  go:a=>go(a),
  sessionModal:a=>sessionModal(a||undefined),
  connect:(a,el)=>connectSession(a,el.closest('tr')),
  delSession:(a,el)=>delSession(a,el.closest('tr,.scard')),
  localShell:a=>localShell(a||undefined),
  openLocalShell:a=>openLocalShell(a),
  pickShellDir:()=>pickShellDir(),
  openTab:a=>openTab(a),
  closeGroup:a=>closeGroup(a),
  openClaude:()=>openClaude(),
  genKey:()=>genKey(),
  copyFp:a=>copyFp(a),
  exportKey:a=>exportKey(a),
  delKey:(a,el)=>delKey(a,el.closest('.krow')),
  copyPub:a=>copyPub(a),
  installKey:a=>installKey(a),
  importKey:()=>importKey(),
  copyTunnelAddr:a=>copyTunnelAddr(a),
  toggleTunnel:a=>toggleTunnel(a),
  delTunnel:(a,el)=>delTunnel(a,el.closest('.trow'))
};
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-do]');if(!el)return;
  const fn=ACTIONS[el.dataset.do];if(!fn)return;
  e.preventDefault();fn(el.dataset.arg,el);
});
document.addEventListener('dblclick',e=>{
  const el=e.target.closest('[data-dbl]');if(!el||e.target.closest('button'))return;
  const fn=ACTIONS[el.dataset.dbl];if(fn)fn(el.dataset.arg,el);
});
window.addEventListener('unhandledrejection',e=>{
  const r=e.reason;
  if(window.appAPI)window.appAPI.reportError('окно (promise)',String((r&&r.message)||r),r&&r.stack);
});

/* ---------------- ОС ---------------- */
const OS={
  ubuntu:{short:'Ubuntu',color:'#f2703f',icon:'os-ubuntu'},
  debian:{short:'Debian',color:'#e0607e',icon:'os-debian'},
  alpine:{short:'Alpine',color:'#59a8d4',icon:'os-alpine'},
  arch:{short:'Arch',color:'#4cb6ea',icon:'os-arch'},
  fedora:{short:'Fedora',color:'#7ea1e0',icon:'os-fedora'},
  rocky:{short:'Rocky',color:'#57c98b',icon:'os-rocky'},
  suse:{short:'openSUSE',color:'#9dcf55',icon:'os-suse'},
  freebsd:{short:'FreeBSD',color:'#e57b6f',icon:'os-freebsd'},
  generic:{label:'Не определена',short:'Linux',color:'#a5aab3',icon:'os-generic'}
};
const osOf = k => OS[k] || OS.generic;

/* ---------------- STATE ---------------- */
const S={
  view:'sessions',vaultOpen:false,vaultStatus:null,
  themeMode:'auto',store:'std',autolock:15,
  dataDir:'',shellDir:'',
  shell:'pwsh',font:"'JetBrains Mono','Cascadia Mono',monospace",fontSize:13.5,scrollback:10000,
  sortAsc:true,selSession:null,sessView:'cards',
  sessions:[],
  keys:[],
  journal:[],
  tunnels:[],
  projects:[],github:null,
  tabs:[],   // terminal leaves: SSH connections and local shells
  groups:[], // top tabs in strip order: {kind:'term',panes,sizes,dir,focus} or {kind:'sftp',connId}
  active:null // id of the active top tab; null is «Главная»
};
// Detected name from /etc/os-release wins; otherwise only the family name (no guessed version).
const osLabel=(k,name)=>name||((k&&k!=='generic')?osOf(k).short:osOf('generic').label);
const osBadge=(k,name)=>{const o=osOf(k);return '<span class="osb" style="--osc:'+o.color+'">'+IC(o.icon)+'<span>'+esc(osLabel(k,name))+'</span></span>';};

/* ---------------- TOASTS ---------------- */
const toastBox=$('#toasts');
const TICON={ok:'check-c',err:'xcircle',warn:'alert',info:'info'};
const TTITLE={ok:'Готово',err:'Ошибка',warn:'Внимание',info:'ssh'};
function toast(msg,type,title){
  type=type||'info';
  const t=document.createElement('div');
  t.className='toast '+type;
  t.innerHTML='<span class="ti">'+IC(TICON[type])+'</span><span class="tb"><b>'+esc(title||TTITLE[type])+'</b><span>'+esc(msg)+'</span></span><i class="bar"></i>';
  // Errors stay longer: they are the ones people actually need to read.
  const life=type==='err'?7000:type==='warn'?5500:4200;
  const bar=t.querySelector('.bar');
  toastBox.appendChild(t);
  let timer=null;
  const kill=()=>{clearTimeout(timer);t.classList.add('out');setTimeout(()=>t.remove(),280);};
  const arm=()=>{
    clearTimeout(timer);timer=setTimeout(kill,life);
    bar.style.animation='none';void bar.offsetWidth;bar.style.animation='tBar '+life+'ms linear both';
  };
  t.addEventListener('click',kill);
  // Hovering holds the notification so a long message can be read to the end.
  t.addEventListener('mouseenter',()=>{clearTimeout(timer);t.classList.add('hold');});
  t.addEventListener('mouseleave',()=>{t.classList.remove('hold');arm();});
  arm();
  while(toastBox.children.length>3)toastBox.firstElementChild.remove();
  return t;
}

/* ---------------- MODALS ---------------- */
const modalRoot=$('#modalRoot');
let modalStack=[];
function openModal(cfg){
  const back=document.createElement('div');back.className='mback';
  const m=document.createElement('div');m.className='modal'+(cfg.wide?' wide':'');
  m.innerHTML=
    '<div class="m-head"><div class="mi">'+IC(cfg.icon||'settings')+'</div>'+
    '<div style="flex:1;min-width:0"><h3>'+cfg.title+'</h3>'+(cfg.sub?'<p>'+cfg.sub+'</p>':'')+'</div>'+
    '<button class="ibtn x" data-close title="Закрыть">'+IC('x')+'</button></div>'+
    '<div class="m-body">'+cfg.body+'</div>'+
    (cfg.footer?'<div class="m-foot">'+cfg.footer+'</div>':'');
  modalRoot.append(back,m);modalRoot.classList.add('on');
  const api={el:m,back:back,close:function(){
    m.classList.add('out');back.style.animation='fadeIn .2s reverse both';
    setTimeout(()=>{m.remove();back.remove();
      if(!modalRoot.querySelector('.modal'))modalRoot.classList.remove('on');
      modalStack=modalStack.filter(x=>x!==api);},200);
  }};
  modalStack.push(api);
  m.addEventListener('click',e=>{if(e.target.closest('[data-close]'))api.close();});
  back.addEventListener('click',()=>api.close());
  if(cfg.onMount)cfg.onMount(m,api);
  const f=m.querySelector('input,select,textarea,button.primary');
  if(f)setTimeout(()=>f.focus(),130);
  return api;
}
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    if(modalStack.length){e.preventDefault();modalStack[modalStack.length-1].close();return;}
    if($('#connectScreen').classList.contains('on')&&typeof connAbort==='function'){connAbort('escape');return;}
  }
  if(modalStack.length||!S.vaultOpen)return;
  if(e.ctrlKey&&e.key==='Tab'){e.preventDefault();cycleTopTab(e.shiftKey?-1:1);return;}
  if(e.altKey&&!e.ctrlKey&&/^[1-9]$/.test(e.key)){e.preventDefault();const i=+e.key-1;activateGroup(i===0?null:(S.groups[i-1]||S.groups[S.groups.length-1]||{id:null}).id);}
});
function confirmModal(cfg){
  return new Promise(res=>{
    let done=false;
    const m=openModal({title:cfg.title||'Подтвердите',icon:cfg.icon||'trash',
      body:'<p style="margin:0;font-size:13.5px;line-height:1.65;color:var(--dim)">'+cfg.text+'</p>',
      footer:'<button class="btn ghost" data-no>'+IC('x')+' Отмена</button><button class="btn '+(cfg.danger===false?'primary':'danger')+'" data-yes>'+IC(cfg.danger===false?'check':'alert')+' '+(cfg.ok||'Удалить')+'</button>'});
    const fin=v=>{if(done)return;done=true;res(v);m.close();};
    m.el.querySelector('[data-no]').onclick=()=>fin(false);
    m.el.querySelector('[data-yes]').onclick=()=>fin(true);
    m.back.onclick=()=>fin(false);
    m.el.querySelector('[data-close]').onclick=()=>fin(false);
  });
}

/* ---------------- THEME ---------------- */
function autoTheme(){const h=new Date().getHours();return (h>=20||h<7)?'night':'edge';}
function applyTheme(silent){
  persist();
  const real=S.themeMode==='auto'?autoTheme():S.themeMode;
  document.documentElement.dataset.theme=real;
  $$('#themeOpts .opt').forEach(o=>o.classList.toggle('on',o.dataset.mode===S.themeMode));
  $('#themeNow').textContent=S.themeMode==='auto'?('Авто → '+(real==='night'?'Ночь':'Edge')):(real==='night'?'Ночь':'Edge');
  $('#btnThemeQuick').innerHTML=IC(real==='night'?'sun':'moon');
  Object.values(xtermState).forEach(st=>{st.term.options.theme=currentXtermTheme();});
  if(!silent)toast(S.themeMode==='auto'?('Авто-режим, сейчас «'+(real==='night'?'Ночь':'Edge')+'»'):(real==='night'?'Ночь — серо-оранжевая на графите':'Edge — сине-зелёная на графите'),'ok','Внешний вид');
}
$$('#themeOpts .opt').forEach(o=>{o.onclick=()=>{S.themeMode=o.dataset.mode;applyTheme();};});
$('#btnThemeQuick').onclick=()=>{S.themeMode=document.documentElement.dataset.theme==='night'?'edge':'night';applyTheme();};
setInterval(()=>{if(S.themeMode==='auto')applyTheme(true);},60000);

/* ---------------- RIPPLE ---------------- */
document.addEventListener('pointerdown',e=>{
  const t=e.target.closest('.btn,.nav-item,.opt,.ibtn,.seg-item,.wbtn,.stab-add,.nm-item,.pill.clickable,.stepper button');
  if(!t)return;
  const r=t.getBoundingClientRect(),size=Math.max(r.width,r.height)*1.1;
  const s=document.createElement('span');s.className='ripple';
  s.style.cssText='width:'+size+'px;height:'+size+'px;left:'+(e.clientX-r.left-size/2)+'px;top:'+(e.clientY-r.top-size/2)+'px';
  if(getComputedStyle(t).position==='static')t.style.position='relative';
  t.style.overflow='hidden';t.appendChild(s);setTimeout(()=>s.remove(),620);
});

/* ---------------- ROUTER ---------------- */
const ORDER=['sessions','projects','keys','tunnels','journal','settings'];
function go(name){
  if(S.active!==null)activateGroup(null);
  if(!name||name===S.view)return;
  const dir=ORDER.indexOf(name)>ORDER.indexOf(S.view)?1:-1;
  const cur=document.querySelector('.view[data-view="'+S.view+'"]');
  const next=document.querySelector('.view[data-view="'+name+'"]');
  if(!next)return;
  if(cur){cur.classList.remove('active');cur.classList.add('leaving');cur.style.setProperty('--dir',dir);
    setTimeout(()=>cur.classList.remove('leaving'),210);}
  next.style.setProperty('--dir',dir);next.classList.add('active');
  S.view=name;
  $$('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.view===name));
  $('#content').scrollTo({top:0,behavior:'smooth'});
  if(name==='settings')refreshTempInfo();
  if(name==='journal')renderJournal();
  if(name==='keys')renderKeys();
  if(name==='projects'){renderProjects();pjAutoRefresh();}
}
window.go=go;
$$('.nav-item').forEach(n=>{n.onclick=()=>go(n.dataset.view);});

// Zero counters are noise in the dock: hide them.
$$('.nav-item .badge').forEach(b=>{
  const sync=()=>b.classList.toggle('zero',b.textContent.trim()==='0');
  new MutationObserver(sync).observe(b,{childList:true,characterData:true,subtree:true});
  sync();
});
window.addEventListener('resize',()=>fitActiveXterm());
// The frog is the «Главная» tab.
$('#logo').onclick=()=>{
  $('#logo img').animate([{transform:'scale(1)'},{transform:'scale(.86)'},{transform:'scale(1.06)'},{transform:'scale(1)'}],{duration:360,easing:'cubic-bezier(.3,1.2,.4,1)'});
  activateGroup(null);
};

/* ---------------- WINDOW ---------------- */
$('#btnMin').onclick=()=>window.electronAPI.send('minimize-window');
if(window.electronAPI){
  if(window.electronAPI.platform==='darwin')document.documentElement.classList.add('mac');
  window.electronAPI.receive('window-state',st=>{
    ['#btnMax','#lockMax'].forEach(id=>{const b=$(id);b.innerHTML=IC(st.maximized?'restore':'maximize');b.title=st.maximized?'Восстановить':'Развернуть';});
  });
}
$('#btnMax').onclick=$('#lockMax').onclick=()=>window.electronAPI.send('maximize-window');
$('#btnClose').onclick=$('#lockExit').onclick=()=>window.electronAPI.send('close-window');
$('#lockMin').onclick=()=>window.electronAPI.send('minimize-window');
