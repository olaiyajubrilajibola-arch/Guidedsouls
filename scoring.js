'use strict';
// Converts stored raw marks into results out of 40, grades, sheets, positions and broadsheets.

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const fmt2 = (x) => (x == null ? '' : Number(x).toFixed(2));

async function gradeScale(db) {
  try { return JSON.parse(await db.setting('grading_scale')).sort((a, b) => b.min - a.min); } catch (_) { return []; }
}
function gradeFor(percentage, scale) {
  for (const g of scale) if (percentage >= g.min) return g;
  return { grade: '', remark: '' };
}

// Exam versions never change once saved (edits create a new version), so they are cached in memory.
const versionCache = new Map();
async function contentFor(db, attempt) {
  const id = attempt.exam_version_id;
  if (!versionCache.has(id)) {
    const v = await db.get('SELECT content_json FROM exam_versions WHERE id = ?', id);
    versionCache.set(id, JSON.parse(v.content_json));
  }
  return JSON.parse(JSON.stringify(versionCache.get(id)));
}

async function computeResult(db, attemptId) {
  const attempt = await db.get('SELECT * FROM attempts WHERE id = ?', attemptId);
  if (!attempt || attempt.status !== 'submitted') return null;
  const content = await contentFor(db, attempt);
  const marks = Object.fromEntries((await db.all('SELECT * FROM marks WHERE attempt_id = ?', attemptId)).map((m) => [m.question_id, m]));
  const groups = Object.fromEntries(content.groups.map((g) => [g.id, { ...g, raw: 0, pending: 0 }]));
  let status = 'complete';
  for (const s of content.sections) {
    for (const q of s.questions) {
      const m = marks[q.id];
      const g = groups[s.group];
      if (!m || m.status === 'queued' || m.status === 'processing') { g.pending++; if (status === 'complete') status = 'marking'; continue; }
      if (m.status === 'review') { g.pending++; status = 'pending_review'; continue; }
      g.raw += Number(m.total || 0);
    }
  }
  let exact = 0, rawTotal = 0, rawMax = 0;
  for (const g of Object.values(groups)) {
    exact += (g.raw / g.rawMax) * g.weight;
    rawTotal += g.raw; rawMax += g.rawMax;
  }
  const rawJson = JSON.stringify(Object.values(groups).map((g) => ({ id: g.id, title: g.title, raw: g.raw, rawMax: g.rawMax, weight: g.weight, pendingQuestions: g.pending })));
  const existing = await db.get('SELECT * FROM results WHERE attempt_id = ?', attemptId);
  const ts = db.now();
  if (status === 'complete') {
    const pct = (exact / 40) * 100;          // from the unrounded score
    const g = gradeFor(pct, await gradeScale(db));
    const published = existing && existing.status === 'complete' && existing.final_exact === exact ? existing.published_at : ts;
    await db.run(`INSERT INTO results(attempt_id, raw_json, raw_total, raw_max, final_exact, final_score, percentage, grade, remark, status, published_at, updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(attempt_id) DO UPDATE SET raw_json=excluded.raw_json, raw_total=excluded.raw_total, raw_max=excluded.raw_max,
              final_exact=excluded.final_exact, final_score=excluded.final_score, percentage=excluded.percentage, grade=excluded.grade,
              remark=excluded.remark, status=excluded.status, published_at=excluded.published_at, updated_at=excluded.updated_at`,
      attemptId, rawJson, rawTotal, rawMax, exact, round2(exact), pct, g.grade, g.remark, 'complete', published, ts);
  } else {
    await db.run(`INSERT INTO results(attempt_id, raw_json, raw_total, raw_max, final_exact, final_score, percentage, grade, remark, status, published_at, updated_at)
            VALUES(?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,NULL,?)
            ON CONFLICT(attempt_id) DO UPDATE SET raw_json=excluded.raw_json, raw_total=excluded.raw_total, raw_max=excluded.raw_max,
              final_exact=NULL, final_score=NULL, percentage=NULL, grade=NULL, remark=NULL, status=excluded.status, published_at=NULL, updated_at=excluded.updated_at`,
      attemptId, rawJson, rawTotal, rawMax, status, ts);
  }
  return db.get('SELECT * FROM results WHERE attempt_id = ?', attemptId);
}

// Grade boundaries may change in settings; refresh grades on stored complete results.
async function regradeAll(db) {
  const scale = await gradeScale(db);
  for (const r of await db.all("SELECT attempt_id, percentage FROM results WHERE status = 'complete'")) {
    const g = gradeFor(r.percentage, scale);
    await db.run('UPDATE results SET grade = ?, remark = ? WHERE attempt_id = ?', g.grade, g.remark, r.attempt_id);
  }
}

function attemptRows(db, where, params) {
  return db.all(`SELECT a.*, r.status AS result_status, r.final_score, r.final_exact, r.percentage, r.grade, r.remark, r.published_at, r.raw_json, r.raw_total, r.raw_max
                 FROM attempts a LEFT JOIN results r ON r.attempt_id = a.id WHERE ${where} ORDER BY a.student_name COLLATE NOCASE, a.subject`, ...params);
}

