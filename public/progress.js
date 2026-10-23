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

  window.LearnProgress = { forStudent: forStudent, forClass: forClass };
})();
