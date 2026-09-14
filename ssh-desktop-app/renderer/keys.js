"use strict";
/* ---------------- KEYS ---------------- */
function renderKeys(){
  persist();
  const box=$('#keysBox');
  $('#cntKeys').textContent=S.keys.length;
  if(!S.keys.length){
    box.innerHTML='<div class="table-wrap"><div class="empty">'+
      '<div class="empty-ico">'+IC('key')+'</div>'+
      '<h4>В сейфе нет ключей</h4>'+
      '<p>Сгенерируйте пару ed25519/rsa или импортируйте существующий приватный ключ — потом его можно выбрать в настройках сессии.</p>'+
      '<button class="btn primary" data-do="genKey">'+IC('sparkles')+' Сгенерировать ключ</button>'+
      '</div></div></div>';
    return;
  }
  box.innerHTML='<div class="table-wrap"><table><thead><tr><th>Имя</th><th style="width:118px">Тип</th><th>Отпечаток</th><th style="width:124px">Создан</th><th style="width:132px"></th></tr></thead><tbody>'+
    S.keys.map(k=>
      '<tr data-id="'+k.id+'">'+
      '<td data-l="Имя" class="name">'+esc(k.name)+'</td>'+
      '<td data-l="Тип"><span class="tag">'+k.type+'</span></td>'+
      '<td data-l="Отпечаток" class="mono" style="font-size:11.5px;word-break:break-all">'+esc(k.fp)+'</td>'+
      '<td data-l="Создан" style="color:var(--dim);font-size:12px">'+k.created+'</td>'+
      '<td data-l=""><div class="row-actions">'+
        '<button class="ibtn" title="Скопировать отпечаток" data-do="copyFp" data-arg="'+k.id+'">'+IC('copy')+'</button>'+
        '<button class="ibtn" title="Экспорт публичного ключа" data-do="exportKey" data-arg="'+k.id+'">'+IC('download')+'</button>'+
        '<button class="ibtn x" title="Удалить ключ" data-do="delKey" data-arg="'+k.id+'">'+IC('x')+'</button>'+
      '</div></td></tr>'
    ).join('')+'</tbody></table></div>';
}
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
$('#btnGenKey2').onclick=()=>genKey();
$('#btnImportKey').onclick=()=>{
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
};
function genKey(){
  if(!S.vaultOpen){toast('Сейф заблокирован — разблокируйте для генерации','err','Отказано');lockScreenFocus();return;}
  const pre=$('#kName').value.trim();
  let type=($('#kType .seg-item.on')||{dataset:{t:'ed25519'}}).dataset.t;
  const m=openModal({title:'Генерация ключа',sub:'новая пара ключей OpenSSH',icon:'sparkles',
    body:'<div class="grid2">'+
        '<div class="field"><label class="field-label">'+IC('note')+' Имя ключа</label><input class="inp" id="gName" value="'+esc(pre||('id_'+type+'_'+rnd(10,99)))+'"></div>'+
        '<div class="field"><label class="field-label">'+IC('hash')+' Тип</label>'+
          '<div class="seg" id="gType">'+
            '<button class="seg-item '+(type==='ed25519'?'on':'')+'" data-t="ed25519">ed25519</button>'+
            '<button class="seg-item '+(type==='rsa'?'on':'')+'" data-t="rsa">rsa 4096</button>'+
          '</div>'+
        '</div>'+
      '</div>'+
      '<div class="field" style="margin-top:14px"><label class="field-label">'+IC('lock')+' Фраза-пароль (необязательно)</label>'+
        pwInput('gPass','дополнительная защита приватной части','')+'</div>'+
      '<p class="hint" id="gTxt" style="margin:12px 0 0">'+IC('info')+' После генерации добавьте публичный ключ на сервер в ~/.ssh/authorized_keys (кнопка экспорта в списке).</p>',
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
        toast(k.type.toUpperCase()+' ключ «'+name+'» создан · '+k.fp.slice(0,22)+'…','ok','Генерация завершена');
      };
    }});
}
window.genKey=genKey;
$$('#kType .seg-item').forEach(b=>{b.onclick=()=>{
  $$('#kType .seg-item').forEach(x=>x.classList.remove('on'));b.classList.add('on');
  const n=$('#kName');
  if(!n.value.trim()||/^id_(ed25519|rsa)_/.test(n.value))n.value='id_'+b.dataset.t+'_'+rnd(10,99);
  toast('Тип ключа: '+b.dataset.t,'info','Генерация');
};});
