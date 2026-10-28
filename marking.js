'use strict';
// Marking pipeline: objective keys → deterministic rules → AI-assisted criteria → examiner review.
// Every change to a mark is appended to mark_revisions, so the original assessment is never lost.

const grammar = require('./grammar');
const ai = require('./ai');
const exams = require('./exams');
const scoring = require('./scoring');

const OBJECTIVE_ENGINE = 'objective-key 1.0';
const BACKOFF_MS = process.env.CBT_RETRY_FAST ? [0, 50, 100, 150] : [0, 5000, 30000, 120000];
const MAX_TRIES = BACKOFF_MS.length;

const INJECTION = /\b(ignore|disregard|forget|override)\b.{0,40}\b(instruction|rule|scheme|prompt|previous|above)s?\b|\b(award|give|grant)\b.{0,20}\b(full|maximum|max|all|10|ten|100)\b.{0,10}\bmarks?\b|\byou are (now )?(an?|the) (examiner|marker|assistant|ai)\b|\bsystem prompt\b|\bmark ?scheme says\b/i;

const wc = (s) => grammar.wordCount(s);

async function aiConfig(db) {
  const st = await db.settingsMap();
  return { apiKey: process.env.ANTHROPIC_API_KEY || st.ai_api_key, model: process.env.CBT_AI_MODEL || st.ai_model };
}

function objective(q, answer) {
  const val = String(answer ?? '').trim();
  const correct = val !== '' && (q.type === 'mcq' ? val === q.answer : val.toLowerCase() === String(q.answer).toLowerCase());
  return {
    method: 'key', engine: OBJECTIVE_ENGINE, status: 'final', flags: [],
    criteria: [{ id: 'key', name: 'Answer key', max: q.marks, awarded: correct ? q.marks : 0, evidence: val ? [val] : [], reason: val ? (correct ? 'Matches the answer key.' : 'Does not match the answer key.') : 'No answer.', feedback: correct ? 'Correct.' : val ? 'Not correct.' : 'No answer given.' }],
    total: correct ? q.marks : 0,
  };
}

function shortRules(q, answer) {
  const blank = !String(answer ?? '').trim();
  const criteria = q.scheme.criteria.map((c) => {
    const r = blank ? { awarded: false, certain: true, evidence: [], reason: 'No answer.', feedback: 'No answer given.' } : grammar.applyRule(answer, c.rule);
    return { id: c.id, name: c.desc, max: c.marks, awarded: r.awarded ? c.marks : 0, certain: r.certain, evidence: r.evidence, reason: r.reason, feedback: r.feedback, method: 'rules' };
  });
  const flags = [];
  if (!blank && INJECTION.test(String(answer))) flags.push('possible_instruction_in_answer');
  const uncertain = criteria.some((c) => !c.certain);
  return {
    method: 'deterministic', engine: grammar.ENGINE, criteria, flags,
    total: criteria.reduce((s, c) => s + c.awarded, 0),
    status: uncertain ? 'needs_ai' : flags.length ? 'review' : 'final',
  };
}

function essayStart(q, answer) {
  const text = String(answer ?? '');
  if (!text.trim()) {
    return {
      method: 'deterministic', engine: 'blank-check 1.0', status: 'final', flags: [], total: 0,
      criteria: q.scheme.criteria.map((c) => ({ id: c.id, name: c.name, max: c.marks, awarded: 0, evidence: [], reason: 'Blank response.', feedback: 'No answer given.', method: 'rules' })),
    };
  }
  const flags = INJECTION.test(text) ? ['possible_instruction_in_answer'] : [];
  return {
    method: 'ai', engine: ai.ENGINE, status: 'needs_ai', flags, total: 0,
    criteria: q.scheme.criteria.map((c) => ({ id: c.id, name: c.name, max: c.marks, awarded: 0, evidence: [], reason: 'Awaiting automatic marking.', feedback: '', method: 'ai', certain: false })),
  };
}

