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

db.prepare('INSERT INTO classes(id,teacher_id,name,code,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('c','a','기존 반','PRIVATE-CODE',new Date().toISOString(),new Date().toISOString());
db.prepare('INSERT INTO contents(id,class_id,type,title,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('notice','c','announcement','공지','원문',new Date().toISOString(),new Date().toISOString());
await call('workspaceGet');
await call('workspaceSave',{kind:'records',revision:0,value:[{id:'record',classId:'c',date:'2026-10-24',title:'기록',body:'교사만'}]});
const archive=await call('exportClassArchive',{classId:'c',includeFiles:false});
assert.equal(archive.snapshot.announcements[0].body,'원문');
assert.equal(archive.snapshot.classInfo.code,undefined);
assert.equal(archive.records[0].body,'교사만');
assert.equal(archive.format,'learn-class-archive');
assert.ok(!JSON.stringify(archive).includes('PRIVATE-CODE'));
await call('exportClassArchive',{classId:'c'},'b',404);
await call('exportClassArchive',{classId:'c'},'s',401);
assert.equal(db.prepare('SELECT count(*) n FROM contents').get().n,1);
assert.equal(db.prepare('SELECT count(*) n FROM classes').get().n,1);
console.log('PASS: archive includes class content and only linked owner records; no class code; other teacher/student rejected; original rows unchanged.');
