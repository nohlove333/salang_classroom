(function () {
'use strict';
const MAX_BYTES=80*1024*1024, MAX_HTML_BYTES=120*1024*1024;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const encode=b=>{let s='';for(let i=0;i<b.length;i+=16384)s+=String.fromCharCode(...b.subarray(i,i+16384));return btoa(s);};
const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function hash(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');}
function unsigned(pack){const {checksum,...data}=pack;return data;}
async function seal(pack){pack.checksum=await hash(new TextEncoder().encode(JSON.stringify(unsigned(pack))));return pack;}
async function verify(pack){
 if(!pack||pack.format!=='learn-class-archive'||pack.schemaVersion!==1||!pack.snapshot?.classInfo||!Array.isArray(pack.files)||pack.files.length>2000)throw Error('지원하는 수업 보관 파일이 아닙니다.');
 if(await hash(new TextEncoder().encode(JSON.stringify(unsigned(pack))))!==pack.checksum)throw Error('자료 무결성 검사가 실패했습니다. 원본 파일을 다시 확인해 주세요.');
 for(const f of pack.files)if(f.status==='included'){const b=decode(f.data);if(b.length!==f.size||await hash(b)!==f.sha256)throw Error(f.name+' 첨부파일 검증 실패');}
 return {files:pack.files.filter(f=>f.status==='included').length,missing:pack.files.filter(f=>f.status!=='included').length};
}
function viewer(){
 const pack=JSON.parse(document.getElementById('archive-data').textContent),s=pack.snapshot;
 const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const names={announcements:'공지',assignments:'과제',boards:'보드',ideas:'아이디어',submissions:'제출물',boardPosts:'보드 활동',ideaPosts:'아이디어 활동',records:'교사 기록',students:'학생 목록'};
 const contentById=new Map([...s.announcements,...s.assignments,...s.boards,...s.ideas].map(x=>[x.id,x]));
 const files=new Map(pack.files.map(f=>[f.id,f]));
 let active='announcements';
 document.getElementById('title').textContent=s.classInfo.name+' · 수업 보관함';
 document.getElementById('summary').textContent='저장 시각 '+pack.exportedAt+' · 첨부 포함 '+pack.files.filter(f=>f.status==='included').length+'개 / 전체 '+pack.files.length+'개';
 document.getElementById('tabs').innerHTML=Object.entries(names).map(([k,v])=>'<button data-tab="'+k+'">'+v+' ('+(k==='records'?pack.records:s[k]||[]).length+')</button>').join('');
 function draw(){const q=document.getElementById('query').value.toLowerCase();let list=active==='records'?pack.records:s[active]||[];list=list.filter(x=>JSON.stringify(x).toLowerCase().includes(q));document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===active));document.getElementById('entries').innerHTML=list.map(x=>{const parent=contentById.get(x.assignmentId||x.boardId||x.ideaId);const attached=(x.attachments||[]).map(a=>{const f=files.get(a.id);return f?.status==='included'?'<button data-file="'+esc(f.id)+'">↓ '+esc(f.name)+'</button>':'<span class="missing">'+esc(a.name)+' · '+esc(f?.reason||'첨부 미포함')+'</span>';}).join(' ');return '<article><small>'+esc(parent?.title||x.category||'')+'</small><h2>'+esc(x.title||x.name||x.groupName||names[active])+'</h2><p class="meta">'+esc(x.studentNumber?x.studentNumber+'번 '+x.studentName:'')+' '+esc(x.submittedAt||x.createdAt||x.date||'')+'</p><p>'+esc(x.body||x.text||'')+'</p>'+(x.dueAt?'<p>마감 '+esc(x.dueAt)+'</p>':'')+(x.status?'<p>상태 '+esc(x.status)+(x.revisionMessage?' · '+esc(x.revisionMessage):'')+'</p>':'')+attached+'</article>';}).join('')||'<p>표시할 자료가 없습니다.</p>';}
 document.getElementById('tabs').onclick=e=>{const b=e.target.closest('[data-tab]');if(b){active=b.dataset.tab;draw();}};document.getElementById('query').oninput=draw;
 function download(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),10000);}
 document.getElementById('entries').onclick=e=>{const b=e.target.closest('[data-file]');if(!b)return;const f=files.get(b.dataset.file);if(!f||f.status!=='included')return;const bytes=Uint8Array.from(atob(f.data),x=>x.charCodeAt(0));download(new Blob([bytes],{type:'application/octet-stream'}),f.name);};
 document.getElementById('json').onclick=()=>download(new Blob([JSON.stringify(pack)],{type:'application/json'}),'class-archive.json');
 draw();
}
function buildHtml(pack){
 const json=JSON.stringify(pack).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
 return '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;unsafe-inline&#39;; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"><title>'+escape(pack.snapshot.classInfo.name)+' 수업 보관함</title><style>body{margin:0;background:#f6f3fa;color:#393047;font:16px Arial,sans-serif}main{max-width:1100px;margin:auto;padding:30px}header,article{padding:24px;background:white;border:1px solid #e7dfee;border-radius:18px;margin-bottom:16px}h1{font-size:26px}h2{font-size:18px}p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}.meta,small{color:#81718e;font-size:13px}nav{display:flex;flex-wrap:wrap;gap:6px;margin:20px 0}button,input{border:1px solid #dacfe6;border-radius:9px;padding:10px;background:white;color:#67527b;font:inherit;cursor:pointer}.active{background:#e6d8f5}.missing{display:inline-block;color:#956144;padding:8px}input{box-sizing:border-box;width:100%;cursor:text}.note{font-size:13px;color:#766783}@media(max-width:600px){main{padding:12px}header,article{padding:18px}}</style><main><header><h1 id="title"></h1><p id="summary"></p><p class="note">인터넷 없이 열람하는 교사용 보관본입니다. 첨부 미포함 항목은 원본 파일이 들어 있지 않습니다. 학생 정보가 포함될 수 있으므로 개인 기기에 보관하세요. 온라인 자료는 삭제되지 않습니다.</p><button id="json">구조화된 JSON 내려받기</button></header><input id="query" aria-label="자료 검색" placeholder="현재 탭에서 검색"><nav id="tabs"></nav><section id="entries"></section></main><script id="archive-data" type="application/json">'+json+'</script><script>('+viewer.toString()+')();</script></html>';
}
async function prepare(raw,include,onProgress,signal){
 const pack={format:raw.format,schemaVersion:raw.schemaVersion,exportedAt:raw.exportedAt,classVersion:raw.classVersion,recordsRevision:raw.recordsRevision,snapshot:raw.snapshot,records:raw.records,files:[]};
 const total=raw.files.reduce((n,f)=>n+Number(f.size||0),0);
 if(include&&total>MAX_BYTES)throw Error('첨부 합계가 80MB를 넘습니다. 첨부 제외 HTML과 기존 활동별 ZIP 다운로드를 사용해 주세요.');
 let actualBytes=0;
 for(const f of raw.files){if(signal?.aborted)throw Error('내보내기를 취소했습니다.');const item={id:f.id,name:f.name,mimeType:f.mimeType,size:f.size,status:'omitted',reason:'첨부 제외 옵션'};if(include){try{const r=await fetch(f.downloadUrl,{signal});if(!r.ok)throw Error('HTTP '+r.status);const bytes=new Uint8Array(await r.arrayBuffer());actualBytes+=bytes.length;if(actualBytes>MAX_BYTES)throw Error('첨부 용량 제한 초과');if(bytes.length!==Number(f.size))throw Error('파일 크기 불일치');Object.assign(item,{status:'included',data:encode(bytes),sha256:await hash(bytes)});delete item.reason;}catch(e){if(signal?.aborted)throw Error('내보내기를 취소했습니다.');item.status='failed';item.reason=e.message;}}pack.files.push(item);onProgress?.(pack.files.length,raw.files.length);}
 return seal(pack);
}
function saveBlob(html,name){const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name.replace(/[\\/:*?"<>|]/g,'_')+'.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function open(classId){
 const ui=window.LearnUI, dialog=ui.modal({title:'수업 보관 파일',wide:true,closeOnBackdrop:false,html:'<p>공지·과제·보드·학생 활동·이 반의 교사 기록을 하나의 HTML에 저장합니다. 온라인 원본은 그대로 유지됩니다.</p><label><input type="checkbox" id="archive-files" checked> 첨부 원본 포함 (합계 80MB까지)</label><p class="muted-text">파일을 포함하면 인터넷 없이도 내려받을 수 있습니다. 계정 비밀번호·로그인 토큰·클래스 참여 코드는 넣지 않습니다.</p><button class="button" id="archive-start">내보내기 시작</button><button class="button secondary" id="archive-cancel" hidden>중단</button><p id="archive-progress" role="status"></p><div id="archive-result"></div><hr><h3>이전에 저장한 파일 검사</h3><input type="file" id="archive-check" accept=".html,.json"><p id="archive-check-result" role="status"></p>'});
 let controller;document.addEventListener('learn:modalclosed',()=>{if(!dialog.isConnected)controller?.abort();},{once:true});const start=dialog.querySelector('#archive-start'),status=dialog.querySelector('#archive-progress'),result=dialog.querySelector('#archive-result');
 start.onclick=async()=>{start.disabled=true;result.innerHTML='';controller=new AbortController();dialog.querySelector('#archive-cancel').hidden=false;try{status.textContent='수업 자료를 모으고 있어요…';const include=dialog.querySelector('#archive-files').checked;const raw=await window.LearnAPI.request('exportClassArchive',{classId,includeFiles:include},'teacher',0);const pack=await prepare(raw,include,(n,t)=>{status.textContent='첨부 '+n+' / '+t+'개 확인 중…';},controller.signal);const check=await verify(pack);const html=buildHtml(pack);status.textContent='자료 준비 완료 · 첨부 포함 '+check.files+'개, 미포함 '+check.missing+'개';result.innerHTML='<p>'+ (check.missing?'첨부가 빠진 항목이 있습니다. 이 파일을 전체 백업 완료로 간주하지 마세요.':'첨부 원본과 자료 무결성 검사를 통과했습니다.')+'</p><button class="button" id="archive-download">HTML 저장</button><p>이 파일은 열람용 보관본입니다. 운영 DB를 되돌리는 복원 기능은 포함하지 않습니다.</p>';result.querySelector('#archive-download').onclick=()=>saveBlob(html,pack.snapshot.classInfo.name+'_수업보관_'+pack.exportedAt.slice(0,10));}catch(e){status.textContent=e.message;}finally{start.disabled=false;dialog.querySelector('#archive-cancel').hidden=true;}};
 dialog.querySelector('#archive-cancel').onclick=()=>controller?.abort();
 dialog.querySelector('#archive-check').onchange=async e=>{const output=dialog.querySelector('#archive-check-result');try{const file=e.target.files[0];if(!file)return;if(file.size>MAX_HTML_BYTES)throw Error('120MB 이하 파일을 선택해 주세요.');const text=await file.text();let pack;if(file.name.endsWith('.json'))pack=JSON.parse(text);else{const match=text.match(/<script id="archive-data" type="application\/json">([\s\S]*?)<\/script>/);pack=JSON.parse(match?match[1]:'null');}const r=await verify(pack);output.textContent='검사 통과 · '+pack.snapshot.classInfo.name+' · 첨부 포함 '+r.files+'개 / 미포함 '+r.missing+'개. 이 검사는 파일 내부 무결성 확인이며 DB 복원 검증이 아닙니다.';}catch(e){output.textContent=e.message;}};
}
window.LearnArchive={open,prepare,verify,buildHtml};
})();