function initialOutcome(q, answer) {
  if (q.type === 'mcq' || q.type === 'bank') return objective(q, answer);
  if (q.type === 'short') return shortRules(q, answer);
  if (q.type === 'essay') return essayStart(q, answer);
  return { method: 'none', engine: 'none', status: 'review', flags: ['unsupported_question_type'], total: 0, criteria: [] };
}

const markFields = (q, answer, outcome) => {
  const total = Math.min(Number(q.marks), Math.max(0, outcome.total));
  return { total, fields: [q.type, exams.questionVersion(q), exams.schemeVersion(q), String(answer ?? ''), outcome.method, outcome.engine,
    JSON.stringify(outcome.criteria), total, Number(q.marks), outcome.status, JSON.stringify(outcome.flags || []), outcome.summary || ''] };
};

async function saveMark(db, attemptId, q, answer, outcome, kind, actor, reason) {
  const ts = db.now();
  const existing = await db.get('SELECT * FROM marks WHERE attempt_id = ? AND question_id = ?', attemptId, q.id);
  const { total, fields } = markFields(q, answer, outcome);
  let id;
  if (existing) {
    await db.run(`UPDATE marks SET question_type=?, question_version=?, scheme_version=?, answer=?, method=?, engine_version=?, criteria_json=?, total=?, max=?,
            status=?, flags_json=?, summary=?, tries=?, last_error=?, next_try_at=?, marked_at=?, updated_at=? WHERE id=?`,
    ...fields, outcome.tries ?? existing.tries, outcome.lastError ?? null, outcome.nextTryAt ?? null, ts, ts, existing.id);
    id = existing.id;
  } else {
    await db.run(`INSERT INTO marks(question_type, question_version, scheme_version, answer, method, engine_version, criteria_json, total, max,
            status, flags_json, summary, tries, last_error, next_try_at, marked_at, updated_at, attempt_id, question_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ...fields, outcome.tries ?? 0, outcome.lastError ?? null, outcome.nextTryAt ?? null, ts, ts, attemptId, q.id);
    id = (await db.get('SELECT id FROM marks WHERE attempt_id = ? AND question_id = ?', attemptId, q.id)).id;
  }
  const rev = (await db.get('SELECT COALESCE(MAX(revision_no), 0) AS n FROM mark_revisions WHERE mark_id = ?', id)).n + 1;
  await db.run(`INSERT INTO mark_revisions(mark_id, attempt_id, question_id, revision_no, kind, method, engine_version, criteria_json, total, status, flags_json, reason, actor, created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, attemptId, q.id, rev, kind, outcome.method, outcome.engine, JSON.stringify(outcome.criteria), total,
  outcome.status, JSON.stringify(outcome.flags || []), reason || null, actor || 'system', ts);
  return db.get('SELECT * FROM marks WHERE id = ?', id);
}

async function prepareOutcome(db, q, answer) {
  const out = initialOutcome(q, answer);
  if (out.status === 'needs_ai') {
    if (ai.configured(await aiConfig(db))) { out.status = 'queued'; out.nextTryAt = db.now(); out.tries = 0; }
    else { out.status = 'review'; out.flags = [...out.flags, 'ai_marking_not_configured']; }
  }
  return out;
}

// Mark one question for an attempt (used at confirm time).
async function markQuestion(db, attemptId, q, answer, kind = 'auto') {
  return saveMark(db, attemptId, q, answer, await prepareOutcome(db, q, answer), kind, 'system');
}

function questionMap(content) {
  return Object.fromEntries(exams.allQuestions(content).map((q) => [q.id, q]));
}

// Marks every question of a submitted attempt. Safe to run more than once: questions that already have a mark
// for the same answer are skipped, and the unique (attempt, question) key prevents duplicate marks.
// New marks are written in a few multi-row statements so this stays fast over a network database.
async function markAttempt(db, attemptId) {
  const attempt = await db.get('SELECT * FROM attempts WHERE id = ?', attemptId);
  const content = await scoring.contentFor(db, attempt);
  const answers = Object.fromEntries((await db.all('SELECT question_id, value FROM answers WHERE attempt_id = ?', attemptId)).map((a) => [a.question_id, a.value]));
  const existing = Object.fromEntries((await db.all('SELECT question_id, answer FROM marks WHERE attempt_id = ?', attemptId)).map((m) => [m.question_id, m]));
  const fresh = [];
  for (const q of exams.allQuestions(content)) {
    const ans = String(answers[q.id] ?? '');
    const m = existing[q.id];
    if (m && m.answer === ans) continue;
    if (m) { await markQuestion(db, attemptId, q, ans); continue; }   // answer changed after an earlier mark (rare)
    fresh.push({ q, ans, out: await prepareOutcome(db, q, ans) });
  }
  const ts = db.now();
  for (let i = 0; i < fresh.length; i += 30) {
    const chunk = fresh.slice(i, i + 30);
    const params = [];
    for (const { q, ans, out } of chunk) params.push(...markFields(q, ans, out).fields, out.tries ?? 0, out.nextTryAt ?? null, ts, ts, attemptId, q.id);
    await db.run(`INSERT INTO marks(question_type, question_version, scheme_version, answer, method, engine_version, criteria_json, total, max,
            status, flags_json, summary, tries, next_try_at, marked_at, updated_at, attempt_id, question_id)
            VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}
            ON CONFLICT(attempt_id, question_id) DO NOTHING`, ...params);
    const rp = [];
    const sel = chunk.map(({ q, out }) => {
      rp.push(attemptId, q.id, out.method, out.engine, JSON.stringify(out.criteria), markFields(q, '', out).total, out.status, JSON.stringify(out.flags || []), ts, attemptId, q.id);
      return `SELECT m.id, ?, ?, 1, 'auto', ?, ?, ?, ?, ?, ?, NULL, 'system', ? FROM marks m
              WHERE m.attempt_id = ? AND m.question_id = ? AND NOT EXISTS (SELECT 1 FROM mark_revisions r WHERE r.mark_id = m.id)`;
    });
    await db.run(`INSERT INTO mark_revisions(mark_id, attempt_id, question_id, revision_no, kind, method, engine_version, criteria_json, total, status, flags_json, reason, actor, created_at)
            ${sel.join(' UNION ALL ')}`, ...rp);
  }
  return scoring.computeResult(db, attemptId);
}

// ---- AI processing ---------------------------------------------------------------------------------------------
const squash = (s) => String(s || '').toLowerCase().replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
function evidenceFound(answer, ev) {
  const hay = squash(answer);
  const pieces = String(ev).split(/\.\.\.|…/).map((p) => squash(p).replace(/^["'\s]+|["'\s]+$/g, '')).filter((p) => p.length >= 2);
  return pieces.length > 0 && pieces.every((p) => hay.includes(p));
}

function applyAI(q, answer, mark, reply) {
  const prev = JSON.parse(mark.criteria_json || '[]');
  const flags = new Set(JSON.parse(mark.flags_json || '[]'));
  const byId = Object.fromEntries((reply.criteria || []).map((c) => [c.criterion_id, c]));
  const criteria = prev.map((c) => {
    if (c.certain !== false) return c;            // decided already by rules
    const r = byId[c.id];
    if (!r) { flags.add('ai_missing_criterion'); return { ...c, reason: 'Automatic marking returned no result for this criterion.' }; }
    let m = Number(r.marks_awarded);
    if (!Number.isFinite(m)) { flags.add('ai_invalid_marks'); m = 0; }
    if (m > c.max || m < 0) { flags.add('ai_marks_out_of_range'); m = Math.min(c.max, Math.max(0, m)); }
    if (q.type === 'short' && m !== 0 && m !== c.max) { flags.add('ai_partial_on_all_or_nothing'); m = 0; }
    const stepped = Math.floor(m * 2 + 1e-9) / 2;
    if (q.type === 'essay' && stepped !== m) m = stepped;
    const evidence = (r.evidence || []).filter(Boolean).slice(0, 5);
    if (m > 0 && !evidence.some((e) => evidenceFound(answer, e))) flags.add('evidence_not_verified');
    if (r.confidence === 'low') flags.add('low_confidence');
    return {
      id: c.id, name: c.name, max: c.max, awarded: m, evidence, method: 'ai', confidence: r.confidence,
      reason: [r.reason_awarded && 'Awarded: ' + r.reason_awarded, r.reason_withheld && m < c.max && 'Withheld: ' + r.reason_withheld].filter(Boolean).join(' '),
      feedback: q.type === 'essay' ? [r.reason_awarded, m < c.max ? r.reason_withheld : ''].filter(Boolean).join(' ') : (m > 0 ? 'Correct.' : 'Not correct.'),
    };
  });
  if (reply.off_topic) flags.add('off_topic');
  if (reply.possible_manipulation) flags.add('possible_instruction_in_answer');
  const total = Math.min(Number(q.marks), criteria.reduce((s, c) => s + c.awarded, 0));
  return {
    method: q.type === 'short' ? 'deterministic+ai' : 'ai', engine: `${q.type === 'short' ? grammar.ENGINE + ' + ' : ''}${ai.ENGINE}`,
    criteria, total, flags: [...flags], status: flags.size ? 'review' : 'final',
    summary: reply.overall_comment || '',
  };
}

const STALE_MS = 3 * 60 * 1000;   // a "processing" claim older than this was interrupted (e.g. a serverless timeout)

async function processMark(db, markId) {
  const claimed = await db.run("UPDATE marks SET status = 'processing', updated_at = ? WHERE id = ? AND (status = 'queued' OR (status = 'processing' AND updated_at < ?))",
    db.now(), markId, new Date(Date.now() - STALE_MS).toISOString());
  if (!claimed.changes) return;
  const mark = await db.get('SELECT * FROM marks WHERE id = ?', markId);
  const attempt = await db.get('SELECT * FROM attempts WHERE id = ?', mark.attempt_id);
  const content = await scoring.contentFor(db, attempt);
  const q = questionMap(content)[mark.question_id];
  const cfg = await aiConfig(db);
  let outcome;
  try {
    if (!q) throw new ai.AIError('Question no longer in this exam version.', false);
    const prev = JSON.parse(mark.criteria_json);
    const reply = q.type === 'essay'
      ? await ai.markEssay(cfg, q, mark.answer, wc(mark.answer))
      : await ai.markShort(cfg, q, mark.answer, q.scheme.criteria.filter((c) => prev.find((p) => p.id === c.id && p.certain === false)));
    outcome = applyAI(q, mark.answer, mark, reply);
    outcome.tries = mark.tries + 1;
  } catch (e) {
    const tries = mark.tries + 1;
    const recoverable = e.recoverable !== false;
    const flags = JSON.parse(mark.flags_json || '[]');
    if (recoverable && tries < MAX_TRIES) {
      await db.run('UPDATE marks SET status = ?, tries = ?, last_error = ?, next_try_at = ?, updated_at = ? WHERE id = ?',
        'queued', tries, e.message, new Date(Date.now() + BACKOFF_MS[tries]).toISOString(), db.now(), markId);
      return;
    }
    outcome = { method: mark.method, engine: mark.engine_version, criteria: JSON.parse(mark.criteria_json), total: mark.total, flags: [...new Set([...flags, 'processing_failed'])], status: 'review', tries, lastError: e.message };
  }
  await saveMark(db, mark.attempt_id, q || { id: mark.question_id, type: mark.question_type, marks: mark.max }, mark.answer, outcome, 'auto', 'system');
  await scoring.computeResult(db, mark.attempt_id);
}

// Processes queued AI marking until the time budget runs out. On a server this is called by a timer; on
// serverless hosting (no timers) it is called while handling requests such as the result page refreshing.
async function processDue(db, { attemptId, budgetMs = 8000, limit = 6 } = {}) {
  const started = Date.now();
  let done = 0;
  while (Date.now() - started < budgetMs && done < limit) {
    const stale = new Date(Date.now() - STALE_MS).toISOString();
    const due = attemptId
      ? await db.all("SELECT id FROM marks WHERE attempt_id = ? AND ((status = 'queued' AND (next_try_at IS NULL OR next_try_at <= ?)) OR (status = 'processing' AND updated_at < ?)) ORDER BY id LIMIT 3", attemptId, db.now(), stale)
      : await db.all("SELECT id FROM marks WHERE (status = 'queued' AND (next_try_at IS NULL OR next_try_at <= ?)) OR (status = 'processing' AND updated_at < ?) ORDER BY id LIMIT 3", db.now(), stale);
    if (!due.length) break;
    await Promise.all(due.map((m) => processMark(db, m.id).catch((e) => console.error('marking error', e))));
    done += due.length;
  }
  return done;
}

let running = false;
function startWorker(db, intervalMs = 1500) {
  const tick = async () => {
    if (running) return;
    running = true;
    try { await processDue(db, { budgetMs: 20000, limit: 8 }); } finally { running = false; }
  };
  const t = setInterval(tick, intervalMs);
  t.unref();
  return { tick, stop: () => clearInterval(t) };
}

// ---- examiner actions --------------------------------------------------------------------------------------------
async function override(db, markId, criterionMarks, reason, actor) {
  if (!reason || String(reason).trim().length < 3) throw Object.assign(new Error('A reason is required for every override.'), { status: 400 });
  const mark = await db.get('SELECT * FROM marks WHERE id = ?', markId);
  if (!mark) throw Object.assign(new Error('Mark not found.'), { status: 404 });
  const prev = JSON.parse(mark.criteria_json || '[]');
  const criteria = prev.map((c) => {
    const v = criterionMarks[c.id];
    if (v === undefined || v === null || v === '') return c;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > c.max) throw Object.assign(new Error(`Marks for “${c.name}” must be between 0 and ${c.max}.`), { status: 400 });
    return n === c.awarded ? { ...c } : { ...c, awarded: n, reason: `Examiner: ${String(reason).trim()}`, overriddenFrom: c.awarded, method: 'examiner' };
  });
  const total = criteria.reduce((s, c) => s + c.awarded, 0);
  if (total > mark.max + 1e-9) throw Object.assign(new Error('Total exceeds the question maximum.'), { status: 400 });
  const attempt = await db.get('SELECT * FROM attempts WHERE id = ?', mark.attempt_id);
  const q = questionMap(await scoring.contentFor(db, attempt))[mark.question_id];
  const saved = await saveMark(db, mark.attempt_id, q, mark.answer,
    { method: 'examiner', engine: mark.engine_version, criteria, total, flags: [], status: 'final', summary: mark.summary, tries: mark.tries },
    'override', actor, String(reason).trim());
  await scoring.computeResult(db, mark.attempt_id);
  return saved;
}

async function retry(db, markId, actor) {
  const mark = await db.get('SELECT * FROM marks WHERE id = ?', markId);
  if (!mark) throw Object.assign(new Error('Mark not found.'), { status: 404 });
  const attempt = await db.get('SELECT * FROM attempts WHERE id = ?', mark.attempt_id);
  const q = questionMap(await scoring.contentFor(db, attempt))[mark.question_id];
  const out = initialOutcome(q, mark.answer);
  if (out.status === 'needs_ai') {
    if (!ai.configured(await aiConfig(db))) throw Object.assign(new Error('AI-assisted marking is not configured. Add an API key in Settings, or enter marks manually.'), { status: 400 });
    out.status = 'queued'; out.nextTryAt = db.now(); out.tries = 0;
  }
  const saved = await saveMark(db, mark.attempt_id, q, mark.answer, out, 'retry', actor, 'Examiner requested automatic re-marking');
  await scoring.computeResult(db, mark.attempt_id);
  return saved;
}

module.exports = { markQuestion, markAttempt, processMark, processDue, startWorker, override, retry, aiConfig, questionMap, evidenceFound };
