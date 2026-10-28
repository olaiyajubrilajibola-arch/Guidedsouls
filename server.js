'use strict';
// School CBT — the whole application (Node 22.5+, no dependencies).
//   • On a school computer:  npm start  → run-local.js uses this   (records in data/cbt.sqlite)
//   • On Vercel:             api/index.js uses this                (records in Turso Cloud; see README)
// It lives inside api/ so Vercel's builder always finds it next to the function that uses it.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbmod = require('./lib/db');
const exams = require('./lib/exams');
const marking = require('./lib/marking');
const scoring = require('./lib/scoring');
const reports = require('./lib/reports');
const ai = require('./lib/ai');

const GRACE_MS = 15000;              // network allowance for answers saved in the final seconds
const TEACHER_SESSION_HOURS = 12;
const ROOT_DIR = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};
const httpError = (status, message, extra) => Object.assign(new Error(message), { status, extra });

function sendJson(res, status, obj, extraHeaders) {
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(JSON.stringify(obj ?? {}));
}

// When hosted on Vercel without a database connected, explain how to fix it instead of silently losing records.
function noDatabaseApp() {
  const msg = 'The website is not connected to its database yet. In Vercel, open this project → Storage (or Integrations) → connect a Turso database, then redeploy. See the README for step-by-step instructions.';
  return {
    db: null, serverless: true,
    async handler(req, res) { sendJson(res, 503, { error: msg }); },
    startBackground() {}, stopBackground() {},
  };
}

