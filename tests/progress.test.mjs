import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const window = {};
vm.runInNewContext(await readFile(new URL('../public/progress.js', import.meta.url), 'utf8'), { window });
const assignments = [
  { id: 'a1', status: 'open' },
  { id: 'a2', status: 'closed' },
  { id: 'a3', status: 'open' }
];
const submissions = [
  { id: 's1', assignmentId: 'a1', studentId: 'student-a' },
  { id: 's2', assignmentId: 'a2', studentId: 'student-a' },
  { id: 's3', assignmentId: 'a3', studentId: 'student-b' }
];
const own = window.LearnProgress.forStudent(assignments, submissions, 'student-a');
assert.deepEqual({ total: own.total, submitted: own.submitted, pending: own.pending, percent: own.percent },
  { total: 3, submitted: 2, pending: 1, percent: 67 });
assert.equal(own.entries[2].submitted, false, 'classmate submissions do not affect the current student status');
const classProgress = window.LearnProgress.forClass(assignments, submissions, [
  { id: 'student-a', number: 1 }, { id: 'student-b', number: 2 }
]);
assert.deepEqual(classProgress.students.map((row) => [row.submitted, row.pending, row.percent]), [[2, 1, 67], [1, 2, 33]]);
assert.equal(classProgress.assignments, 3);
assert.equal(classProgress.submitted, 3);
assert.equal(classProgress.pending, 3);
console.log('PASS: private student progress, teacher per-student progress, and stable aggregate counts.');
const data={boards:[{id:'b',title:'Board',status:'open'}],ideas:[{id:'i',title:'Idea',status:'open'}],boardPosts:[{studentId:'student-a',boardId:'b',status:'revision'}],ideaPosts:[{mine:true,ideaId:'i'},{mine:false,ideaId:'i'}]};
const activities=window.LearnProgress.activity(data,'student-a',true);assert.equal(activities[0].participated,1);assert.equal(activities[0].entries[0].revision,true);assert.equal(activities[1].participated,1);assert.equal(window.LearnProgress.activity(data,'student-b',false)[0].participated,0);assert.equal(window.LearnProgress.activity(data,'student-b',false)[1].participated,0);
console.log('PASS: board review and anonymous own-idea progress reuse snapshots without attributing classmates or adding requests.');
