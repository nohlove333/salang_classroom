(function(){
'use strict';
const prefix='learn-form-draft-v1:', TTL=7*86400000;
const sensitive=/password|passwd|pin|token|secret|activation|setup.?key/i;
let active=null,attachSequence=0;
function session(){const role=location.hash.startsWith('#/student')?'student':location.hash.startsWith('#/guest')?'guest':'teacher';const s=window.LearnSession.get(role);return s?.token?{role,token:s.token}:null;}
// No raw token is persisted in the storage key; the digest is used only as a local namespace.
async function namespace(s){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s.role+'|'+s.token));return Array.from(new Uint8Array(bytes)).map(b=>b.toString(16).padStart(2,'0')).join('');}
function controls(form){return Array.from(form.querySelectorAll('input[name],textarea[name],select[name]')).filter(e=>!['password','file','hidden','submit','button'].includes(e.type)&&!sensitive.test(e.name));}
function capture(form){return controls(form).map(e=>({name:e.name,type:e.type,value:e.type==='checkbox'||e.type==='radio'?e.checked:e.multiple?Array.from(e.selectedOptions).map(o=>o.value):e.value}));}
function restore(form,values){const fields=controls(form);for(let i=0;i<values.length;i++){const v=values[i],e=fields[i];if(!e||e.name!==v.name||e.type!==v.type)continue;if(e.type==='checkbox'||e.type==='radio')e.checked=Boolean(v.value);else if(e.multiple&&Array.isArray(v.value))for(const o of e.options)o.selected=v.value.includes(o.value);else e.value=String(v.value??'');}}
function put(entry){try{localStorage.setItem(entry.key,JSON.stringify({at:Date.now(),values:capture(entry.form),baseline:entry.baseline}));entry.notice.textContent='입력 내용을 이 기기에 임시 보관했습니다. 첨부파일은 다시 선택해야 합니다.';}catch{entry.notice.textContent='기기 임시 저장에 실패했습니다. 창을 닫기 전에 내용을 복사해 주세요.';}}
async function attach(dialog,opts){
 const form=dialog.querySelector('form'),auth=session();if(!form||!auth)return;const seq=++attachSequence;form.learnDraftSequence=seq;
 const baseline=JSON.stringify(capture(form));const suffix=opts.key+'|'+location.hash;
 const ns=await namespace(auth);if(session()?.token!==auth.token||!dialog.isConnected||form.learnDraftSequence!==seq)return;
 try{for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i);if(k&&k.startsWith(prefix)){let saved;try{saved=JSON.parse(localStorage.getItem(k));}catch{}if(!saved||Date.now()-saved.at>=TTL)localStorage.removeItem(k);}}}catch{}
 const key=prefix+ns+':'+suffix, notice=document.createElement('p');notice.className='field-help draft-notice';notice.setAttribute('role','status');form.prepend(notice);
 const entry={form,key,token:auth.token,baseline,notice,actions:opts.actions||[],kind:opts.kind};active=entry;
 let cached;try{cached=JSON.parse(localStorage.getItem(key)||'null');}catch{}
 if(cached&&Date.now()-cached.at<TTL){
  // Never silently replace a newer server revision. Let the teacher choose which input to recover.
  notice.textContent='이 기기에 저장된 작성 내용이 있습니다. ';
  const recover=document.createElement('button');recover.type='button';recover.textContent='초안 복원';recover.onclick=()=>{restore(form,cached.values);notice.textContent=cached.baseline===baseline?'초안을 복원했습니다. 첨부파일은 다시 선택해 주세요.':'초안을 복원했습니다. 서버 내용이 바뀌었을 수 있으니 비교한 뒤 저장해 주세요.';};notice.appendChild(recover);
  const discard=document.createElement('button');discard.type='button';discard.textContent='초안 버리기';discard.onclick=()=>{localStorage.removeItem(key);notice.textContent='기기에 보관된 초안을 지웠습니다.';};notice.appendChild(discard);
 }else{if(cached)localStorage.removeItem(key);notice.textContent='작성 내용은 이 기기에 7일간 임시 보관됩니다. 첨부파일·비밀번호는 보관하지 않습니다.';}
 form.addEventListener('input',()=>{if(session()?.token===entry.token)put(entry);});form.addEventListener('change',()=>{if(session()?.token===entry.token)put(entry);});
}
function begin(action,payload){if(!active||!active.form.isConnected||session()?.token!==active.token||!active.actions.includes(action)||(active.kind&&payload?.kind!==active.kind))return null;return {...active,values:JSON.stringify(capture(active.form))};}
function complete(entry){if(!entry||session()?.token!==entry.token||!entry.form.isConnected||active?.form!==entry.form)return;if(JSON.stringify(capture(entry.form))!==entry.values)return;try{localStorage.removeItem(entry.key);entry.notice.textContent='서버에 저장했습니다. 기기 초안을 지웠습니다.';}catch{}}
window.LearnDrafts={attach,begin,complete,capture,restore};
})();
