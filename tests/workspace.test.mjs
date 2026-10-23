import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
const source=(await readFile(new URL('../worker/index.js',import.meta.url),'utf8')).replace("import qrcode from 'qrcode-generator';",'const qrcode = null;');
const mod=await import('data:text/javascript;base64,'+Buffer.from(source+'\nexport {SCHEMA,tokenCipher,saveGoogleToken};').toString('base64'));
const db=new DatabaseSync(':memory:');db.exec(mod.SCHEMA);
const log=[];function prepare(sql,args=[]){return {bind:(...a)=>prepare(sql,a),async first(){log.push(sql);return db.prepare(sql).get(...args)||null;},async all(){log.push(sql);return {results:db.prepare(sql).all(...args)};},async run(){log.push(sql);const r=db.prepare(sql).run(...args);return {meta:{changes:r.changes}};}};}
const env={DB:{prepare,batch:async s=>Promise.all(s.map(x=>x.run()))},GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test',GOOGLE_REDIRECT_URI:'https://local.test/api/calendar/callback',CALENDAR_TOKEN_KEY:Buffer.alloc(32,5).toString('base64url')};
for(const id of ['a','b'])db.prepare('INSERT INTO teachers VALUES(?,?,?,?,?,?)').run(id,id+'@test.invalid',id,'x','x',new Date().toISOString());
for(const [token,role,user] of [['a','teacher','a'],['b','teacher','b'],['s','student','s']]){const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(hash,role,user,'',new Date(Date.now()+86400000).toISOString(),new Date().toISOString());}
async function call(action,payload={},token='a',status=200){const r=await mod.default.fetch(new Request('https://local.test/api',{method:'POST',body:JSON.stringify({action,payload,token})}),env);const body=await r.json();assert.equal(r.status,status,JSON.stringify(body));return body.data||body;}
assert.deepEqual((await call('workspaceGet')).documents,{});
await call('workspaceGet',{},'s',401);
assert.equal((await call('workspaceSave',{kind:'notes',value:'private',revision:0})).revision,1);
await call('workspaceSave',{kind:'notes',value:'lost edit',revision:0},'a',409);
assert.equal((await call('workspaceSave',{kind:'notes',value:'second',revision:1})).revision,2);
assert.deepEqual((await call('workspaceGet',{},'b')).documents,{});
assert.equal((await call('workspaceGet')).documents.notes.value,'second');
await call('workspaceSave',{kind:'timetable',value:{week:[],exceptions:[]},revision:0});
await call('workspaceSave',{kind:'other',value:''},'a',400);
const auth=await call('calendarConnect');assert.ok(auth.url.includes('code_challenge='));assert.ok(auth.url.includes('calendar.events'));
await mod.saveGoogleToken(env,'a',{access_token:'ACCESS-SECRET',refresh_token:'REFRESH-SECRET',expires:Date.now()+3600000});
const encrypted=db.prepare('SELECT encrypted FROM calendar_connections').get().encrypted;assert.ok(!encrypted.includes('SECRET'));
await assert.rejects(()=>mod.tokenCipher(env,encrypted,true,'b'));
let sent=[];globalThis.fetch=async(url,opts)=>{sent.push({url,opts});if(opts.method==='PATCH')return new Response('{}',{status:412});if(opts.method==='POST')return new Response('{}',{status:409});if(url.includes('syncToken=expired'))return new Response('{}',{status:410});return new Response(JSON.stringify({id:'1234567890abcdef1234567890abcdef',items:[]}));};
await call('calendarEvents',{calendarId:'x',start:'2026-10-01',end:'2026-11-01'});
await call('calendarEvents',{calendarId:'x',syncToken:'expired'},'a',410);
await call('calendarEventSave',{calendarId:'x',id:'event',etag:'"v1"',event:{summary:'x',start:{date:'2026-10-01'},end:{date:'2026-10-02'}}},'a',409);
assert.equal(sent.at(-1).opts.headers['If-Match'],'"v1"');
await call('calendarEventDelete',{id:'event'},'a',409);
await call('calendarEventSave',{calendarId:'x',operationId:'1234567890abcdef1234567890abcdef',event:{summary:'x',start:{date:'2026-10-01'},end:{date:'2026-10-02'}}});
assert.ok(sent.at(-1).url.endsWith('/1234567890abcdef1234567890abcdef'));
await call('calendarEvents',{start:'2026-01-01',end:'2026-12-01'},'a',400);
assert.ok(!log.some(s=>/INSERT.*events/i.test(s)));
await call('calendarDisconnect');assert.equal((await call('workspaceGet')).calendar.connected,false);
assert.equal((await call('workspaceGet')).documents.notes.value,'second');
console.log('PASS: owner isolation, student rejection, optimistic revision conflicts, encrypted Google tokens, AAD ownership, PKCE, bounded queries, ETag conflicts, idempotent creation retry, 410 handling and disconnect preserves records.');
