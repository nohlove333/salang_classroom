(function () {
  function createGroups(students, groupSize, separatedNumbers, random) {
    var list = (students || []).slice();
    var size = Number(groupSize);
    if (!Number.isInteger(size) || size < 2 || size > 12) throw new Error('모둠당 인원은 2~12명으로 정해 주세요.');
    if (list.length < 2) throw new Error('모둠을 만들 학생이 2명 이상 필요해요.');
    var byNumber = new Map(list.map(function (student) { return [Number(student.number), student]; }));
    var selected = (separatedNumbers || []).map(Number);
    if (new Set(selected).size !== selected.length) throw new Error('서로 다른 모둠에 둘 번호가 중복되어 있어요.');
    if (selected.some(function (number) { return !byNumber.has(number); })) throw new Error('등록된 학생 번호를 확인해 주세요.');
    var count = Math.ceil(list.length / size);
    if (selected.length > count) throw new Error('서로 다른 모둠에 둘 학생 수가 모둠 수보다 많아요. 모둠당 인원을 늘려 주세요.');
    var rng = typeof random === 'function' ? random : Math.random;
    function shuffle(items) {
      var result = items.slice();
      for (var i = result.length - 1; i > 0; i -= 1) {
        var j = Math.floor(rng() * (i + 1));
        var swap = result[i]; result[i] = result[j]; result[j] = swap;
      }
      return result;
    }
    var groups = Array.from({ length: count }, function (_, index) { return { name: (index + 1) + '모둠', students: [] }; });
    var anchors = shuffle(selected.map(function (number) { return byNumber.get(number); }));
    anchors.forEach(function (student, index) { groups[index].students.push(student); });
    var anchorIds = new Set(anchors.map(function (student) { return student.id; }));
    shuffle(list.filter(function (student) { return !anchorIds.has(student.id); })).forEach(function (student) {
      var smallest = Math.min.apply(null, groups.map(function (group) { return group.students.length; }));
      var eligible = groups.filter(function (group) { return group.students.length === smallest && group.students.length < size; });
      eligible[Math.floor(rng() * eligible.length)].students.push(student);
    });
    return groups;
  }
  window.LearnGroups = { create: createGroups };
})();
