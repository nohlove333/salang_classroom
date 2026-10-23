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

await call('manageCategory',{classId:'c',operation:'add',path:'사회 / 정치 / 선거'});
db.prepare('UPDATE contents SET category=? WHERE id=?').run('사회 / 정치 / 선거','notice');
const snapshot=await call('getTeacherClass',{classId:'c'});assert.ok(snapshot.categories.some(x=>x.path==='사회 / 정치 / 선거'));
await call('manageCategory',{classId:'c',operation:'rename',path:'사회 / 정치',target:'도덕 / 참여'});
assert.equal(db.prepare('SELECT category FROM contents WHERE id=?').get('notice').category,'도덕 / 참여 / 선거');
await call('manageCategory',{classId:'c',operation:'rename',path:'도덕',target:'도덕 / 순환'},'a',400);
await call('manageCategory',{classId:'c',operation:'add',path:'타인'},'b',404);
await call('manageCategory',{classId:'c',operation:'add',path:'타인'},'s',401);
await call('manageCategory',{classId:'c',operation:'add',path:'새 빈 분류'});
await call('manageCategory',{classId:'c',operation:'order',path:'새 빈 분류',order:['새 빈 분류','도덕','도덕 / 참여','도덕 / 참여 / 선거']});
assert.equal((await call('getTeacherClass',{classId:'c'})).categories[0].path,'새 빈 분류');
await call('manageCategory',{classId:'c',operation:'delete',path:'도덕'});
assert.equal(db.prepare('SELECT body FROM contents WHERE id=?').get('notice').body,'원문');assert.equal(db.prepare('SELECT category FROM contents WHERE id=?').get('notice').category,'');
await call('manageCategory',{scope:'resources',operation:'add',path:'수업 / 링크'});
assert.ok((await call('getTeacherResources')).categories.includes('수업 / 링크'));
assert.ok(!(await call('getTeacherResources',{},'b')).categories.includes('수업 / 링크'));
console.log('PASS: empty category creation, inherited paths, subtree rename/move, order, cycle rejection, owner/student isolation, category removal preserves content, resource scope isolation.');
