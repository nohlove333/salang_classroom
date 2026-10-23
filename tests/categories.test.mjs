import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const ctx=vm.createContext({window:{LearnUI:{escape:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}}});vm.runInContext(await readFile(new URL('../public/categories.js',import.meta.url),'utf8'),ctx);const c=ctx.window.LearnCategories;
assert.deepEqual(Array.from(c.paths(['사회 / 정치 / 선거','사회 / 경제'])),['사회','사회 / 정치','사회 / 정치 / 선거','사회 / 경제']);
assert.equal(c.matches('사회 / 정치 / 선거','사회'),true);assert.equal(c.matches('사회학','사회'),false);assert.equal(c.matches('도덕','all'),true);
const html=c.html(['사회 / 정치','<img src=x>'],'사회 / 정치');assert.ok(html.includes('<details open>'));assert.ok(!html.includes('<img src=x>'));assert.ok(html.includes('&lt;img src=x&gt;'));
console.log('PASS: shared nested category paths, descendant filtering, exact sibling boundaries and escaped tree output.');