// Students in one class for a session/term, with averages and (when the class is complete) positions.
async function classStanding(db, className, session, term) {
  const rows = await attemptRows(db, 'a.class = ? AND a.session = ? AND a.term = ?', [className, session, term]);
  const complete = rows.length > 0 && rows.every((r) => r.status === 'submitted' && r.result_status === 'complete');
  const byStudent = new Map();
  for (const r of rows) {
    if (!byStudent.has(r.adm_norm)) byStudent.set(r.adm_norm, []);
    byStudent.get(r.adm_norm).push(r);
  }
  const avgs = [...byStudent.entries()].map(([adm, rs]) => {
    const done = rs.filter((r) => r.result_status === 'complete');
    const total = round2(done.reduce((s, r) => s + r.final_score, 0));
    return { adm, avg: done.length ? round2(total / done.length) : 0 };
  });
  const positions = new Map();
  if (complete) {
    avgs.sort((a, b) => b.avg - a.avg);
    avgs.forEach((s, i) => positions.set(s.adm, i > 0 && s.avg === avgs[i - 1].avg ? positions.get(avgs[i - 1].adm) : i + 1));
  }
  return { complete, positions, count: byStudent.size };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Everything a printed result sheet needs for one student in one session and term.
async function sheetFor(db, admNorm, session, term) {
  const st0 = await db.settingsMap();
  const rows = await attemptRows(db, "a.adm_norm = ? AND a.session = ? AND a.term = ? AND a.status = 'submitted'", [admNorm, session, term]);
  if (!rows.length) return null;
  const latest = rows.slice().sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
  const subjects = rows.map((r) => ({
    subject: r.subject, status: r.result_status || 'marking',
    score: r.result_status === 'complete' ? r.final_score : null,
    grade: r.result_status === 'complete' ? r.grade : '', remark: r.result_status === 'complete' ? r.remark : '',
    publishedAt: r.published_at,
  }));
  const done = subjects.filter((s) => s.score != null);
  const total = round2(done.reduce((s, x) => s + x.score, 0));
  const average = done.length ? round2(total / done.length) : null;
  const overall = average != null ? gradeFor((average / 40) * 100, await gradeScale(db)) : null;
  let position = null, classSize = null;
  if (st0.positions_enabled === '1') {
    const st = await classStanding(db, latest.class, session, term);
    if (st.complete && st.positions.has(admNorm)) { position = ordinal(st.positions.get(admNorm)); classSize = st.count; }
  }
  const c = await db.get('SELECT * FROM comments WHERE adm_norm = ? AND session = ? AND term = ?', admNorm, session, term) || {};
  const pubs = subjects.map((s) => s.publishedAt).filter(Boolean).sort();
  return {
    school: { name: st0.school_name, logo: st0.school_logo, logoW: Number(st0.school_logo_w) || 0, logoH: Number(st0.school_logo_h) || 0 },
    student: { name: latest.student_name, admNo: latest.adm_no, admNorm, className: latest.class, level: latest.level },
    assessmentName: st0.assessment_name,
    session, term, subjects,
    counted: done.length, total, totalMax: 40 * done.length, average, overallGrade: overall ? overall.grade : '', overallRemark: overall ? overall.remark : '',
    allComplete: done.length === subjects.length,
    position, classSize, positionsEnabled: st0.positions_enabled === '1',
    teacherComment: c.teacher_comment || '', principalComment: c.principal_comment || '',
    publishedAt: pubs.length ? pubs[pubs.length - 1] : null,
  };
}

// Broadsheet for a section (level) or a class.
async function broadsheet(db, { level, className, session, term, subject }) {
  const where = ['a.session = ?', 'a.term = ?'];
  const params = [session, term];
  if (className) { where.push('a.class = ?'); params.push(className); } else if (level) { where.push('a.level = ?'); params.push(level); }
  if (subject) { where.push('a.subject = ?'); params.push(subject); }
  const rows = await attemptRows(db, where.join(' AND '), params);
  const subjects = [...new Set(rows.map((r) => r.subject))].sort();
  const students = new Map();
  for (const r of rows) {
    const key = r.adm_norm + '|' + r.class;
    if (!students.has(key)) students.set(key, { name: r.student_name, admNo: r.adm_no, admNorm: r.adm_norm, className: r.class, scores: {} });
    students.get(key).scores[r.subject] = r.status !== 'submitted' ? 'In progress' : r.result_status === 'complete' ? r.final_score : 'Pending';
  }
  const positionsOn = (await db.setting('positions_enabled')) === '1';
  const standings = {};
  const scale = await gradeScale(db);
  if (positionsOn) for (const s of students.values()) if (!standings[s.className]) standings[s.className] = await classStanding(db, s.className, session, term);
  const out = [...students.values()].map((s) => {
    const nums = subjects.map((sub) => s.scores[sub]).filter((v) => typeof v === 'number');
    const total = round2(nums.reduce((a, b) => a + b, 0));
    const average = nums.length ? round2(total / nums.length) : null;
    const g = average != null ? gradeFor((average / 40) * 100, scale) : { grade: '', remark: '' };
    let position = '';
    if (positionsOn) {
      const st = standings[s.className];
      position = st.complete && st.positions.has(s.admNorm) ? ordinal(st.positions.get(s.admNorm)) : '';
    }
    return { ...s, counted: nums.length, total, totalMax: 40 * nums.length, average, grade: g.grade, remark: g.remark, position };
  });
  out.sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name));
  return { subjects, rows: out, positionsOn };
}

module.exports = { round2, fmt2, computeResult, regradeAll, sheetFor, broadsheet, classStanding, gradeFor, gradeScale, contentFor };
