"use strict";
/* ---------------- ИНСТРУМЕНТЫ ----------------
   Замеры сети. Разовая цифра почти ничего не говорит, когда канал плавает, поэтому здесь
   и одиночные замеры, и наблюдение по кругу с разбросом. */
const NT={proxy:'',every:20,monitoring:false,samples:[],speed:null,rtt:null,mtu:null,overview:null,targets:null};
const NT_MAX_SAMPLES=120;
const ntClock=ts=>new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const ntSpeedWord=m=>m>=200?'ok':m>=50?'ok':m>=10?'warn':'err';
const ntMbit=m=>(m>=100?Math.round(m):+m.toFixed(1))+' Мбит/с';

function ntProxyValue(){const el=$('#ntProxy');return el?el.value.trim():'';}

async function ntTargets(){
  if(NT.targets)return NT.targets;
  NT.targets=await window.netAPI.targets();
  return NT.targets;
}

/* --------- скорость --------- */
async function ntRunSpeed(){
  const btn=$('#btnNtSpeed');if(!btn)return;
  const {speed}=await ntTargets();
  const proxy=ntProxyValue();
  btn.disabled=true;
  const old=btn.innerHTML;
  btn.innerHTML='<span class="spinner dark"></span> Меряю…';
  NT.speed=speed.map(t=>({name:t.name,pending:true}));
  ntRenderSpeed();
  const rows=[];
  for(const t of speed){
    const r=await window.netAPI.speed({url:t.url,proxy,maxBytes:10e6,timeoutMs:20000});
    rows.push({name:t.name,...r});
    NT.speed=rows.concat(speed.slice(rows.length).map(x=>({name:x.name,pending:true})));
    ntRenderSpeed();
  }
  btn.disabled=false;btn.innerHTML=old;
  const good=rows.filter(r=>r.ok);
  if(good.length){
    const best=Math.max(...good.map(r=>r.mbit));
    logEvent('info','net','Замер скорости'+(proxy?' через '+proxy:'')+': лучшая точка '+ntMbit(best),'');
    toast('Быстрее всех — '+ntMbit(best),'ok','Инструменты');
  }else{
    toast('Ни одна точка не ответила','err','Инструменты');
  }
}
function ntRenderSpeed(){
  const box=$('#ntSpeedBox');if(!box)return;
  if(!NT.speed)return void(box.innerHTML='');
  box.innerHTML='<div class="klist nt-list">'+NT.speed.map(r=>{
    if(r.pending)return '<div class="krow"><div class="kr-main"><div class="kr-name"><b>'+esc(r.name)+'</b></div></div><div class="kr-acts"><span class="pill">в очереди…</span></div></div>';
    const val=r.ok?'<b class="mono">'+ntMbit(r.mbit)+'</b>':'<span class="kr-none">'+esc(r.error||'не удалось')+'</span>';
    const meta=r.ok?('загружено '+(r.bytes/1048576).toFixed(1)+' МБ'+(r.ttfbMs!=null?' · первый байт через '+r.ttfbMs+' мс':'')):'';
    return '<div class="krow"><div class="kr-main"><div class="kr-name">'+val+' <span class="tag">'+esc(r.name)+'</span></div>'+
      (meta?'<div class="kr-meta"><span>'+esc(meta)+'</span></div>':'')+'</div>'+
      '<div class="kr-acts"><span class="pill '+(r.ok?ntSpeedWord(r.mbit):'off')+'"><span class="sdot"></span>'+(r.ok?'ответила':'молчит')+'</span></div></div>';
  }).join('')+'</div>';
}

/* --------- задержка --------- */
async function ntRunRtt(){
  const btn=$('#btnNtRtt');if(!btn)return;
  const {rtt}=await ntTargets();
  btn.disabled=true;const old=btn.innerHTML;
  btn.innerHTML='<span class="spinner dark"></span> Меряю…';
  const rows=[];
  for(const t of rtt){
    const r=await window.netAPI.rtt({host:t.host,port:t.port,count:8});
    rows.push({name:t.name,host:t.host,...r});
    NT.rtt=rows.slice();
    ntRenderRtt();
  }
  btn.disabled=false;btn.innerHTML=old;
}
function ntRenderRtt(){
  const box=$('#ntRttBox');if(!box)return;
  if(!NT.rtt)return void(box.innerHTML='');
  box.innerHTML='<div class="klist nt-list">'+NT.rtt.map(r=>{
    if(!r.ok)return '<div class="krow"><div class="kr-main"><div class="kr-name"><b>'+esc(r.name)+'</b></div>'+
      '<div class="kr-meta"><span>не отвечает</span></div></div><div class="kr-acts"><span class="pill off"><span class="sdot"></span>потери 100%</span></div></div>';
    return '<div class="krow"><div class="kr-main">'+
      '<div class="kr-name"><b class="mono">'+r.avg+' мс</b> <span class="tag">'+esc(r.name)+'</span></div>'+
      '<div class="kr-meta"><span>мин '+r.min+' · макс '+r.max+' · джиттер '+r.jitter+' мс</span></div></div>'+
      '<div class="kr-acts"><span class="pill '+(r.loss?'warn':'ok')+'"><span class="sdot"></span>'+(r.loss?('потери '+r.loss+'%'):'без потерь')+'</span></div></div>';
  }).join('')+'</div>';
}

