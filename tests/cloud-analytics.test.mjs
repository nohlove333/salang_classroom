import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../worker/index.js',import.meta.url),'utf8')).replace("import qrcode from 'qrcode-generator';",'const qrcode=null;');
const {cloudUsage}=await import('data:text/javascript;base64,'+Buffer.from(source+'\nexport {cloudUsage};').toString('base64'));
const owner={user_id:'owner'},env={OWNER_TEACHER_ID:'owner',CF_ANALYTICS_ACCOUNT_ID:'account',CF_ANALYTICS_TOKEN:'secret'};
let calls=[];const original=globalThis.fetch;
globalThis.fetch=async(url,opts)=>{assert.equal(url,'https://api.cloudflare.com/client/v4/graphql');const body=JSON.parse(opts.body);calls.push(body);assert.equal(body.variables.account,'account');const node=/accounts\(filter:\{accountTag:\$account\}\)\{(\w+)\(/.exec(body.query)[1];let rows;
if(node==='d1StorageAdaptiveGroups')rows=[{dimensions:{databaseId:'db1'},max:{databaseSizeBytes:200}},{dimensions:{databaseId:'db2'},max:{databaseSizeBytes:500}}];
else if(node==='r2StorageAdaptiveGroups')rows=[{dimensions:{bucketName:'bucket'},max:{payloadSize:100,metadataSize:5,objectCount:2}}];
else if(node==='r2OperationsAdaptiveGroups'&&body.query.includes('actionType'))rows=[{dimensions:{actionType:'GetObject'},sum:{requests:100}}];
else if(node==='durableObjectsStorageGroups')return Response.json({errors:[{message:'not permitted'}]});
else if(body.query.includes('quantiles'))rows=[{sum:{cpuTime:30},quantiles:{cpuTimeP50:5,cpuTimeP99:10}}];
else rows=[{sum:node==='d1AnalyticsAdaptiveGroups'?{rowsRead:4500000,rowsWritten:100,readQueries:30}: {requests:80000,errors:2}}];
return Response.json({data:{viewer:{accounts:[{[node]:rows}]}}});};
try{
await assert.rejects(()=>cloudUsage(env,{user_id:'other'}),e=>e.status===403||e.code==='FORBIDDEN');assert.equal(calls.length,0);
await assert.rejects(()=>cloudUsage(env,owner,{period:'year'}));
const [a,b]=await Promise.all([cloudUsage(env,owner,{details:true}),cloudUsage(env,owner,{details:true})]);assert.equal(calls.length,10,'coalesce identical concurrent profile');assert.equal(a.products.length,10);assert.deepEqual(a,b);
assert.equal(a.products.find(p=>p.name==='D1 저장공간').breakdown.length,2);assert.deepEqual(a.products.find(p=>p.name==='D1 저장공간').values,{});assert.equal(a.products.find(p=>p.name==='DO 저장공간').available,false);assert.equal(a.references.find(x=>x.field==='rowsRead').percent,90);
const month=await cloudUsage(env,owner,{period:'month',details:true});assert.equal(calls.length,20);assert.equal(month.references.length,0);assert.equal(month.start.slice(8,10),'01');
const site=await cloudUsage(env,owner,{scope:'site',details:true});assert.equal(calls.length,22);assert.equal(site.products.find(p=>p.name==='D1').available,false);assert.ok(calls.slice(20).every(x=>x.query.includes('scriptName:"salang-classroom"')));
env.CF_METRICS_D1_ID='db"quoted';env.CF_METRICS_R2_BUCKET='bucket';env.CF_METRICS_DO_ID='namespace';await cloudUsage(env,owner,{scope:'site',details:true});assert.equal(calls.length,32);assert.ok(calls.some(x=>x.query.includes('databaseId:"db\\"quoted"')));assert.ok(!JSON.stringify(a).includes('secret'));
console.log('PASS: owner gate, daily/monthly/site isolation, shared request cache, resource filters with escaped values, no account fallback, storage per-resource maxima, partial errors, reference quota labels.');
}finally{globalThis.fetch=original;}