async function createApp(opts = {}) {
  const turso = opts.turso !== undefined ? opts.turso : dbmod.tursoFromEnv();
  const serverless = opts.serverless !== undefined ? opts.serverless : !!process.env.VERCEL;
  if (!turso && process.env.VERCEL && !opts.dbFile) return noDatabaseApp();
  const dbFile = opts.dbFile || process.env.CBT_DB || path.join(ROOT_DIR, 'data', 'cbt.sqlite');
  const db = await dbmod.open(turso ? { turso } : { file: dbFile });

  // ---- initial teacher password ----
  if (!(await db.get("SELECT value FROM settings WHERE key = 'teacher_password_hash'"))) {
    if (process.env.TEACHER_PASSWORD) {
      await db.run("INSERT OR IGNORE INTO settings(key, value) VALUES('teacher_password_hash', ?)", db.hashPassword(process.env.TEACHER_PASSWORD));
    } else if (!serverless) {
      const pw = crypto.randomBytes(6).toString('base64url');
      await db.setSetting('teacher_password_hash', db.hashPassword(pw));
      const f = path.join(path.dirname(dbFile), 'teacher-password.txt');
      try { fs.writeFileSync(f, `Initial teacher password: ${pw}\nChange it on the teacher page (Settings) and then delete this file.\n`); } catch (_) { /* ignore */ }
      if (opts.logPassword !== false) console.log(`\n  Initial teacher password: ${pw}\n  (also saved in ${f})\n`);
    }
  }

  // ---- helpers ----
  const now = () => new Date();
  const normAdm = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');
  const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const resultCode = () => { const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length]; return `${s.slice(0, 4)}-${s.slice(4)}`; };
  let worker = null, sweeper = null;

  async function currentContent(examId) {
    const r = await db.get('SELECT v.id AS version_id, v.version_no, v.content_json FROM exams e JOIN exam_versions v ON v.id = e.current_version_id WHERE e.id = ?', examId);
    return r ? { versionId: r.version_id, versionNo: r.version_no, content: JSON.parse(r.content_json) } : null;
  }
  async function availableExams() {
    const rows = await db.all("SELECT e.*, v.id AS version_id, v.content_json FROM exams e JOIN exam_versions v ON v.id = e.current_version_id WHERE e.status = 'published' ORDER BY e.subject");
    return rows.filter((e) => exams.validate(JSON.parse(e.content_json)).errors.length === 0)
      .map((e) => ({ id: e.id, subject: e.subject, classes: JSON.parse(e.classes_json), versionId: e.version_id, content: JSON.parse(e.content_json) }));
  }
  async function attemptByToken(token) {
    const a = await db.get('SELECT * FROM attempts WHERE token = ?', String(token || ''));
    if (!a) throw httpError(404, 'Test session not found. Please start again from the home page.');
    return a;
  }

  // Only the request that actually changes the status marks the attempt, so double submits cannot double-mark.
  async function submitAttempt(attempt, reason) {
    const changed = (await db.run("UPDATE attempts SET status = 'submitted', submitted_at = ?, submit_reason = ? WHERE id = ? AND status = 'in_progress'",
      now().toISOString(), reason, attempt.id)).changes;
    if (changed) await marking.markAttempt(db, attempt.id);
    else await ensureMarked(await db.get('SELECT * FROM attempts WHERE id = ?', attempt.id));
    if (worker) setImmediate(() => worker.tick());
    return db.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
  }
  // Repairs an attempt whose marking was interrupted (for example a serverless function timing out mid-way).
  async function ensureMarked(a) {
    if (!a || a.status !== 'submitted') return;
    const r = await db.get('SELECT status, updated_at FROM results WHERE attempt_id = ?', a.id);
    const stale = Date.now() - Date.parse(a.submitted_at || 0) > 60000;
    if (!r && stale) { await marking.markAttempt(db, a.id); return; }
    if (r && r.status === 'marking') {
      const busy = await db.get("SELECT COUNT(*) AS n FROM marks WHERE attempt_id = ? AND status IN ('queued', 'processing')", a.id);
      if (!busy.n && stale) await marking.markAttempt(db, a.id);
    }
  }
  async function expireIfDue(attempt) {
    if (attempt.status === 'in_progress' && Date.now() > Date.parse(attempt.deadline) + GRACE_MS) return submitAttempt(attempt, 'time_expired');
    return attempt;
  }
  // Auto-submits tests whose time ran out even if the student closed the page. On a server a timer does this;
  // on serverless hosting it runs while other requests are handled.
  let lastSweep = 0;
  async function sweepExpired(force) {
    if (!force && Date.now() - lastSweep < 15000) return;
    lastSweep = Date.now();
    const due = await db.all("SELECT * FROM attempts WHERE status = 'in_progress' AND deadline < ? LIMIT 25", new Date(Date.now() - GRACE_MS).toISOString());
    for (const a of due) { try { await submitAttempt(a, 'time_expired'); } catch (e) { console.error('auto-submit failed', e); } }
  }
  async function maintenance({ attemptId, budgetMs = 5000 } = {}) {
    if (!serverless) return;
    await sweepExpired();
    await marking.processDue(db, { attemptId, budgetMs });
  }

  function feedbackState(mark) {
    if (!mark) return 'pending';
    if (mark.status !== 'final') return 'pending';
    const flags = JSON.parse(mark.flags_json || '[]');
    if (mark.total >= mark.max - 1e-9 && !flags.length) return 'correct';
    if (mark.total > 0) return 'partial';
    return 'incorrect';
  }

  async function feedbackReleased() {
    const st = await db.settingsMap();
    if (st.feedback_release_mode === 'immediate') return true;
    if (st.feedback_release_mode === 'scheduled') { const at = Date.parse(st.feedback_release_at); return Number.isFinite(at) && Date.now() >= at; }
    return false;
  }

  // ---- student API ----
  async function publicConfig() {
    const st = await db.settingsMap();
    const list = await availableExams();
    const available = {};
    for (const classes of Object.values(exams.LEVELS)) for (const c of classes) available[c] = list.filter((e) => e.classes.includes(c)).map((e) => ({ examId: e.id, subject: e.subject }));
    return {
      schoolName: st.school_name, assessmentName: st.assessment_name, logo: st.school_logo || '',
      session: st.session, term: st.term, levels: exams.LEVELS, available,
    };
  }

  async function start(body, depth = 0) {
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    const admNo = String(body.admNo || '').trim();
    const level = String(body.level || '');
    const className = String(body.className || '');
    if (name.length < 3 || name.length > 100) throw httpError(400, 'Please enter your full name.');
    if (!admNo || admNo.length > 40) throw httpError(400, 'Please enter your admission number.');
    if (!exams.LEVELS[level]) throw httpError(400, 'Please choose your level.');
    if (!exams.LEVELS[level].includes(className)) throw httpError(400, 'Please choose a class from your level.');
    const list = (await availableExams()).filter((e) => e.classes.includes(className));
    if (!list.length) throw httpError(404, `No test is available for ${className} yet. Please tell your teacher.`);
    let exam = list[0];
    if (list.length > 1) {
      exam = list.find((e) => e.id === Number(body.examId));
      if (!exam) return { chooseSubject: list.map((e) => ({ examId: e.id, subject: e.subject })) };
    }
    const st = await db.settingsMap();
    const session = st.session, term = st.term;
    const admNorm = normAdm(admNo);
    const existing = await db.get('SELECT * FROM attempts WHERE adm_norm = ? AND exam_id = ? AND session = ? AND term = ?', admNorm, exam.id, session, term);
    if (existing) {
      if (normName(existing.student_name) !== normName(name)) {
        throw httpError(409, 'This admission number has already been used for this test with a different name. Please ask your teacher for help.');
      }
      const a = await expireIfDue(existing);
      if (a.status === 'in_progress') return { token: a.token, resumed: true };
      return { alreadySubmitted: true, message: 'You have already submitted this test. Use your result code to view your result, or ask your teacher.' };
    }
    const started = now();
    const deadline = new Date(started.getTime() + exam.content.durationMinutes * 60000);
    const token = crypto.randomBytes(24).toString('base64url');
    const ins = await db.run(`INSERT INTO attempts(token, result_code, student_name, adm_no, adm_norm, level, class, exam_id, exam_version_id, subject, session, term, started_at, deadline)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(adm_norm, exam_id, session, term) DO NOTHING`,
    token, resultCode(), name, admNo, admNorm, level, className, exam.id, exam.versionId, exam.subject, session, term, started.toISOString(), deadline.toISOString());
    if (!ins.changes) {
      if (depth > 2) throw httpError(409, 'Please try again.');
      return start(body, depth + 1);   // a simultaneous start created it first
    }
    return { token, resumed: false };
  }

  async function attemptView(token) {
    const a = await expireIfDue(await attemptByToken(token));
    const content = await scoring.contentFor(db, a);
    const st = await db.settingsMap();
    const answers = {};
    const marks = content.interactive ? Object.fromEntries((await db.all('SELECT * FROM marks WHERE attempt_id = ?', a.id)).map((m) => [m.question_id, m])) : {};
    for (const r of await db.all('SELECT question_id, value, locked FROM answers WHERE attempt_id = ?', a.id)) {
      answers[r.question_id] = { value: r.value, locked: !!r.locked };
      if (r.locked && content.interactive) answers[r.question_id].feedback = feedbackState(marks[r.question_id]);
    }
    return {
      attempt: {
        name: a.student_name, admNo: a.adm_no, level: a.level, className: a.class, subject: a.subject, session: a.session, term: a.term,
        startedAt: a.started_at, deadline: a.deadline, serverNow: now().toISOString(), status: a.status,
        resultCode: a.result_code,
      },
      school: { name: st.school_name, logo: st.school_logo || '' },
      assessmentName: st.assessment_name,
      exam: exams.publicView(content),
      answers,
    };
  }

  async function saveAnswers(token, body) {
    const a = await attemptByToken(token);
    if (a.status !== 'in_progress') throw httpError(409, 'This test has already been submitted.', { submitted: true });
    if (Date.now() > Date.parse(a.deadline) + GRACE_MS) { await submitAttempt(a, 'time_expired'); throw httpError(409, 'Time is up. Your saved answers have been submitted.', { submitted: true }); }
    const qmap = marking.questionMap(await scoring.contentFor(db, a));
    const incoming = body && typeof body.answers === 'object' ? body.answers : {};
    const entries = Object.entries(incoming).filter(([qid]) => qmap[qid]).slice(0, 200);
    let saved = 0; const skipped = [];
    const ts = now().toISOString();
    for (const [qid, raw] of entries) {
      const value = String(raw ?? '').slice(0, 20000);
      // A locked (confirmed) answer is never overwritten: the WHERE clause makes the update a no-op.
      const r = await db.run(`INSERT INTO answers(attempt_id, question_id, value, locked, saved_at) VALUES(?,?,?,0,?)
              ON CONFLICT(attempt_id, question_id) DO UPDATE SET value = excluded.value, saved_at = excluded.saved_at WHERE answers.locked = 0`, a.id, qid, value, ts);
      if (r.changes) saved++; else skipped.push(qid);
    }
    return { saved, lockedSkipped: skipped, serverNow: now().toISOString() };
  }

  async function confirmAnswer(token, body) {
    const a = await attemptByToken(token);
    const content = await scoring.contentFor(db, a);
    if (!content.interactive) throw httpError(400, 'Confirm is only used in the interactive test.');
    if (a.status !== 'in_progress') throw httpError(409, 'This test has already been submitted.', { submitted: true });
    if (Date.now() > Date.parse(a.deadline) + GRACE_MS) { await submitAttempt(a, 'time_expired'); throw httpError(409, 'Time is up. Your saved answers have been submitted.', { submitted: true }); }
    const qmap = marking.questionMap(content);
    const q = qmap[String(body.questionId)];
    if (!q) throw httpError(400, 'Unknown question.');
    const value = String(body.value ?? '').slice(0, 20000);
    if (!value.trim()) throw httpError(400, 'Choose or type an answer first.');
    const already = async () => {
      const ex = await db.get('SELECT * FROM answers WHERE attempt_id = ? AND question_id = ?', a.id, q.id);
      const m = await db.get('SELECT * FROM marks WHERE attempt_id = ? AND question_id = ?', a.id, q.id);
      return { questionId: q.id, locked: true, value: ex.value, feedback: feedbackState(m), already: true };
    };
    const existing = await db.get('SELECT * FROM answers WHERE attempt_id = ? AND question_id = ?', a.id, q.id);
    if (existing && existing.locked) return already();
    if (q.type === 'bank') {
      const sec = content.sections.find((s) => s.questions.some((x) => x.id === q.id));
      if (!sec.bank.includes(value)) throw httpError(400, 'Please choose a word from the word bank.');
      const used = (await db.all('SELECT question_id, value FROM answers WHERE attempt_id = ? AND locked = 1', a.id))
        .filter((r) => r.value === value && sec.questions.some((x) => x.id === r.question_id));
      if (used.length) throw httpError(400, 'You have already used that word. Each word can be used only once.');
    }
    if (q.type === 'mcq' && !q.options.some((o) => o.id === value)) throw httpError(400, 'Please choose one of the options.');
    const lock = await db.run(`INSERT INTO answers(attempt_id, question_id, value, locked, saved_at) VALUES(?,?,?,1,?)
            ON CONFLICT(attempt_id, question_id) DO UPDATE SET value = excluded.value, locked = 1, saved_at = excluded.saved_at WHERE answers.locked = 0`,
    a.id, q.id, value, now().toISOString());
    if (!lock.changes) return already();     // a simultaneous confirm locked it first
    let mark = await marking.markQuestion(db, a.id, q, value);
    if (mark.status === 'queued') {
      await marking.processMark(db, mark.id).catch(() => {});
      const until = Date.now() + 12000;
      while (Date.now() < until) {
        mark = await db.get('SELECT * FROM marks WHERE id = ?', mark.id);
        if (mark.status !== 'queued' && mark.status !== 'processing') break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    return { questionId: q.id, locked: true, value, feedback: feedbackState(mark) };
  }

  async function submit(token, body) {
    const a = await attemptByToken(token);
    const reason = body && body.reason === 'time_expired' ? 'time_expired' : 'student';
    const after = await submitAttempt(a, a.status === 'in_progress' ? reason : a.submit_reason);
    if (serverless) await marking.processDue(db, { attemptId: a.id, budgetMs: 10000 });
    return { resultCode: after.result_code, status: after.status };
  }

  async function resultView(code) {
    const a = await db.get('SELECT * FROM attempts WHERE result_code = ?', String(code || '').toUpperCase().trim());
    if (!a) throw httpError(404, 'We could not find a result with that code. Please check it and try again.');
    await expireIfDue(a);
    await ensureMarked(await db.get('SELECT * FROM attempts WHERE id = ?', a.id));
    if (serverless) await marking.processDue(db, { attemptId: a.id, budgetMs: 6000 });
    const att = await db.get('SELECT * FROM attempts WHERE id = ?', a.id);
    const r = await db.get('SELECT * FROM results WHERE attempt_id = ?', a.id);
    const st = await db.settingsMap();
    const base = {
      student: { name: att.student_name, admNo: att.adm_no, level: att.level, className: att.class },
      subject: att.subject, session: att.session, term: att.term, code: att.result_code,
      school: { name: st.school_name, logo: st.school_logo || '' },
      assessmentName: st.assessment_name,
    };
    if (att.status !== 'submitted') return { ...base, status: 'in_progress' };
    if (!r || r.status !== 'complete') return { ...base, status: r ? r.status : 'marking' };
    const out = { ...base, status: 'complete', score: r.final_score, scoreText: `${scoring.fmt2(r.final_score)} / 40`, percentage: Math.round(r.percentage * 100) / 100, grade: r.grade, remark: r.remark, publishedAt: r.published_at };
    if (await feedbackReleased()) {
      const content = await scoring.contentFor(db, att);
      const marks = Object.fromEntries((await db.all('SELECT * FROM marks WHERE attempt_id = ?', att.id)).map((m) => [m.question_id, m]));
      out.feedback = content.sections.map((s) => ({
        title: s.title,
        questions: s.questions.map((q) => {
          const m = marks[q.id];
          const crit = JSON.parse((m && m.criteria_json) || '[]');
          return {
            num: q.num, label: q.label || null, type: q.type, awarded: m ? m.total : 0, max: q.marks,
            criteria: q.type === 'essay' || (q.type === 'short' && crit.length > 1)
              ? crit.map((c) => ({ name: c.name, awarded: c.awarded, max: c.max, feedback: c.feedback || '' })) : undefined,
            comment: q.type === 'essay' && m ? m.summary || '' : undefined,
          };
        }),
      }));
    }
    return out;
  }

  async function sheetPdfFor(admNorm, session, term) {
    const sheet = await scoring.sheetFor(db, admNorm, session, term);
    if (!sheet) throw httpError(404, 'No submitted tests found for this student.');
    return { pdf: reports.resultSheetPDF(sheet), sheet };
  }

  // ---- teacher API ----
  const loginAttempts = new Map();
  async function teacherFromReq(req) {
    const m = /(?:^|;\s*)cbt_teacher=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const s = await db.get('SELECT * FROM teacher_sessions WHERE token = ?', m[1]);
    if (!s || Date.parse(s.expires_at) < Date.now()) return null;
    return s;
  }

  async function settingsView() {
    const st = await db.settingsMap(true);
    let scale; try { scale = JSON.parse(st.grading_scale); } catch (_) { scale = dbmod.DEFAULT_GRADES; }
    return {
      schoolName: st.school_name, assessmentName: st.assessment_name, logo: st.school_logo || '', session: st.session, term: st.term,
      gradingScale: scale, feedbackReleaseMode: st.feedback_release_mode, feedbackReleaseAt: st.feedback_release_at,
      positionsEnabled: st.positions_enabled === '1', aiModel: st.ai_model,
      aiKeySource: process.env.CBT_AI_MOCK ? 'test mode' : process.env.ANTHROPIC_API_KEY ? 'server environment' : st.ai_api_key ? 'saved in settings' : 'none',
      levels: exams.LEVELS, storage: db.driver === 'turso' ? 'Turso Cloud database' : 'database file on this computer',
    };
  }

  async function updateSettings(b) {
    const set = (k, v) => db.setSetting(k, v);
    if (b.schoolName !== undefined) { const v = String(b.schoolName).trim(); if (!v) throw httpError(400, 'School name cannot be empty.'); await set('school_name', v.slice(0, 120)); }
    if (b.assessmentName !== undefined) { const v = String(b.assessmentName).trim(); if (!v) throw httpError(400, 'Assessment name cannot be empty.'); await set('assessment_name', v.slice(0, 80)); }
    if (b.session !== undefined) { const v = String(b.session).trim(); if (!v) throw httpError(400, 'Session cannot be empty.'); await set('session', v.slice(0, 40)); }
    if (b.term !== undefined) { const v = String(b.term).trim(); if (!v) throw httpError(400, 'Term cannot be empty.'); await set('term', v.slice(0, 40)); }
    if (b.gradingScale !== undefined) {
      const list = (Array.isArray(b.gradingScale) ? b.gradingScale : []).map((g) => ({ min: Number(g.min), grade: String(g.grade || '').trim(), remark: String(g.remark || '').trim() }));
      if (!list.length || list.some((g) => !Number.isFinite(g.min) || g.min < 0 || g.min > 100 || !g.grade)) throw httpError(400, 'Each grade needs a minimum percentage (0–100) and a grade label.');
      if (!list.some((g) => g.min === 0)) throw httpError(400, 'The grading scale must include a grade starting at 0%.');
      if (new Set(list.map((g) => g.min)).size !== list.length) throw httpError(400, 'Two grades have the same minimum percentage.');
      await set('grading_scale', JSON.stringify(list.sort((x, y) => y.min - x.min)));
      await scoring.regradeAll(db);
    }
    if (b.feedbackReleaseMode !== undefined) {
      if (!['never', 'immediate', 'scheduled'].includes(b.feedbackReleaseMode)) throw httpError(400, 'Unknown feedback release option.');
      if (b.feedbackReleaseMode === 'scheduled' && !Number.isFinite(Date.parse(b.feedbackReleaseAt))) throw httpError(400, 'Choose a release date and time.');
      await set('feedback_release_mode', b.feedbackReleaseMode);
      await set('feedback_release_at', b.feedbackReleaseMode === 'scheduled' ? new Date(b.feedbackReleaseAt).toISOString() : '');
    }
    if (b.positionsEnabled !== undefined) await set('positions_enabled', b.positionsEnabled ? '1' : '0');
    if (b.aiModel !== undefined && String(b.aiModel).trim()) await set('ai_model', String(b.aiModel).trim());
    if (b.aiApiKey !== undefined && String(b.aiApiKey).trim()) await set('ai_api_key', String(b.aiApiKey).trim());
    if (b.clearAiKey) await set('ai_api_key', '');
    if (b.logo !== undefined) {
      if (!b.logo) { await set('school_logo', ''); await set('school_logo_w', ''); await set('school_logo_h', ''); }
      else {
        const m = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(b.logo.dataUrl || ''));
        if (!m || !(b.logo.w > 0) || !(b.logo.h > 0)) throw httpError(400, 'Logo must be an image.');
        if (b.logo.dataUrl.length > 1500000) throw httpError(400, 'Logo is too large.');
        await set('school_logo', b.logo.dataUrl); await set('school_logo_w', Math.round(b.logo.w)); await set('school_logo_h', Math.round(b.logo.h));
      }
    }
    await db.audit('teacher', 'settings_updated', Object.keys(b).filter((k) => k !== 'aiApiKey' && k !== 'logo'));
    return settingsView();
  }

  async function examList() {
    const rows = await db.all('SELECT e.*, v.version_no, v.content_json FROM exams e JOIN exam_versions v ON v.id = e.current_version_id ORDER BY e.level, e.subject');
    const counts = Object.fromEntries((await db.all('SELECT exam_id, COUNT(*) AS n FROM attempts GROUP BY exam_id')).map((r) => [r.exam_id, r.n]));
    return rows.map((e) => {
      const content = JSON.parse(e.content_json);
      const v = exams.validate(content);
      const qs = exams.allQuestions(content);
      return {
        id: e.id, code: e.code, subject: e.subject, level: e.level, classes: JSON.parse(e.classes_json), status: e.status, version: e.version_no,
        questions: qs.length, errors: v.errors, warnings: v.warnings,
        draftSchemes: qs.filter((q) => q.type === 'essay' && q.scheme && q.scheme.status !== 'approved').map((q) => ({ id: q.id, num: q.num, label: q.label, prompt: q.prompt, scheme: q.scheme, marks: q.marks })),
        attempts: counts[e.id] || 0,
      };
    });
  }

  async function saveExamVersion(examId, content, note) {
    if (!content || typeof content !== 'object' || !Array.isArray(content.sections)) throw httpError(400, 'Exam content must be a JSON object with a “sections” list.');
    const v = exams.validate(content);
    const result = await db.tx(async (t) => {
      const last = (await t.get('SELECT MAX(version_no) AS n FROM exam_versions WHERE exam_id = ?', examId)).n || 0;
      await t.run('INSERT INTO exam_versions(exam_id, version_no, content_json, note, created_at) VALUES(?,?,?,?,?)', examId, last + 1, JSON.stringify(content), note || '', t.now());
      const ver = await t.get('SELECT id FROM exam_versions WHERE exam_id = ? AND version_no = ?', examId, last + 1);
      const exam = await t.get('SELECT status FROM exams WHERE id = ?', examId);
      const status = exam.status === 'published' && v.errors.length === 0 ? 'published' : 'draft';
      await t.run('UPDATE exams SET current_version_id = ?, subject = ?, level = ?, classes_json = ?, status = ?, updated_at = ? WHERE id = ?',
        ver.id, content.subject || '', content.level || '', JSON.stringify(content.classes || []), status, t.now(), examId);
      return { version: last + 1, status, errors: v.errors, warnings: v.warnings };
    });
    await db.audit('teacher', 'exam_version_saved', { examId, version: result.version, note, errors: v.errors.length });
    return result;
  }

  async function attemptsList(q) {
    const where = ['1 = 1'], p = [];
    for (const [k, col] of [['level', 'a.level'], ['className', 'a.class'], ['subject', 'a.subject'], ['session', 'a.session'], ['term', 'a.term']]) {
      if (q.get(k)) { where.push(`${col} = ?`); p.push(q.get(k)); }
    }
    if (q.get('status')) {
      const s = q.get('status');
      if (s === 'in_progress') where.push("a.status = 'in_progress'");
      else { where.push("a.status = 'submitted' AND r.status = ?"); p.push(s); }
    }
    if (q.get('search')) { where.push('(a.student_name LIKE ? OR a.adm_norm LIKE ?)'); p.push(`%${q.get('search')}%`, `%${normAdm(q.get('search'))}%`); }
    return db.all(`SELECT a.id, a.student_name, a.adm_no, a.level, a.class, a.subject, a.session, a.term, a.status, a.started_at, a.deadline, a.submitted_at, a.submit_reason, a.result_code, a.adm_norm,
                   r.status AS result_status, r.final_score, r.percentage, r.grade, r.remark, r.raw_total, r.raw_max
                   FROM attempts a LEFT JOIN results r ON r.attempt_id = a.id WHERE ${where.join(' AND ')}
                   ORDER BY a.started_at DESC LIMIT 2000`, ...p);
  }

  async function attemptDetail(id) {
    const a = await db.get('SELECT * FROM attempts WHERE id = ?', id);
    if (!a) throw httpError(404, 'Submission not found.');
    const content = await scoring.contentFor(db, a);
    const version = (await db.get('SELECT version_no FROM exam_versions WHERE id = ?', a.exam_version_id)).version_no;
    const answers = Object.fromEntries((await db.all('SELECT * FROM answers WHERE attempt_id = ?', id)).map((r) => [r.question_id, r]));
    const marks = Object.fromEntries((await db.all('SELECT * FROM marks WHERE attempt_id = ?', id)).map((m) => [m.question_id, m]));
    const revs = {};
    for (const r of await db.all('SELECT * FROM mark_revisions WHERE attempt_id = ? ORDER BY revision_no', id)) (revs[r.question_id] = revs[r.question_id] || []).push({ ...r, criteria: JSON.parse(r.criteria_json || '[]'), flags: JSON.parse(r.flags_json || '[]') });
    const parse = (m) => m && { ...m, criteria: JSON.parse(m.criteria_json || '[]'), flags: JSON.parse(m.flags_json || '[]') };
    return {
      attempt: a, examVersion: version, result: await db.get('SELECT * FROM results WHERE attempt_id = ?', id),
      sections: content.sections.map((s) => ({
        id: s.id, title: s.title,
        questions: s.questions.map((q) => ({
          id: q.id, num: q.num, label: q.label, type: q.type, prompt: q.prompt, context: q.context, marks: q.marks, options: q.options,
          answerKey: q.answer, scheme: q.scheme, answer: answers[q.id] ? answers[q.id].value : '', locked: answers[q.id] ? !!answers[q.id].locked : false,
          mark: parse(marks[q.id]), revisions: revs[q.id] || [],
        })),
      })),
    };
  }

  async function reviewQueue() {
    return (await db.all(`SELECT m.id, m.question_id, m.status, m.flags_json, m.total, m.max, m.last_error, m.tries, m.updated_at, a.id AS attempt_id, a.student_name, a.adm_no, a.class, a.subject
                   FROM marks m JOIN attempts a ON a.id = m.attempt_id WHERE m.status IN ('review', 'queued', 'processing') ORDER BY m.status = 'review' DESC, m.updated_at`))
      .map((r) => ({ ...r, flags: JSON.parse(r.flags_json || '[]') }));
  }

  async function studentsList(q) {
    const st = await db.settingsMap();
    const session = q.get('session') || st.session, term = q.get('term') || st.term;
    const where = ['a.session = ?', 'a.term = ?'], p = [session, term];
    if (q.get('level')) { where.push('a.level = ?'); p.push(q.get('level')); }
    if (q.get('className')) { where.push('a.class = ?'); p.push(q.get('className')); }
    const rows = await db.all(`SELECT a.adm_norm, MAX(a.student_name) AS name, MAX(a.adm_no) AS adm_no, MAX(a.class) AS class, MAX(a.level) AS level, COUNT(*) AS subjects,
                         SUM(CASE WHEN r.status = 'complete' THEN 1 ELSE 0 END) AS complete
                         FROM attempts a LEFT JOIN results r ON r.attempt_id = a.id WHERE ${where.join(' AND ')} GROUP BY a.adm_norm ORDER BY name COLLATE NOCASE`, ...p);
    const students = [];
    for (const r of rows) {
      const sheet = await scoring.sheetFor(db, r.adm_norm, session, term);
      students.push({ ...r, average: sheet ? sheet.average : null, position: sheet ? sheet.position : null,
        teacherComment: sheet ? sheet.teacherComment : '', principalComment: sheet ? sheet.principalComment : '' });
    }
    return { session, term, students };
  }

  // ---- routing ----
  const routes = [];
  const route = (method, pattern, handler, opts2 = {}) => routes.push({ method, re: new RegExp('^' + pattern + '$'), handler, ...opts2 });

  route('GET', '/api/config', async () => { await maintenance({ budgetMs: 2000 }); return publicConfig(); });
  route('POST', '/api/start', (req, m, body) => start(body));
  route('GET', '/api/attempt/([A-Za-z0-9_-]+)', (req, m) => attemptView(m[1]));
  route('PUT', '/api/attempt/([A-Za-z0-9_-]+)/answers', (req, m, body) => saveAnswers(m[1], body));
  route('POST', '/api/attempt/([A-Za-z0-9_-]+)/confirm', (req, m, body) => confirmAnswer(m[1], body));
  route('POST', '/api/attempt/([A-Za-z0-9_-]+)/submit', (req, m, body) => submit(m[1], body));
  route('GET', '/api/result/([A-Za-z0-9-]+)', (req, m) => resultView(m[1]));
  route('GET', '/api/result/([A-Za-z0-9-]+)/pdf', async (req, m) => {
    const a = await db.get('SELECT * FROM attempts WHERE result_code = ?', m[1].toUpperCase());
    if (!a) throw httpError(404, 'Result not found.');
    const r = await db.get('SELECT status FROM results WHERE attempt_id = ?', a.id);
    if (!r || r.status !== 'complete') throw httpError(409, 'Result pending review. The PDF will be available once marking is complete.');
    const { pdf } = await sheetPdfFor(a.adm_norm, a.session, a.term);
    return { file: pdf, type: 'application/pdf', name: `Result-${a.adm_norm.replace(/\W+/g, '-')}-${a.session.replace(/\W+/g, '-')}-${a.term.replace(/\W+/g, '-')}.pdf` };
  });

  route('POST', '/api/teacher/login', async (req, m, body) => {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'x';
    const recent = (loginAttempts.get(ip) || []).filter((t) => Date.now() - t < 10 * 60000);
    if (recent.length >= 8) throw httpError(429, 'Too many attempts. Please wait a few minutes and try again.');
    recent.push(Date.now()); loginAttempts.set(ip, recent);
    const stored = (await db.settingsMap(true)).teacher_password_hash;
    if (!stored) throw httpError(503, 'The teacher password has not been set. In Vercel, add an environment variable named TEACHER_PASSWORD, then redeploy.');
    if (!db.checkPassword(String(body.password || ''), stored)) throw httpError(401, 'Incorrect password.');
    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    await db.run('INSERT INTO teacher_sessions(token, created_at, expires_at) VALUES(?,?,?)', token, db.now(), new Date(Date.now() + TEACHER_SESSION_HOURS * 3600000).toISOString());
    await db.run('DELETE FROM teacher_sessions WHERE expires_at < ?', db.now());
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return { ok: true, cookie: `cbt_teacher=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TEACHER_SESSION_HOURS * 3600}${secure}` };
  });
  route('POST', '/api/teacher/logout', async (req) => {
    const s = await teacherFromReq(req);
    if (s) await db.run('DELETE FROM teacher_sessions WHERE token = ?', s.token);
    return { ok: true, cookie: 'cbt_teacher=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' };
  });
  route('GET', '/api/teacher/me', async () => {
    await maintenance({ budgetMs: 4000 });
    return { ok: true, aiConfigured: ai.configured(await marking.aiConfig(db)), reviewCount: (await db.get("SELECT COUNT(*) AS n FROM marks WHERE status = 'review'")).n };
  }, { teacher: true });
  route('GET', '/api/teacher/settings', () => settingsView(), { teacher: true });
  route('PUT', '/api/teacher/settings', (req, m, body) => updateSettings(body), { teacher: true });
  route('POST', '/api/teacher/password', async (req, m, body) => {
    if (!db.checkPassword(String(body.current || ''), await db.setting('teacher_password_hash'))) throw httpError(400, 'Current password is incorrect.');
    if (String(body.next || '').length < 8) throw httpError(400, 'New password must be at least 8 characters.');
    await db.setSetting('teacher_password_hash', db.hashPassword(body.next));
    await db.audit('teacher', 'password_changed', {});
    return { ok: true };
  }, { teacher: true });

  route('GET', '/api/teacher/exams', () => examList(), { teacher: true });
  route('GET', '/api/teacher/exams/(\\d+)', async (req, m) => {
    const e = await db.get('SELECT * FROM exams WHERE id = ?', Number(m[1]));
    if (!e) throw httpError(404, 'Exam not found.');
    const cur = await currentContent(e.id);
    return { exam: e, version: cur.versionNo, content: cur.content, validation: exams.validate(cur.content),
      versions: await db.all('SELECT version_no, note, created_at FROM exam_versions WHERE exam_id = ? ORDER BY version_no DESC', e.id) };
  }, { teacher: true });
  route('PUT', '/api/teacher/exams/(\\d+)', (req, m, body) => saveExamVersion(Number(m[1]), body.content, String(body.note || 'Edited on teacher page').slice(0, 200)), { teacher: true });
  route('POST', '/api/teacher/exams', async (req, m, body) => {
    const c = body.content;
    if (!c || !c.code || !c.subject) throw httpError(400, 'New exam JSON needs at least “code”, “subject”, “level”, “classes” and “sections”.');
    if (!Array.isArray(c.sections)) throw httpError(400, 'Exam content must be a JSON object with a “sections” list.');
    const ins = await db.run('INSERT INTO exams(code, subject, level, classes_json, status, updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING',
      c.code, c.subject, c.level || '', JSON.stringify(c.classes || []), 'draft', db.now());
    if (!ins.changes) throw httpError(400, 'An exam with that code already exists.');
    const id = (await db.get('SELECT id FROM exams WHERE code = ?', c.code)).id;
    return { id, ...(await saveExamVersion(id, c, 'Created on teacher page')) };
  }, { teacher: true });
  route('POST', '/api/teacher/exams/(\\d+)/publish', async (req, m, body) => {
    const id = Number(m[1]);
    if (body.publish) {
      const v = exams.validate((await currentContent(id)).content);
      if (v.errors.length) throw httpError(400, 'This test cannot be made available until these problems are fixed:\n• ' + v.errors.join('\n• '));
    }
    await db.run('UPDATE exams SET status = ?, updated_at = ? WHERE id = ?', body.publish ? 'published' : 'draft', db.now(), id);
    await db.audit('teacher', body.publish ? 'exam_published' : 'exam_unpublished', { id });
    return { ok: true };
  }, { teacher: true });
  route('POST', '/api/teacher/exams/(\\d+)/approve-schemes', async (req, m, body) => {
    const id = Number(m[1]);
    const content = (await currentContent(id)).content;
    const ids = Array.isArray(body.questionIds) ? body.questionIds : null;
    let n = 0;
    for (const s of content.sections) for (const q of s.questions) {
      if (q.type === 'essay' && q.scheme && q.scheme.status !== 'approved' && (!ids || ids.includes(q.id))) { q.scheme.status = 'approved'; q.scheme.approvedAt = db.now(); n++; }
    }
    if (!n) throw httpError(400, 'There are no draft mark schemes to approve.');
    return saveExamVersion(id, content, `Approved ${n} written-response mark scheme(s)`);
  }, { teacher: true });

  route('GET', '/api/teacher/attempts', async (req, m, body, q) => { await maintenance({ budgetMs: 3000 }); return attemptsList(q); }, { teacher: true });
  route('GET', '/api/teacher/attempts/(\\d+)', (req, m) => attemptDetail(Number(m[1])), { teacher: true });
  route('GET', '/api/teacher/review', async () => { await maintenance({ budgetMs: 8000 }); return reviewQueue(); }, { teacher: true });
  route('POST', '/api/teacher/marks/(\\d+)/override', async (req, m, body) => {
    const saved = await marking.override(db, Number(m[1]), body.criteria || {}, body.reason, 'examiner');
    await db.audit('examiner', 'mark_override', { markId: saved.id, total: saved.total, reason: body.reason });
    return { ok: true, mark: saved };
  }, { teacher: true });
  route('POST', '/api/teacher/marks/(\\d+)/retry', async (req, m) => {
    const saved = await marking.retry(db, Number(m[1]), 'examiner');
    if (worker) setImmediate(() => worker.tick());
    if (serverless) await marking.processDue(db, { attemptId: saved.attempt_id, budgetMs: 8000 });
    return { ok: true, mark: saved };
  }, { teacher: true });
  route('POST', '/api/teacher/attempts/(\\d+)/submit', async (req, m) => {
    const a = await db.get('SELECT * FROM attempts WHERE id = ?', Number(m[1]));
    if (!a) throw httpError(404, 'Submission not found.');
    await submitAttempt(a, 'teacher');
    await db.audit('teacher', 'attempt_submitted_by_teacher', { id: a.id });
    return { ok: true };
  }, { teacher: true });

  route('GET', '/api/teacher/students', (req, m, body, q) => studentsList(q), { teacher: true });
  route('PUT', '/api/teacher/comments', async (req, m, body) => {
    const adm = normAdm(body.admNorm), session = String(body.session || ''), term = String(body.term || '');
    if (!adm || !session || !term) throw httpError(400, 'Missing student, session or term.');
    await db.run(`INSERT INTO comments(adm_norm, session, term, teacher_comment, principal_comment, updated_at) VALUES(?,?,?,?,?,?)
            ON CONFLICT(adm_norm, session, term) DO UPDATE SET teacher_comment = excluded.teacher_comment, principal_comment = excluded.principal_comment, updated_at = excluded.updated_at`,
    adm, session, term, String(body.teacherComment || '').slice(0, 600), String(body.principalComment || '').slice(0, 600), db.now());
    return { ok: true };
  }, { teacher: true });
  const sessionTerm = async (q) => { const st = await db.settingsMap(); return [q.get('session') || st.session, q.get('term') || st.term]; };
  route('GET', '/api/teacher/sheet.pdf', async (req, m, body, q) => {
    const [session, term] = await sessionTerm(q);
    const { pdf } = await sheetPdfFor(normAdm(q.get('adm')), session, term);
    return { file: pdf, type: 'application/pdf', name: `Result-${normAdm(q.get('adm')).replace(/\W+/g, '-')}.pdf`, inline: true };
  }, { teacher: true });
  route('GET', '/api/teacher/sheet.json', async (req, m, body, q) => { const [session, term] = await sessionTerm(q); return scoring.sheetFor(db, normAdm(q.get('adm')), session, term); }, { teacher: true });
  route('GET', '/api/teacher/broadsheet\\.(csv|xlsx|json)', async (req, m, body, q) => {
    const [session, term] = await sessionTerm(q);
    const filt = { level: q.get('level') || '', className: q.get('className') || '', subject: q.get('subject') || '', session, term };
    if (!filt.level && !filt.className) throw httpError(400, 'Choose a section or a class for the broadsheet.');
    const bs = await scoring.broadsheet(db, filt);
    if (m[1] === 'json') return bs;
    const st = await db.settingsMap();
    const scope = filt.className || `${filt.level} section`;
    const title = `${st.school_name} — ${st.assessment_name} — ${scope} broadsheet — ${session}, ${term}${filt.subject ? ' — ' + filt.subject : ''}`;
    const fname = `Broadsheet-${scope.replace(/\W+/g, '-')}-${session.replace(/\W+/g, '-')}-${term.replace(/\W+/g, '-')}`;
    if (m[1] === 'csv') return { file: Buffer.from(reports.broadsheetCSV(bs, title), 'utf8'), type: 'text/csv; charset=utf-8', name: fname + '.csv' };
    return { file: reports.broadsheetXLSX(bs, title), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: fname + '.xlsx' };
  }, { teacher: true });

  const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
  const PAGES = { '/': 'index.html', '/test': 'test.html', '/result': 'result.html', '/teacher': 'teacher.html' };

  function readBody(req) {
    // On Vercel the platform may already have read and parsed the body.
    if (req.body !== undefined && req.body !== null) {
      if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
        const s = req.body.toString('utf8');
        if (!s) return Promise.resolve({});
        try { return Promise.resolve(JSON.parse(s)); } catch (_) { return Promise.reject(httpError(400, 'Invalid request.')); }
      }
      if (typeof req.body === 'object') return Promise.resolve(req.body);
    }
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > 4 * 1024 * 1024) { reject(httpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(httpError(400, 'Invalid request.')); }
      });
      req.on('error', reject);
    });
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    // Vercel rewrites /api/... to /api/index?__p=/api/...; restore the original path.
    if (url.searchParams.has('__p')) { url.pathname = url.searchParams.get('__p'); url.searchParams.delete('__p'); }
    try {
      if (url.pathname.startsWith('/api/')) {
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) throw httpError(404, 'Not found.');
        if (r.teacher) {
          if (!(await teacherFromReq(req))) throw httpError(401, 'Please sign in to the teacher page.');
          if (req.method !== 'GET' && req.headers['x-cbt'] !== '1') throw httpError(403, 'Request blocked.');
        }
        const body = req.method === 'GET' ? {} : await readBody(req);
        const out = await r.handler(req, url.pathname.match(r.re), body, url.searchParams);
        if (out && out.file) {
          res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': out.type, 'Content-Length': out.file.length, 'Cache-Control': 'no-store',
            'Content-Disposition': `${out.inline ? 'inline' : 'attachment'}; filename="${out.name}"` });
          return res.end(out.file);
        }
        const extra = {};
        if (out && out.cookie) { extra['Set-Cookie'] = out.cookie; delete out.cookie; }
        return sendJson(res, 200, out, extra);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed.');
      const rel = PAGES[url.pathname] || url.pathname.replace(/^\/+/, '');
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw httpError(404, 'Page not found.');
      res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(file));
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server. Please try again.' : e.message, ...(e.extra || {}) });
    }
  }

  // ---- background jobs (only when running as a normal server) ----
  function startBackground() {
    worker = marking.startWorker(db);
    sweeper = setInterval(() => { sweepExpired(true).catch((e) => console.error('sweep failed', e)); }, 10000);
    sweeper.unref();
  }
  function stopBackground() { if (worker) worker.stop(); if (sweeper) clearInterval(sweeper); }

  return {
    db, serverless, handler, startBackground, stopBackground, submitAttempt, sweepExpired,
    tickWorker: async () => { if (worker) await worker.tick(); else await marking.processDue(db, { budgetMs: 5000 }); },
  };
}

module.exports = { createApp };
