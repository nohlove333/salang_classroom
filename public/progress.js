(function () {
  'use strict';

  function forStudent(assignments, submissions, studentId) {
    var ownSubmissions = (submissions || []).filter(function (item) { return item.studentId === studentId; });
    var submittedIds = new Set(ownSubmissions.map(function (item) { return item.assignmentId; }));
    var entries = (assignments || []).map(function (assignment) {
      return { assignment: assignment, submitted: submittedIds.has(assignment.id) };
    });
    var submitted = entries.filter(function (entry) { return entry.submitted; }).length;
    return { total: entries.length, submitted: submitted, pending: entries.length - submitted,
      percent: entries.length ? Math.round(submitted / entries.length * 100) : 0, entries: entries };
  }

  function forClass(assignments, submissions, students) {
    var studentRows = (students || []).map(function (student) {
      var own = forStudent(assignments, submissions, student.id);
      return { student: student, total: own.total, submitted: own.submitted, pending: own.pending,
        percent: own.percent };
    });
    return {
      students: studentRows,
      assignments: (assignments || []).length,
      submitted: studentRows.reduce(function (sum, row) { return sum + row.submitted; }, 0),
      pending: studentRows.reduce(function (sum, row) { return sum + row.pending; }, 0)
    };
  }

  function activity(data,studentId,studentView){
    return [['boards','boardPosts','boardId','보드'],['ideas','ideaPosts','ideaId','아이디어']].map(function(spec){
      var posts=(data[spec[1]]||[]).filter(function(p){return p.studentId===studentId||(studentView&&spec[0]==='ideas'&&p.mine===true);});
      var entries=(data[spec[0]]||[]).map(function(item){var own=posts.filter(function(p){return p[spec[2]]===item.id;});return {id:item.id,title:item.title,participated:own.length>0,revision:own.some(function(p){return p.status==='revision';}),closed:item.status!=='open'};});
      return {kind:spec[0],label:spec[3],entries:entries,total:entries.length,participated:entries.filter(function(e){return e.participated;}).length};
    });
  }
  window.LearnProgress = { forStudent: forStudent, forClass: forClass, activity:activity };
})();
