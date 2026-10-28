'use strict';
const crypto = require('crypto');

const LEVELS = {
  Lower: ['JSS1'],
  Upper: ['JSS2', 'JSS3'],
  Advanced: ['SSS1', 'SSS2', 'SSS3'],
};

const hash = (obj) => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 10);

function allQuestions(content) {
  const out = [];
  for (const s of content.sections || []) for (const q of s.questions || []) out.push({ ...q, section: s.id, group: s.group });
  return out;
}

function questionVersion(q) {
  return hash({ prompt: q.prompt, context: q.context, options: q.options, type: q.type, marks: q.marks });
}
function schemeVersion(q) {
  return hash({ answer: q.answer, scheme: q.scheme });
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

// Returns { errors: [], warnings: [] }. A test can be published only when errors is empty.
function validate(content) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m);
  if (!content || typeof content !== 'object') return { errors: ['Content is not an object.'], warnings };
  if (!content.subject) err('Missing subject.');
  if (!LEVELS[content.level]) err(`Level must be one of ${Object.keys(LEVELS).join(', ')}.`);
  if (!Array.isArray(content.classes) || !content.classes.length) err('No classes listed.');
  else for (const c of content.classes) if (!(LEVELS[content.level] || []).includes(c)) err(`Class ${c} does not belong to level ${content.level}.`);
  if (content.durationMinutes !== 90) err('Duration must be 90 minutes (1 hour 30 minutes).');
  const groups = content.groups || [];
  if (!groups.length) err('No scoring groups defined.');
  const weightSum = groups.reduce((s, g) => s + Number(g.weight || 0), 0);
  if (!near(weightSum, 40)) err(`Scoring group weights add up to ${weightSum}, not 40.`);
  const groupRaw = Object.fromEntries(groups.map((g) => [g.id, 0]));
  const ids = new Set();
  const passages = content.passages || {};
  for (const s of content.sections || []) {
    if (!(s.group in groupRaw)) err(`Section ${s.id}: unknown scoring group “${s.group}”.`);
    if (s.passage && !passages[s.passage]) err(`Section ${s.id}: passage “${s.passage}” is missing.`);
    if (s.passage && passages[s.passage] && !(passages[s.passage].paragraphs || []).length) err(`Passage “${s.passage}” has no text.`);
    if (!(s.questions || []).length) err(`Section ${s.id} has no questions.`);
    const bankAnswers = [];
    for (const q of s.questions || []) {
      const where = `Question ${q.num ?? q.id}`;
      if (!q.id) { err(`${where}: missing id.`); continue; }
      if (ids.has(q.id)) err(`${where}: duplicate id ${q.id}.`);
      ids.add(q.id);
      if (!q.prompt || !String(q.prompt).trim()) err(`${where}: missing question text.`);
      if (!(Number(q.marks) > 0)) err(`${where}: marks must be greater than 0.`);
      if (s.group in groupRaw) groupRaw[s.group] += Number(q.marks || 0);
      if (q.type === 'mcq') {
        if (!Array.isArray(q.options) || q.options.length < 2) err(`${where}: needs at least two options.`);
        else if ((q.options || []).some((o) => !o.text || !String(o.text).trim())) err(`${where}: an option has no text.`);
        if (!q.answer) err(`${where}: missing answer key.`);
        else if (!(q.options || []).some((o) => o.id === q.answer)) err(`${where}: answer key “${q.answer}” is not one of the options.`);
      } else if (q.type === 'bank') {
        if (!Array.isArray(s.bank) || !s.bank.length) err(`${where}: section has no word bank.`);
        if (!q.answer) err(`${where}: missing answer key.`);
        else if (!(s.bank || []).includes(q.answer)) err(`${where}: answer “${q.answer}” is not in the word bank.`);
        if (!String(q.prompt).includes('[____]')) err(`${where}: prompt needs a [____] blank.`);
        bankAnswers.push(q.answer);
      } else if (q.type === 'short') {
        const sc = q.scheme;
        if (!sc || !Array.isArray(sc.criteria) || !sc.criteria.length) err(`${where}: missing mark scheme criteria.`);
        else {
          const sum = sc.criteria.reduce((a, c) => a + Number(c.marks || 0), 0);
          if (!near(sum, Number(q.marks))) err(`${where}: criterion marks add up to ${sum}, not ${q.marks}.`);
          for (const c of sc.criteria) {
            if (!c.expected) err(`${where}: criterion “${c.id}” has no expected answer.`);
            if (!c.rule || !c.rule.kind) err(`${where}: criterion “${c.id}” has no marking rule.`);
            else if (c.rule.kind === 'category' && !(c.rule.accept || []).length) err(`${where}: criterion “${c.id}” lists no acceptable names.`);
            else if (c.rule.kind === 'function' && (!(c.rule.roles || []).length || !(c.rule.targets || []).length)) err(`${where}: criterion “${c.id}” needs roles and target words.`);
            else if (c.rule.kind === 'clause' && !c.rule.text) err(`${where}: criterion “${c.id}” has no clause text.`);
            else if (c.rule.kind === 'subtype' && (!(c.rule.accept || []).length || !(c.rule.requires || []).length)) err(`${where}: criterion “${c.id}” needs accepted types and clause names.`);
          }
          if (!sc.partialCredit) warnings.push(`${where}: no partial-credit rule written.`);
        }
      } else if (q.type === 'essay') {
        const sc = q.scheme;
        if (!sc || !Array.isArray(sc.criteria) || !sc.criteria.length) err(`${where}: missing mark scheme criteria.`);
        else {
          const sum = sc.criteria.reduce((a, c) => a + Number(c.marks || 0), 0);
          if (!near(sum, Number(q.marks))) err(`${where}: criterion marks add up to ${sum}, not ${q.marks}.`);
          for (const c of sc.criteria) if (!c.descriptor) err(`${where}: criterion “${c.name || c.id}” has no descriptor.`);
          if (sc.status !== 'approved') err(`${where}: mark scheme is a draft and must be approved by a teacher.`);
          if (!sc.partialCredit) warnings.push(`${where}: no partial-credit rule written.`);
        }
      } else err(`${where}: unsupported question type “${q.type}”.`);
    }
    if (bankAnswers.length && new Set(bankAnswers).size !== bankAnswers.length) err(`Section ${s.id}: a word-bank answer is used more than once, but each word may be used only once.`);
  }
  for (const g of groups) if (!near(groupRaw[g.id], Number(g.rawMax))) err(`Scoring group “${g.title}”: questions total ${groupRaw[g.id]} marks but raw maximum is ${g.rawMax}.`);
  return { errors, warnings };
}

