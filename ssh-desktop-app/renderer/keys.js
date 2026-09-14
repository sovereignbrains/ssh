"use strict";
/* ---------------- KEYS ---------------- */
function renderKeys(){
  persist();
  const box=$('#keysBox');
  $('#cntKeys').textContent=S.keys.length;
  box.innerHTML='<div class="kcards">'+
    '<button class="kcard k-new" data-do="genKey"><span class="sc-new-ico">'+IC('plus')+'</span><b>Новый ключ</b><small>ed25519 или RSA 4096 — создаётся сразу в сейфе</small></button>'+
    (S.keys.length?'':'<button class="kcard k-new" data-do="importKey"><span class="sc-new-ico">'+IC('upload')+'</span><b>Импорт ключа</b><small>из файла id_ed25519 / id_rsa или буфера обмена</small></button>')+
    S.keys.map(keyCard).join('')+'</div>';
}
// Card: identity on top, fingerprint, the public key itself, where it is used, and the way to put it on a server.
function keyCard(k){
  const used=S.sessions.filter(s=>s.keyId===k.id);
  const kind=/rsa/.test(k.type)?'rsa':/ecdsa/.test(k.type)?'ecdsa':'ed';
  return '<div class="kcard" data-id="'+k.id+'">'+
    '<div class="k-top">'+
      '<span class="k-ico '+kind+'">'+IC('key')+'</span>'+
      '<div class="k-t"><b title="'+esc(k.name)+'">'+esc(k.name)+'</b><small><span class="tag">'+esc(k.type)+'</span>'+(k.passphrase?'<span class="k-pp">'+IC('lock')+' фраза-пароль</span>':'')+'<span>создан '+esc(k.created)+'</span></small></div>'+
      '<div class="k-acts">'+
        '<button class="ibtn" title="Показать и сохранить публичный ключ" data-do="exportKey" data-arg="'+k.id+'">'+IC('download')+'</button>'+
        '<button class="ibtn x" title="Удалить ключ из клиента" data-do="delKey" data-arg="'+k.id+'">'+IC('x')+'</button>'+
      '</div>'+
    '</div>'+
    '<button class="k-fp" data-do="copyFp" data-arg="'+k.id+'" title="Отпечаток — нажмите, чтобы скопировать">'+IC('hash')+'<span class="mono">'+esc(k.fp)+'</span></button>'+
    '<div class="k-pub">'+
      '<div class="k-pub-h"><span>Публичный ключ</span><button class="k-copy" data-do="copyPub" data-arg="'+k.id+'">'+IC('copy')+' Копировать</button></div>'+
      '<code class="mono">'+esc(k.publicKey)+'</code>'+
    '</div>'+
    '<div class="k-foot">'+
      (used.length
        ?'<div class="k-used"><span class="k-used-l">В сессиях</span>'+used.map(s=>{const o=osOf(s.os);return '<span class="k-chip" style="--osc:'+o.color+'">'+IC(o.icon)+esc(s.name)+'</span>';}).join('')+'</div>'
        :'<div class="k-used"><span class="hint" style="margin:0">Пока не используется в сессиях</span></div>')+
      '<button class="btn primary sm" data-do="installKey" data-arg="'+k.id+'">'+IC('upload')+' Добавить на сервер</button>'+
    '</div>'+
  '</div>';
}
window.copyPub=id=>{
  const k=S.keys.find(x=>x.id===id);if(!k)return;
  navigator.clipboard&&navigator.clipboard.writeText(k.publicKey).catch(()=>{});
  toast('Публичный ключ «'+k.name+'» скопирован — его можно вставить в authorized_keys или панель хостинга','ok','Ключи');
};
// ssh-copy-id from the client: pick a session, put the public key on that server, optionally switch the session to this key.
window.installKey=id=>{
  const k=S.keys.find(x=>x.id===id);if(!k)return;
  if(!S.vaultOpen){toast('Сейф заблокирован','err','Отказано');lockScreenFocus();return;}
  if(!S.sessions.length){toast('Сначала создайте сессию — ключ добавляется на её сервер','info','Ключи');go('sessions');return;}
  const live=sid=>S.tabs.find(t=>!t.local&&t.session===sid&&t.connId&&!t.closed);
  const list=S.sessions.slice().sort((a,b)=>(!!live(b.id))-(!!live(a.id))||a.name.localeCompare(b.name,'ru'));
  let sel=(list.find(s=>live(s.id)&&s.keyId!==k.id)||list.find(s=>s.keyId!==k.id)||list[0]).id;
  const m=openModal({title:'Добавить ключ на сервер',sub:esc(k.name)+' · '+esc(k.type),icon:'upload',wide:true,
    body:'<p class="hint" style="margin:0 0 12px;font-size:12px">Публичная часть допишется в <span class="mono">~/.ssh/authorized_keys</span> пользователя сессии — как <span class="mono">ssh-copy-id</span>. Приватный ключ остаётся в клиенте. Если сессия не подключена, приложение сначала подключится к ней.</p>'+
      '<div class="ks-list" id="ksList">'+list.map(s=>{
        const o=osOf(s.os),on=!!live(s.id);
        return '<button class="ks-opt" data-sid="'+s.id+'" style="--osc:'+o.color+'">'+
          '<span class="nm-os">'+IC(o.icon)+'</span>'+
          '<span class="ks-t"><b>'+esc(s.name)+'</b><small class="mono">'+esc(s.user+'@'+s.host+(String(s.port)!=='22'?':'+s.port:''))+'</small></span>'+
          (s.keyId===k.id?'<span class="tag">уже по этому ключу</span>':'')+
          '<span class="pill '+(on?'on':'off')+'"><span class="sdot"></span>'+(on?'подключена':'подключится')+'</span>'+
          '<span class="ks-radio"></span></button>';
      }).join('')+'</div>'+
      '<label class="upd-auto" style="margin-top:14px"><input type="checkbox" id="ksUse" checked> Входить в выбранную сессию по ключу «'+esc(k.name)+'» после добавления</label>',
    footer:'<button class="btn ghost left" data-close>'+IC('x')+' Отмена</button><button class="btn primary" id="ksGo">'+IC('upload')+' Добавить</button>',
    onMount:el=>{
      const paint=()=>el.querySelectorAll('.ks-opt').forEach(b=>b.classList.toggle('on',b.dataset.sid===sel));
      paint();
      el.querySelector('#ksList').onclick=e=>{const b=e.target.closest('.ks-opt');if(b){sel=b.dataset.sid;paint();}};
      el.querySelector('#ksGo').onclick=async()=>{
        const s=S.sessions.find(x=>x.id===sel);if(!s)return;
        const useKey=el.querySelector('#ksUse').checked;
        m.close();
        let tab=live(s.id);
        if(!tab){
          await connectSession(s.id);
          tab=live(s.id);
          if(!tab){toast('Не удалось подключиться к «'+s.name+'» — ключ не добавлен','err','Ключи');return;}
        }
        const r=await window.keysAPI.install(tab.connId,k.publicKey);
        if(!r.ok){toast(r.error,'err','Ключ не добавлен');logEvent('err','key','Ключ «'+k.name+'» не добавлен: '+r.error,sessTarget(s));return;}
        logEvent('ok','key',(r.added?'Ключ «'+k.name+'» добавлен в authorized_keys':'Ключ «'+k.name+'» уже был в authorized_keys'),sessTarget(s));
        let switched=false;
        if(useKey&&(s.auth!=='key'||s.keyId!==k.id)){
          Object.assign(s,{auth:'key',keyId:k.id,keyPath:'',passphrase:''});
          switched=true;renderSessions();renderKeys();
        }
        toast((r.added?'Ключ добавлен на '+s.host:'Этот ключ уже был на '+s.host)+(switched?'. Сессия «'+s.name+'» теперь входит по ключу — старый пароль сохранён на всякий случай.':''),'ok','Ключ на сервере');
      };
    }});
};
window.copyFp=id=>{const k=S.keys.find(x=>x.id===id);if(!k)return;navigator.clipboard&&navigator.clipboard.writeText(k.fp).catch(()=>{});toast('Отпечаток скопирован: '+k.fp.slice(0,24)+'…','ok','Ключи');};
const shortKeyType=t=>t==='ssh-ed25519'?'ed25519':t==='ssh-rsa'?'rsa':/^ecdsa/.test(t)?'ecdsa':t;
function addKeyToClient(info,privateKey,passphrase,name){
  if(S.keys.some(k=>k.fp===info.fingerprint)){toast('Этот ключ уже есть в клиенте','warn','Ключи');return null;}
  const k={id:uid('k'),name:name,type:shortKeyType(info.type),fp:info.fingerprint,publicKey:info.publicKey,
    privateKey:privateKey,passphrase:passphrase||'',created:new Date().toLocaleDateString('ru-RU')};
  S.keys.push(k);renderKeys();
  return k;
}
window.exportKey=id=>{
  const k=S.keys.find(x=>x.id===id);if(!k)return;
  const m=openModal({title:'Публичный ключ',sub:esc(k.name)+' · '+k.type,icon:'download',
    body:'<div class="field"><label class="field-label">'+IC('key')+' Строка для ~/.ssh/authorized_keys на сервере</label>'+
      '<textarea class="inp mono" rows="5" readonly>'+esc(k.publicKey)+'</textarea>'+
      '<p class="hint" style="margin:11px 0 0">'+IC('shield')+' Экспортируется только публичная часть. Приватная остаётся в клиенте.</p></div>',
    footer:'<button class="btn ghost left" data-close>'+IC('x')+' Закрыть</button><button class="btn ghost" id="expCopy">'+IC('copy')+' Копировать</button><button class="btn primary" id="expSave">'+IC('save')+' Сохранить файл</button>',
    onMount:el=>{
      el.querySelector('#expCopy').onclick=()=>{navigator.clipboard&&navigator.clipboard.writeText(k.publicKey).catch(()=>{});toast('Публичный ключ скопирован','ok','Экспорт');};
      el.querySelector('#expSave').onclick=async()=>{
        const p=await window.keysAPI.savePublic(k.name,k.publicKey);
        if(p){m.close();toast('Сохранено: '+p,'ok','Экспорт завершён');}
      };
    }});
};
window.delKey=async(id,tr)=>{
  const k=S.keys.find(x=>x.id===id);if(!k)return;
  const used=S.sessions.filter(s=>s.keyId===k.id).map(s=>s.name);
  const ok=await confirmModal({title:'Удалить ключ из клиента?',icon:'key',
    text:'«<b>'+esc(k.name)+'</b>» ('+k.type+') будет удалён из клиента.'+(used.length?'<br><br><span style="color:var(--warn)">⚠ Используется в сессиях: '+used.map(esc).join(', ')+'. Для них нужно будет выбрать другой ключ.</span>':''),ok:'Удалить'});
  if(!ok){toast('Удаление отменено','info','Ключи');return;}
  tr.classList.add('dying');
  setTimeout(()=>{
    S.keys=S.keys.filter(x=>x.id!==id);
    S.sessions.forEach(s=>{if(s.keyId===k.id)s.keyId='';});
    renderKeys();renderSessions();toast('Ключ «'+k.name+'» удалён','ok','Ключи');
  },260);
};
function importKey(){
  const m=openModal({title:'Импорт ключа',sub:'из файла или буфера обмена',icon:'upload',
    body:'<div class="field" style="margin-bottom:13px"><label class="field-label">'+IC('note')+' Имя в клиенте</label><input class="inp" id="impName" placeholder="по умолчанию — комментарий ключа или имя файла"></div>'+
      '<div class="field" style="margin-bottom:13px"><label class="field-label" style="display:flex;align-items:center;gap:6px">'+IC('key')+' Приватный ключ'+
        '<button type="button" class="btn ghost sm" id="impFile" style="margin-left:auto">'+IC('upload')+' Из файла…</button></label>'+
      '<textarea class="inp mono" rows="6" id="impTxt" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></div>'+
      '<div class="field"><label class="field-label">'+IC('lock')+' Парольная фраза (если ключ зашифрован)</label>'+pwInput('impPass','парольная фраза','')+'</div>',
    footer:'<button class="btn ghost left" data-close>'+IC('x')+' Отмена</button><button class="btn primary" id="impGo">'+IC('upload')+' Импортировать</button>',
    onMount:el=>{
      let fileName='';
      el.querySelector('#impFile').onclick=async()=>{
        const r=await window.keysAPI.openFile();
        if(!r)return;
        if(r.error){toast(r.error,'err','Импорт');return;}
        let text=r.text;
        if(/\.pub$/i.test(r.path)||/^(ssh-|ecdsa-)/.test(text.trim())){toast('Это публичный ключ (.pub) — выберите файл без .pub','err','Импорт');return;}
        el.querySelector('#impTxt').value=text;
        fileName=r.path.split(/[\\/]/).pop();
      };
      el.querySelector('#impGo').onclick=async()=>{
        const ta=el.querySelector('#impTxt'),v=ta.value.trim(),pass=el.querySelector('#impPass').value;
        if(!v){ta.classList.add('err');setTimeout(()=>ta.classList.remove('err'),450);toast('Вставьте ключ или выберите файл','err','Импорт');return;}
        const r=await window.keysAPI.parse(v,pass);
        if(!r.ok){toast(r.error,'err','Импорт не удался');return;}
        const name=el.querySelector('#impName').value.trim()||r.comment||fileName||('imported_'+rnd(100,999));
        const k=addKeyToClient(r,v+'\n',pass,name);
        if(!k)return;
        m.close();
        toast(k.type+' ключ «'+k.name+'» добавлен · '+k.fp.slice(0,22)+'…','ok','Импорт');
      };
    }});
}
window.importKey=importKey;
$('#btnImportKey').onclick=importKey;
function genKey(){
  if(!S.vaultOpen){toast('Сейф заблокирован — разблокируйте для генерации','err','Отказано');lockScreenFocus();return;}
  let type='ed25519';
  const m=openModal({title:'Генерация ключа',sub:'новая пара ключей OpenSSH',icon:'sparkles',
    body:'<div class="grid2">'+
        '<div class="field"><label class="field-label">'+IC('note')+' Имя ключа</label><input class="inp" id="gName" value="'+esc('id_'+type+'_'+rnd(10,99))+'"></div>'+
        '<div class="field"><label class="field-label">'+IC('hash')+' Тип</label>'+
          '<div class="seg" id="gType">'+
            '<button class="seg-item '+(type==='ed25519'?'on':'')+'" data-t="ed25519">ed25519</button>'+
            '<button class="seg-item '+(type==='rsa'?'on':'')+'" data-t="rsa">rsa 4096</button>'+
          '</div>'+
        '</div>'+
      '</div>'+
      '<div class="field" style="margin-top:14px"><label class="field-label">'+IC('lock')+' Фраза-пароль (необязательно)</label>'+
        pwInput('gPass','дополнительная защита приватной части','')+'</div>'+
      '<p class="hint" id="gTxt" style="margin:12px 0 0">'+IC('info')+' Потом нажмите «Добавить на сервер» на карточке ключа — он запишется в ~/.ssh/authorized_keys нужной сессии.</p>',
    footer:'<button class="btn ghost left" data-close>'+IC('x')+' Отмена</button><button class="btn primary" id="gGo">'+IC('sparkles')+' Сгенерировать</button>',
    onMount:el=>{
      el.querySelectorAll('#gType .seg-item').forEach(b=>{b.onclick=()=>{
        el.querySelectorAll('#gType .seg-item').forEach(x=>x.classList.remove('on'));b.classList.add('on');
        type=b.dataset.t;
        const n=el.querySelector('#gName');
        if(!n.value.trim()||/^id_(ed25519|rsa)_/.test(n.value))n.value='id_'+type+'_'+rnd(10,99);
      };});
      el.querySelector('#gGo').onclick=async e=>{
        const name=el.querySelector('#gName').value.trim(),pass=el.querySelector('#gPass').value;
        if(!name){el.querySelector('#gName').classList.add('err');setTimeout(()=>el.querySelector('#gName').classList.remove('err'),450);toast('Укажите имя ключа','err','Генерация');return;}
        if(S.keys.some(k=>k.name===name)){toast('Ключ с таким именем уже есть в клиенте','err','Генерация');return;}
        const b=e.currentTarget,old=b.innerHTML;
        b.innerHTML='<span class="spinner dark"></span> Генерация…';b.disabled=true;
        const r=await window.keysAPI.generate(type,pass,name);
        b.innerHTML=old;b.disabled=false;
        if(!r.ok){toast(r.error,'err','Генерация не удалась');return;}
        const k=addKeyToClient(r,r.privateKey,pass,name);
        if(!k)return;
        m.close();
        toast(k.type.toUpperCase()+' ключ «'+name+'» создан — «Добавить на сервер» на его карточке','ok','Генерация завершена');
      };
    }});
}
window.genKey=genKey;
