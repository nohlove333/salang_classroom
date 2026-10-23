import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.window = {};
const source = await readFile(new URL('../public/grouping.js', import.meta.url), 'utf8');
await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const students = Array.from({ length: 30 }, (_, index) => ({
  id: 'student-' + (index + 1), number: index + 1, name: '학생 ' + (index + 1)
}));
const groups = window.LearnGroups.create(students, 4, [3, 8, 14], () => 0.42);
assert.equal(groups.length, 8, '30 students with groups of four produce eight groups');
assert.ok(groups.every((group) => group.students.length <= 4), 'no group exceeds the chosen size');
assert.ok(Math.max(...groups.map((group) => group.students.length)) - Math.min(...groups.map((group) => group.students.length)) <= 1,
  'group sizes differ by no more than one');
for (const number of [3, 8, 14]) {
  assert.equal(groups.filter((group) => group.students.some((student) => student.number === number)).length, 1,
    'every required student is assigned exactly once');
}
assert.equal(groups.filter((group) => group.students.some((student) => student.number === 3 || student.number === 8 || student.number === 14)).length, 3,
  'students marked to separate are placed in distinct groups');
assert.equal(new Set(groups.flatMap((group) => group.students.map((student) => student.id))).size, 30,
  'all students appear exactly once');
assert.throws(() => window.LearnGroups.create(students, 1, []), /2~12명/);
assert.throws(() => window.LearnGroups.create(students, 4, [3, 3]), /중복/);
assert.throws(() => window.LearnGroups.create(students, 4, [99]), /등록된 학생/);
assert.throws(() => window.LearnGroups.create(students, 12, [1, 2, 3, 4]), /모둠 수보다 많아요/);
console.log('PASS: conditional random grouping, balanced sizes, unique assignments, separated students, and invalid inputs.');