/* --------- наблюдение --------- */
async function ntToggleMonitor(){
  if(NT.monitoring){
    await window.netAPI.monitorStop('tools');
    NT.monitoring=false;
    ntRenderMonitor();
    logEvent('info','net','Наблюдение за сетью остановлено, замеров: '+NT.samples.length,'');
    toast('Наблюдение остановлено','ok','Инструменты');
    return;
  }
  const {speed}=await ntTargets();
  const r=await window.netAPI.monitorStart({id:'tools',url:speed[0].url,proxy:ntProxyValue(),everyMs:NT.every*1000,maxBytes:3e6});
  if(!r.ok){toast(r.error||'Не удалось запустить','err','Инструменты');return;}
  NT.samples=[];NT.monitoring=true;
  ntRenderMonitor();
  logEvent('info','net','Наблюдение за сетью запущено, раз в '+NT.every+' с','');
}
function ntSpark(samples){
  const vals=samples.map(s=>s.mbit);
  if(vals.length<2)return '';
  const max=Math.max(...vals,1),h=46,w=Math.max(120,vals.length*8);
  const pts=vals.map((v,i)=>((i/(vals.length-1))*w).toFixed(1)+','+(h-(v/max)*(h-4)-2).toFixed(1)).join(' ');
  return '<svg class="nt-spark" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'+
    '<polyline points="'+pts+'"/></svg>';
}
function ntRenderMonitor(){
  const btn=$('#btnNtMon');
  if(btn){btn.innerHTML=IC(NT.monitoring?'stop':'play')+' '+(NT.monitoring?'Остановить':'Начать');btn.classList.toggle('danger',NT.monitoring);btn.classList.toggle('primary',!NT.monitoring);}
  const box=$('#ntMonBox');if(!box)return;
  const n=NT.samples.length;
  if(!n){
    box.innerHTML=NT.monitoring?'<p class="hint" style="margin:12px 0 0">'+IC('clock')+' Первый замер идёт…</p>':'';
    return;
  }
  const ok=NT.samples.filter(s=>s.ok);
  const vals=ok.map(s=>s.mbit);
  const rtts=NT.samples.map(s=>s.rtt).filter(x=>x!=null);
  const min=vals.length?Math.min(...vals):0,max=vals.length?Math.max(...vals):0;
  const avg=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0;
  // Разброс — то, ради чего всё и затевалось: если максимум сильно выше минимума, канал рваный.
  const spread=min>0?max/min:0;
  const last=NT.samples[n-1];
  box.innerHTML='<div class="nt-mon">'+
    ntSpark(NT.samples)+
    '<div class="nt-stats">'+
      '<span><b class="mono">'+ntMbit(avg)+'</b><small>в среднем</small></span>'+
      '<span><b class="mono">'+ntMbit(min)+'</b><small>минимум</small></span>'+
      '<span><b class="mono">'+ntMbit(max)+'</b><small>максимум</small></span>'+
      (rtts.length?'<span><b class="mono">'+Math.round(rtts.reduce((a,b)=>a+b,0)/rtts.length)+' мс</b><small>отклик</small></span>':'')+
      '<span><b class="mono">'+n+'</b><small>замеров</small></span>'+
    '</div>'+
    (spread>=3?'<p class="hint warn" style="margin:10px 0 0">'+IC('alert')+' Максимум выше минимума в '+spread.toFixed(1)+' раза — канал рваный, дело не в средней скорости.</p>':'')+
    (last&&!last.ok?'<p class="hint" style="margin:10px 0 0">'+IC('xcircle')+' Последний замер не прошёл: '+esc(last.error||'нет ответа')+'</p>':'')+
    '<div class="nt-log">'+NT.samples.slice(-8).reverse().map(s=>
      '<span><i>'+ntClock(s.at)+'</i>'+(s.ok?ntMbit(s.mbit):'<em>не прошёл</em>')+(s.rtt!=null?' · '+s.rtt+' мс':'')+'</span>').join('')+'</div>'+
  '</div>';
}

