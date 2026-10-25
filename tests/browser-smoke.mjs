import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
import http from 'node:http';import fs from 'node:fs/promises';import path from 'node:path';
const dir=new URL('../public',import.meta.url).pathname;
const server=http.createServer(async(req,res)=>{try{const f=path.join(dir,new URL(req.url,'http://test').pathname);const body=await fs.readFile(f.endsWith('/')?f+'index.html':f);res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':f.endsWith('.jpg')?'image/jpeg':'text/html');res.end(body);}catch{res.statusCode=404;res.end();}}).listen(8123,'127.0.0.1');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});let errors=[];page.on('pageerror',e=>errors.push(e.message));
if(process.env.SUITE_FONT_FILE){await page.route('https://cdn.jsdelivr.net/**/SUITE-Variable.css',r=>r.fulfill({contentType:'text/css',body:"@font-face{font-family:'SUITE Variable';font-weight:300 900;src:url('https://cdn.jsdelivr.net/SUITE-Variable.woff2')}"}));await page.route('https://cdn.jsdelivr.net/SUITE-Variable.woff2',r=>r.fulfill({contentType:'font/woff2',path:process.env.SUITE_FONT_FILE}));}
await page.addInitScript(()=>{localStorage.setItem('learn_teacher_session_v1',JSON.stringify({token:'test-teacher',teacher:{id:'t',name:'테스트 교사'}}));});
let cloudConnected=false,cloudPayload;
let documents={settings:{revision:1,value:{}},timetable:{revision:1,value:{week:[{id:'lesson',day:1,period:1,start:'09:00',end:'09:45',subject:'국어',classId:'c',className:'테스트 반',room:'1반'}],exceptions:[]}},records:{revision:1,value:[]}};
await page.route('**/api',async route=>{const {action,payload}=route.request().postDataJSON();let data;
if(action==='workspaceGet')data={documents,classes:[{id:'c',name:'테스트 반'}],calendar:{configured:false,connected:false},upcoming:[],pending:[]};
else if(action==='workspaceSave'){documents[payload.kind]={value:payload.value,revision:(documents[payload.kind]?.revision||0)+1};data={revision:documents[payload.kind].revision};}
else if(action==='opsOverview')data={classes:[{id:'c',name:'테스트 반',status:'active',backup_enabled:0}],backups:[],jobs:[],storage:{usedBytes:0},role:'owner'};
else if(action==='opsCloudUsage'){cloudPayload=payload;data=cloudConnected?{connected:true,scope:'이 사이트 · 이번 달',fetchedAt:new Date().toISOString(),note:'실제 청구는 대시보드에서 확인',products:[{name:'R2 저장공간',available:true,values:{},breakdown:[{name:'<script>resource</script>'+ 'long'.repeat(40),values:{payloadSize:1048576}}],note:'기간 최대치'}]}:{connected:false,reason:'서버 연결 후 사용 가능합니다.'};}
else data={};
await route.fulfill({json:{ok:true,data}});});
await page.goto('http://127.0.0.1:8123/#/teacher');await page.locator('.work-shell').waitFor();
await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'/tmp/salang-desktop.png',fullPage:true});
assert.equal(await page.locator('.work-brand img').getAttribute('src'),'./brand-logo.jpg?v=8');
await page.getByRole('button',{name:'사이드바 접기 펼치기'}).click();await page.locator('.work-shell.is-collapsed').waitFor();await page.getByRole('button',{name:'사이드바 접기 펼치기'}).click();await page.locator('.work-shell:not(.is-collapsed)').waitFor();
console.log('desktop',await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,logos:[...document.images].map(i=>({src:i.src,width:i.naturalWidth})),font:getComputedStyle(document.querySelector('.work-shell')).fontFamily})));
for(const width of [768,390]){await page.setViewportSize({width,height:900});await page.screenshot({path:`/tmp/salang-${width}.png`,fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);}
await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:8123/#/teacher/timetable');await page.getByRole('button',{name:'+ 특별 시간표'}).click();await page.setViewportSize({width:390,height:900});await page.getByRole('button',{name:'교시 / 보강 추가'}).click();await page.screenshot({path:'/tmp/salang-modal.png'});console.log('modal-overflow',await page.locator('.modal').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth,wide:[...e.querySelectorAll('*')].filter(x=>x.getBoundingClientRect().right>390).map(x=>[x.tagName,x.className,x.getBoundingClientRect().width])})));assert.ok(await page.locator('.modal').evaluate(e=>e.scrollWidth<=e.clientWidth+1));await page.locator('[name=subject0]').fill('보강');await page.locator('[name=classId0]').selectOption('c');await page.locator('[name=room0]').fill('과학실');await page.getByRole('button',{name:'저장',exact:true}).click();await page.locator('.modal').waitFor({state:'detached'});console.log('exception',JSON.stringify(documents.timetable.value.exceptions));
await page.goto('http://127.0.0.1:8123/#/teacher/admin');await page.getByRole('button',{name:'연결된 Cloudflare 전체 사용량 조회'}).click();await page.getByText('서버 연결 후 사용 가능합니다.').waitFor();

cloudConnected=true;await page.locator('[name=scope]').selectOption('site');await page.locator('[name=period]').selectOption('month');await page.getByRole('button',{name:'조회',exact:true}).click();await page.getByText('R2 저장공간',{exact:true}).waitFor();assert.deepEqual(cloudPayload,{scope:'site',period:'month',details:true});await page.locator('.modal summary').click();assert.ok((await page.locator('.modal').innerText()).includes('<script>resource</script>'));assert.equal(await page.locator('.modal script').count(),0);await page.setViewportSize({width:390,height:900});assert.ok(await page.locator('.modal').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
await page.evaluate(()=>window.LearnUI.closeModal());
// Test the real browser IndexedDB path with a student-session namespace and explicit restoration.
async function fileForm(){await page.evaluate(async()=>{
 window.LearnSession.set('student',{token:'test-student',student:{id:'s'}});
 const m=window.LearnUI.modal({title:'첨부 초안 테스트',html:'<form><input name="title"><input type="file" data-file-input><div data-selected-files></div><button>저장</button></form>'});
 window.fixturePicker=window.LearnUI.filePicker(m,[]);
 await window.LearnDrafts.attach(m,{key:'fixture-files',actions:['upsertSubmission']});
 });}
await page.goto('http://127.0.0.1:8123/#/teacher/records');await page.locator('.work-shell').waitFor();
// route determines namespace; replace hash without app navigation, then render only the test form.
await page.evaluate(()=>history.replaceState(null,'','#/student/class/assignments'));
await fileForm();await page.locator('[data-file-input]').setInputFiles({name:'offline.txt',mimeType:'text/plain',buffer:Buffer.from('offline draft bytes')});
await page.getByText('선택한 파일도 이 기기에 7일간 보관했습니다.',{exact:false}).waitFor();
await page.evaluate(()=>window.LearnUI.closeModal());await fileForm();await page.getByRole('button',{name:'첨부 초안 복원'}).click();
assert.equal(await page.evaluate(async()=>await window.fixturePicker.files()[0].text()),'offline draft bytes');
// Changes made while the upload/API is pending must survive completion of the older request.
await page.evaluate(()=>{window.LearnFileDrafts.prepare(window.fixturePicker.files());window.pendingDraft=window.LearnDrafts.begin('upsertSubmission');});
await page.locator('[data-file-input]').setInputFiles({name:'new.txt',mimeType:'text/plain',buffer:Buffer.from('new changes')});
await page.evaluate(()=>window.LearnDrafts.complete(window.pendingDraft));await page.evaluate(()=>window.fixturePicker.fileDraft.tail);
await page.evaluate(()=>window.LearnUI.closeModal());await fileForm();await page.getByRole('button',{name:'첨부 초안 복원'}).click();assert.equal(await page.evaluate(()=>window.fixturePicker.files().length),2);
await page.evaluate(()=>{window.LearnFileDrafts.prepare(window.fixturePicker.files());window.LearnDrafts.complete(window.LearnDrafts.begin('upsertSubmission'));});await page.evaluate(()=>window.fixturePicker.fileDraft.tail);
await page.evaluate(()=>window.LearnUI.closeModal());await fileForm();assert.equal(await page.getByRole('button',{name:'첨부 초안 복원'}).count(),0);
assert.deepEqual(errors,[]);console.log('PASS: actual Chromium desktop/tablet/mobile widths, canonical logo/font, special lesson add/class/room/save, disconnected analytics, IndexedDB file recovery, save-race protection. Mock API fixture; no production account data.');
await browser.close();server.close();

