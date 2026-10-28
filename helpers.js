'use strict';
// Small helpers used only by the seed files to keep the exam content readable.

function mcq(prefix, num, prompt, options, answer, marks = 1) {
  const ids = ['A', 'B', 'C', 'D'];
  return {
    id: prefix + num, num, type: 'mcq', prompt, marks,
    options: options.map((text, i) => ({ id: ids[i], text })),
    answer,
  };
}

function bank(prefix, num, prompt, answer, hint) {
  const q = { id: prefix + num, num, type: 'bank', prompt, marks: 1, answer };
  if (hint) q.hint = hint;
  return q;
}

module.exports = { mcq, bank };
