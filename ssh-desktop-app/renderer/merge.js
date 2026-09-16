"use strict";
/* ---------------- VAULT MERGE (sync between computers) ----------------
   Pure functions, no DOM: loaded by index.html and by node tests.
   stamp(): turns a plain snapshot into a versioned one (updatedAt per record, tombstones for deletions).
   merge(): combines two versioned snapshots record by record — the newer change wins, nothing is lost silently. */
(function(root){
  const COLLECTIONS=['sessions','keys','tunnels','projects'];
  const TOMBSTONE_TTL=90*24*3600*1000;
  const JOURNAL_MAX=2000;

  // Stable JSON: key order must not make equal records look different.
  function canon(v){
    if(Array.isArray(v))return '['+v.map(canon).join(',')+']';
    if(v&&typeof v==='object')return '{'+Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';
    return JSON.stringify(v===undefined?null:v);
  }
  function strip(item){const o=Object.assign({},item);delete o.updatedAt;return o;}
  function pruneTombstones(deleted,now){
    const out={};
    for(const id of Object.keys(deleted||{}))if(now-deleted[id]<TOMBSTONE_TTL)out[id]=deleted[id];
    return out;
  }

  // prev: last saved versioned data (or data as loaded from an older vault); next: fresh plain snapshot.
  function stamp(prev,next,now){
    prev=prev||{};
    const out=Object.assign({},next);
    const deleted=Object.assign({},prev.deleted||{});
    for(const c of COLLECTIONS){
      const before=new Map((prev[c]||[]).map(x=>[x.id,x]));
      out[c]=(next[c]||[]).map(item=>{
        const clean=strip(item),old=before.get(item.id);
        if(old&&canon(strip(old))===canon(clean))return Object.assign(clean,{updatedAt:old.updatedAt||0});
        delete deleted[item.id];
        return Object.assign(clean,{updatedAt:now});
      });
      const ids=new Set(out[c].map(x=>x.id));
      for(const id of before.keys())if(!ids.has(id))deleted[id]=now;
    }
    const settingsChanged=canon(prev.settings||{})!==canon(next.settings||{});
    out.settingsUpdatedAt=settingsChanged?now:(prev.settingsUpdatedAt||0);
    out.journalClearedAt=Math.max(next.journalClearedAt||0,prev.journalClearedAt||0);
    out.deleted=pruneTombstones(deleted,now);
    return out;
  }

  // local wins ties, so a merge with an identical remote changes nothing.
  function merge(local,remote,now){
    now=now||Date.now();
    local=local||{};remote=remote||{};
    const out=Object.assign({},local);
    const stats={added:{},updated:{},removed:{}};
    const deleted=Object.assign({},local.deleted||{});
    for(const [id,ts] of Object.entries(remote.deleted||{}))deleted[id]=Math.max(deleted[id]||0,ts);
    for(const c of COLLECTIONS){
      stats.added[c]=0;stats.updated[c]=0;stats.removed[c]=0;
      const loc=local[c]||[],rem=new Map((remote[c]||[]).map(x=>[x.id,x]));
      const seen=new Set(),result=[];
      const keep=item=>!(deleted[item.id]>=(item.updatedAt||0));
      for(const a of loc){
        seen.add(a.id);
        const b=rem.get(a.id);
        let pick=a;
        if(b&&(b.updatedAt||0)>(a.updatedAt||0)){
          pick=b;
          if(canon(strip(a))!==canon(strip(b)))stats.updated[c]++;
        }
        if(keep(pick))result.push(pick);else stats.removed[c]++;
      }
      for(const b of rem.values()){
        if(seen.has(b.id)||!keep(b))continue;
        result.push(b);stats.added[c]++;
      }
      out[c]=result;
    }
    if((remote.settingsUpdatedAt||0)>(local.settingsUpdatedAt||0)){
      out.settings=remote.settings;out.settingsUpdatedAt=remote.settingsUpdatedAt;
      stats.settings=canon(local.settings||{})!==canon(remote.settings||{});
    }
    const cleared=Math.max(local.journalClearedAt||0,remote.journalClearedAt||0);
    const byId=new Map();
    for(const e of (local.journal||[]).concat(remote.journal||[])){
      if(!e||(e.ts||0)<=cleared)continue;
      const id=e.id||(e.ts+'|'+e.msg);
      if(!byId.has(id))byId.set(id,e);
    }
    out.journal=[...byId.values()].sort((x,y)=>(x.ts||0)-(y.ts||0)).slice(-JOURNAL_MAX);
    out.journalClearedAt=cleared;
    out.deleted=pruneTombstones(deleted,now);
    stats.changed=canon(out)!==canon(local);
    return {data:out,stats};
  }

  // «+1 сессия, изменено 2, удалён 1 ключ»
  function describe(stats){
    const words={sessions:['сессия','сессии','сессий'],keys:['ключ','ключа','ключей'],tunnels:['проброс','проброса','пробросов'],projects:['проект','проекта','проектов']};
    const plural=(n,f)=>f[(n%10===1&&n%100!==11)?0:(n%10>=2&&n%10<=4&&(n%100<10||n%100>=20))?1:2];
    const parts=[];
    for(const c of COLLECTIONS){
      const a=stats.added[c],u=stats.updated[c],r=stats.removed[c];
      if(a)parts.push('+'+a+' '+plural(a,words[c]));
      if(u)parts.push('изменено: '+u+' '+plural(u,words[c]));
      if(r)parts.push('удалено: '+r+' '+plural(r,words[c]));
    }
    if(stats.settings)parts.push('настройки');
    return parts.join(', ');
  }

  const api={stamp,merge,describe,canon};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.VaultMerge=api;
})(typeof window!=='undefined'?window:this);
