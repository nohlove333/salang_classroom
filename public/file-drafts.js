(function(){
'use strict';
const TTL=7*86400000,MAX=35*1024*1024;
let database,active;
function open(){if(!database)database=new Promise((resolve,reject)=>{const r=indexedDB.open('learn-file-drafts',1);r.onupgradeneeded=()=>r.result.createObjectStore('files',{keyPath:'key'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});return database;}
async function tx(mode,run){const db=await open();return new Promise((resolve,reject)=>{const t=db.transaction('files',mode),s=t.objectStore('files');let value;const r=run(s);if(r)r.onsuccess=()=>value=r.result;t.oncomplete=()=>resolve(value);t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);});}
async function purge(){return tx('readwrite',s=>{const r=s.openCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;if(Date.now()-c.value.at>TTL)c.delete();c.continue();};});}
function sameAccount(auth){return window.LearnSession.get(auth.role)?.token===auth.token;}
async function attach(dialog,key,auth){
 const picker=dialog.learnFilePicker;if(!picker||!sameAccount(auth))return;
 const area=document.createElement('p');area.className='field-help';area.setAttribute('role','status');dialog.querySelector('[data-selected-files]')?.after(area);
 const entry={key,auth,picker,revision:0,tail:Promise.resolve()};picker.fileDraft=entry;active=entry;
 const serialize=fn=>{entry.tail=entry.tail.then(fn,fn);return entry.tail;};entry.serialize=serialize;
 picker.onDraftChange=()=>{if(!sameAccount(auth))return;const files=picker.files(),keep=picker.keepAttachmentIds(),revision=++entry.revision;
 serialize(async()=>{if(!sameAccount(auth))return;try{if(files.reduce((n,f)=>n+f.size,0)>MAX)throw Error('선택 파일이 35MiB를 넘어 기기에 보관하지 못했습니다.');await tx('readwrite',s=>s.put({key,at:Date.now(),files,keep,revision}));area.textContent='선택한 파일도 이 기기에 7일간 보관했습니다. 서버 제출은 저장 버튼으로 진행하세요.';}catch(e){area.textContent='파일 임시 보관 실패: '+e.message;}});
 };
 if(picker.files().length)picker.onDraftChange();
 try{await purge();const saved=await tx('readonly',s=>s.get(key));if(!dialog.isConnected||!sameAccount(auth)||entry.revision)return;
 if(saved&&Date.now()-saved.at<TTL){area.textContent='이 기기에 선택했던 첨부파일이 있습니다. ';const recover=document.createElement('button');recover.type='button';recover.textContent='첨부 초안 복원';recover.onclick=()=>{if(!sameAccount(auth))return;picker.restoreDraft(saved.files,saved.keep);area.textContent='첨부파일을 복원했습니다. 내용을 확인하고 저장하세요.';};const discard=document.createElement('button');discard.type='button';discard.textContent='첨부 초안 버리기';discard.onclick=()=>serialize(async()=>{await tx('readwrite',s=>s.delete(key));area.textContent='첨부 초안을 기기에서 지웠습니다.';});area.append(recover,discard);}
 else area.textContent='새로 선택하는 첨부파일은 이 기기에 7일간 임시 보관합니다(한 폼 35MiB). 공유 기기에서는 사용 후 초안을 지워 주세요.';
 }catch(e){area.textContent='이 브라우저에서는 파일 임시 보관을 사용할 수 없습니다. 창을 닫으면 파일을 다시 선택해야 합니다.';}
}
function begin(dialog){const entry=dialog?.learnFilePicker?.fileDraft;return entry?{entry,revision:entry.submittedRevision??entry.revision}:null;}
function complete(snapshot){if(!snapshot)return;const {entry,revision}=snapshot;entry.serialize(async()=>{if(sameAccount(entry.auth)&&entry.revision===revision)await tx('readwrite',s=>s.delete(entry.key));}).catch(()=>{});}
function prepare(files){if(!active||!sameAccount(active.auth))return;const selected=active.picker.files();if(selected.length===files.length&&selected.every((f,i)=>f===files[i]))active.submittedRevision=active.revision;}
window.LearnFileDrafts={attach,begin,complete,prepare};
})();