// What the student's browser receives: questions and passages only. Never answer keys or schemes.
function publicView(content) {
  return {
    subject: content.subject,
    title: content.title,
    level: content.level,
    durationMinutes: content.durationMinutes,
    interactive: !!content.interactive,
    instructions: content.instructions || [],
    passages: Object.fromEntries(Object.entries(content.passages || {}).map(([k, p]) => [k, { title: p.title, paragraphs: p.paragraphs, html: !!p.html }])),
    sections: (content.sections || []).map((s) => ({
      id: s.id, title: s.title, instructions: s.instructions, passage: s.passage || null,
      bank: s.bank ? [...s.bank] : null,
      questions: s.questions.map((q) => {
        const pq = { id: q.id, num: q.num, type: q.type, prompt: q.prompt, marks: q.marks };
        if (q.label) pq.label = q.label;
        if (q.context) pq.context = q.context;
        if (q.hint) pq.hint = q.hint;
        if (q.options) pq.options = q.options.map((o) => ({ id: o.id, text: o.text }));
        if (q.minWords) pq.minWords = q.minWords;
        if (q.maxWords) pq.maxWords = q.maxWords;
        return pq;
      }),
    })),
  };
}

function loadSeeds() {
  return [require('../seed/exam-lower'), require('../seed/exam-upper'), require('../seed/exam-advanced')]
    .map((c) => JSON.parse(JSON.stringify(c)));
}

module.exports = { LEVELS, validate, publicView, allQuestions, questionVersion, schemeVersion, loadSeeds };