/* --------- MTU и сведения о компьютере --------- */
async function ntRunMtu(){
  const btn=$('#btnNtMtu'),host=($('#ntMtuHost').value||'1.1.1.1').trim();
  btn.disabled=true;const old=btn.innerHTML;
  btn.innerHTML='<span class="spinner dark"></span> Ищу…';
  const r=await window.netAPI.mtu(host);
  btn.disabled=false;btn.innerHTML=old;
  NT.mtu={host,...r};
  const box=$('#ntMtuBox');
  if(box)box.innerHTML=r.ok
    ? '<p class="hint" style="margin:10px 0 0">'+IC('check-c')+' До <span class="mono">'+esc(host)+'</span> проходит пакет '+r.payload+' байт полезных данных — это MTU <b class="mono">'+r.mtu+'</b>'+(r.capped?' или больше (выше не проверяли)':'')+'.</p>'
    : '<p class="hint" style="margin:10px 0 0">'+IC('alert')+' '+esc(r.error||'не удалось')+'</p>';
}
async function ntRefreshOverview(){
  if(!window.netAPI)return;
  NT.overview=await window.netAPI.overview();
  ntRenderOverview();
}
function ntRenderOverview(){
  const box=$('#ntOverviewBox');if(!box)return;
  const o=NT.overview;
  if(!o)return void(box.innerHTML='');
  const speed=b=>{const n=Number(b);return n>0?(n>=1e9?(n/1e9).toFixed(1)+' Гбит/с':Math.round(n/1e6)+' Мбит/с'):'';};
  box.innerHTML='<div class="klist nt-list" style="margin-top:14px">'+
    (o.interfaces||[]).map(i=>'<div class="krow">'+
      '<span class="k-ico">'+IC(/wi-?fi|wireless|беспровод/i.test(i.desc||i.name)?'wifi':'plug')+'</span>'+
      '<div class="kr-main"><div class="kr-name"><b>'+esc(i.name)+'</b>'+(i.address?'<span class="tag mono">'+esc(i.address)+'</span>':'')+'</div>'+
      '<div class="kr-meta"><span>'+esc(i.desc||'')+'</span></div></div>'+
      '<div class="kr-acts">'+(i.mtu?'<span class="pill">MTU '+i.mtu+'</span>':'')+(speed(i.linkSpeedBps)?'<span class="pill">'+speed(i.linkSpeedBps)+'</span>':'')+'</div>'+
    '</div>').join('')+
    (o.routes||[]).map(r=>'<div class="krow">'+
      '<span class="k-ico">'+IC('arrow-right')+'</span>'+
      '<div class="kr-main"><div class="kr-name"><b>Весь трафик наружу</b> <span class="tag">'+esc(r.alias||('#'+r.ifIndex))+'</span></div>'+
      '<div class="kr-meta"><span>шлюз '+esc(r.nextHop||'—')+' · метрика '+(r.metric!=null?r.metric:'—')+'</span></div></div>'+
    '</div>').join('')+
  '</div>';
}

function renderTools(){
  if(!window.netAPI){
    const box=$('#ntOverviewBox');
    if(box)box.innerHTML='<p class="hint">'+IC('alert')+' Замеры недоступны в этой сборке.</p>';
    return;
  }
  ntRenderSpeed();ntRenderRtt();ntRenderMonitor();
  if(!NT.overview)ntRefreshOverview();else ntRenderOverview();
}

if(window.netAPI){
  window.netAPI.onSample(s=>{
    if(s.id!=='tools')return;
    NT.samples.push(s);
    if(NT.samples.length>NT_MAX_SAMPLES)NT.samples.shift();
    if(S.view==='tools')ntRenderMonitor();
  });
  $('#btnNtSpeed').onclick=ntRunSpeed;
  $('#btnNtRtt').onclick=ntRunRtt;
  $('#btnNtMon').onclick=ntToggleMonitor;
  $('#btnNtMtu').onclick=ntRunMtu;
  $('#btnNtRefresh').onclick=()=>{ntRefreshOverview();toast('Сведения обновлены','ok','Инструменты');};
  $$('#ntEvery .seg-item').forEach(b=>{b.onclick=()=>{
    $$('#ntEvery .seg-item').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');NT.every=+b.dataset.every;
    if(NT.monitoring){ntToggleMonitor().then(ntToggleMonitor);}
  };});
}
