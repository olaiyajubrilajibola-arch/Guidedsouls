'use strict';
// Storage layer with one async API and two drivers:
//   • local  — a SQLite file on this computer (Node's built-in node:sqlite), for running at school
//   • turso  — Turso Cloud over HTTPS (SQLite-compatible), for serverless hosting such as Vercel
// Every query uses the same SQL, so the rest of the app does not care which driver is active.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const exams = require('./exams');

const DEFAULT_GRADES = [
  { min: 75, grade: 'A1', remark: 'Excellent' },
  { min: 70, grade: 'B2', remark: 'Very good' },
  { min: 65, grade: 'B3', remark: 'Good' },
  { min: 60, grade: 'C4', remark: 'Credit' },
  { min: 55, grade: 'C5', remark: 'Credit' },
  { min: 50, grade: 'C6', remark: 'Credit' },
  { min: 45, grade: 'D7', remark: 'Pass' },
  { min: 40, grade: 'E8', remark: 'Pass' },
  { min: 0, grade: 'F9', remark: 'Fail' },
];

const DEFAULT_SETTINGS = {
  school_name: 'Guided Souls Schools',
  assessment_name: 'First Term Test',
  school_logo: '',
  school_logo_w: '',
  school_logo_h: '',
  session: '2026/2027',
  term: 'First Term',
  grading_scale: JSON.stringify(DEFAULT_GRADES),
  feedback_release_mode: 'never',      // never | immediate | scheduled
  feedback_release_at: '',
  positions_enabled: '1',
  ai_api_key: '',
  ai_model: 'claude-sonnet-5-5',
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY, code TEXT UNIQUE, subject TEXT, level TEXT, classes_json TEXT,
    status TEXT NOT NULL DEFAULT 'draft', current_version_id INTEGER, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS exam_versions (
    id INTEGER PRIMARY KEY, exam_id INTEGER NOT NULL, version_no INTEGER NOT NULL, content_json TEXT NOT NULL,
    note TEXT, created_at TEXT, UNIQUE(exam_id, version_no))`,
  `CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, result_code TEXT UNIQUE NOT NULL,
    student_name TEXT NOT NULL, adm_no TEXT NOT NULL, adm_norm TEXT NOT NULL, level TEXT NOT NULL, class TEXT NOT NULL,
    exam_id INTEGER NOT NULL, exam_version_id INTEGER NOT NULL, subject TEXT NOT NULL, session TEXT NOT NULL, term TEXT NOT NULL,
    started_at TEXT NOT NULL, deadline TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'in_progress',
    submitted_at TEXT, submit_reason TEXT,
    UNIQUE(adm_norm, exam_id, session, term))`,
  `CREATE TABLE IF NOT EXISTS answers (
    attempt_id INTEGER NOT NULL, question_id TEXT NOT NULL, value TEXT, locked INTEGER NOT NULL DEFAULT 0,
    saved_at TEXT, PRIMARY KEY(attempt_id, question_id))`,
  `CREATE TABLE IF NOT EXISTS marks (
    id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL, question_id TEXT NOT NULL, question_type TEXT,
    question_version TEXT, scheme_version TEXT, answer TEXT, method TEXT, engine_version TEXT,
    criteria_json TEXT, total REAL, max REAL, status TEXT NOT NULL, flags_json TEXT, summary TEXT,
    tries INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_try_at TEXT, marked_at TEXT, updated_at TEXT,
    UNIQUE(attempt_id, question_id))`,
  `CREATE TABLE IF NOT EXISTS mark_revisions (
    id INTEGER PRIMARY KEY, mark_id INTEGER NOT NULL, attempt_id INTEGER NOT NULL, question_id TEXT NOT NULL,
    revision_no INTEGER NOT NULL, kind TEXT NOT NULL, method TEXT, engine_version TEXT, criteria_json TEXT, total REAL,
    status TEXT, flags_json TEXT, reason TEXT, actor TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS results (
    attempt_id INTEGER PRIMARY KEY, raw_json TEXT, raw_total REAL, raw_max REAL, final_exact REAL, final_score REAL,
    percentage REAL, grade TEXT, remark TEXT, status TEXT NOT NULL, published_at TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS comments (
    adm_norm TEXT NOT NULL, session TEXT NOT NULL, term TEXT NOT NULL, teacher_comment TEXT, principal_comment TEXT,
    updated_at TEXT, PRIMARY KEY(adm_norm, session, term))`,
  `CREATE TABLE IF NOT EXISTS teacher_sessions (token TEXT PRIMARY KEY, created_at TEXT, expires_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, actor TEXT, action TEXT, details TEXT, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_marks_status ON marks(status, next_try_at)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_filter ON attempts(session, term, level, class)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_deadline ON attempts(status, deadline)`,
  `CREATE INDEX IF NOT EXISTS idx_revisions_mark ON mark_revisions(mark_id)`,
];

const now = () => new Date().toISOString();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `scrypt:${salt}:${h}`;
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [, salt, h] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(h, 'hex'));
}

const isBusy = (e) => /SQLITE_BUSY|database is locked|database table is locked/i.test(String(e && e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------
// Local driver: node:sqlite. All access is serialised through one queue so a transaction is never interleaved.
function localDriver(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  let chain = Promise.resolve();
  const lock = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const execNow = (sql, params) => {
    const st = db.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) return { rows: st.all(...params).map((r) => ({ ...r })) };
    const r = st.run(...params);
    return { rows: [], changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  };
  return {
    name: 'local',
    exec: (sql, params) => lock(() => execNow(sql, params)),
    async tx(fn) {
      return lock(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const r = await fn({ exec: async (sql, params) => execNow(sql, params) });
          db.exec('COMMIT');
          return r;
        } catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ } throw e; }
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Turso driver: SQL over HTTP (POST /v2/pipeline). Transactions keep one connection open with the "baton".
function tursoDriver(url, token) {
  let base = String(url).replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  const encode = (v) => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: String(v) };
    if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
    if (Buffer.isBuffer(v)) return { type: 'blob', base64: v.toString('base64') };
    return { type: 'text', value: String(v) };
  };
  const decode = (c) => {
    if (!c || c.type === 'null') return null;
    if (c.type === 'integer' || c.type === 'float') return Number(c.value);
    if (c.type === 'blob') return Buffer.from(c.base64 || '', 'base64');
    return c.value;
  };
  const stmt = (sql, params) => ({ type: 'execute', stmt: { sql, args: (params || []).map(encode) } });
  function toResult(r) {
    if (!r || r.type !== 'ok') {
      const err = (r && r.error) || {};
      throw Object.assign(new Error(`Database error: ${err.message || 'unknown'}`), { code: err.code });
    }
    const res = r.response && r.response.result;
    if (!res) return { rows: [] };
    const names = (res.cols || []).map((c) => c.name);
    return {
      rows: (res.rows || []).map((row) => Object.fromEntries(row.map((cell, i) => [names[i], decode(cell)]))),
      changes: Number(res.affected_row_count || 0),
      lastInsertRowid: res.last_insert_rowid == null ? 0 : Number(res.last_insert_rowid),
    };
  }
  async function pipeline(requests, baton) {
    let res;
    try {
      res = await fetch(base + '/v2/pipeline', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ baton: baton || null, requests }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) { throw Object.assign(new Error('Cannot reach the database: ' + e.message), { network: true }); }
    const text = await res.text();
    if (!res.ok) throw new Error(`Database returned ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    if (body.base_url) base = String(body.base_url).replace(/\/+$/, '');
    return body;
  }
  return {
    name: 'turso',
    async exec(sql, params) {
      for (let attempt = 0; ; attempt++) {
        try {
          const body = await pipeline([stmt(sql, params), { type: 'close' }]);
          return toResult(body.results[0]);
        } catch (e) {
          if ((isBusy(e) || (e.network && /^\s*SELECT/i.test(sql))) && attempt < 6) { await sleep(120 * (attempt + 1)); continue; }
          throw e;
        }
      }
    },
    async tx(fn) {
      for (let attempt = 0; ; attempt++) {
        let baton = null, open = false;
        const t = {
          async exec(sql, params) {
            const reqs = open ? [stmt(sql, params)] : [stmt('BEGIN IMMEDIATE', []), stmt(sql, params)];
            const body = await pipeline(reqs, baton);
            baton = body.baton;
            if (!open) { toResult(body.results[0]); open = true; }
            return toResult(body.results[body.results.length - 1]);
          },
        };
        try {
          const r = await fn(t);
          if (open) {
            const body = await pipeline([stmt('COMMIT', []), { type: 'close' }], baton);
            toResult(body.results[0]);
          }
          return r;
        } catch (e) {
          if (open && baton) { try { await pipeline([stmt('ROLLBACK', []), { type: 'close' }], baton); } catch (_) { /* connection may be gone */ } }
          if (isBusy(e) && attempt < 4) { await sleep(150 * (attempt + 1)); continue; }
          throw e;
        }
      }
    },
  };
}

// Finds Turso connection details in the environment, whatever names the hosting integration used.
function tursoFromEnv(env = process.env) {
  const urlKeys = ['TURSO_DATABASE_URL', 'TURSO_URL', 'LIBSQL_URL', 'DATABASE_URL', 'TURSO_DB_URL'];
  const tokenKeys = ['TURSO_AUTH_TOKEN', 'TURSO_TOKEN', 'LIBSQL_AUTH_TOKEN', 'DATABASE_AUTH_TOKEN', 'TURSO_DB_AUTH_TOKEN'];
  let url = urlKeys.map((k) => env[k]).find((v) => v && /^(libsql|https?):\/\//.test(v));
  if (!url) { const k = Object.keys(env).find((key) => /^libsql:\/\//.test(env[key] || '')); if (k) url = env[k]; }
  let token = tokenKeys.map((k) => env[k]).find(Boolean);
  if (!token) { const k = Object.keys(env).find((key) => /(TURSO|LIBSQL).*TOKEN/i.test(key) && env[key]); if (k) token = env[k]; }
  return url ? { url, token: token || '' } : null;
}

// ---------------------------------------------------------------------------------------------------------------
function wrap(execFn) {
  const api = {
    async get(sql, ...p) { return (await execFn(sql, p)).rows[0]; },
    async all(sql, ...p) { return (await execFn(sql, p)).rows; },
    async run(sql, ...p) { const r = await execFn(sql, p); return { changes: r.changes || 0, lastInsertRowid: r.lastInsertRowid || 0, rows: r.rows }; },
  };
  return api;
}

async function open({ file, turso } = {}) {
  const driver = turso ? tursoDriver(turso.url, turso.token) : localDriver(file);
  let cache = null, cacheAt = 0;
  const TTL = 3000;

  function attach(base) {
    const api = {
      ...base,
      driver: driver.name,
      now,
      hashPassword, checkPassword,
      async settingsMap(fresh) {
        if (!fresh && cache && Date.now() - cacheAt < TTL) return cache;
        const rows = await base.all('SELECT key, value FROM settings');
        cache = { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
        cacheAt = Date.now();
        return cache;
      },
      async setting(key) { return (await api.settingsMap())[key]; },
      async setSetting(key, value) {
        await base.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value ?? ''));
        cache = null;
      },
      async audit(actor, action, details) {
        await base.run('INSERT INTO audit_log(actor, action, details, created_at) VALUES(?,?,?,?)', actor, action, JSON.stringify(details || {}), now());
      },
    };
    return api;
  }

  const root = attach(wrap((sql, p) => driver.exec(sql, p)));
  root.tx = (fn) => driver.tx((t) => fn(attach(wrap((sql, p) => t.exec(sql, p)))));

  // Schema, default settings and the three source examinations (each published only if it validates).
  for (const s of SCHEMA) await root.run(s);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await root.run('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)', k, v);
  for (const content of exams.loadSeeds()) {
    const ins = await root.run('INSERT OR IGNORE INTO exams(code, subject, level, classes_json, status, updated_at) VALUES(?,?,?,?,?,?)',
      content.code, content.subject, content.level, JSON.stringify(content.classes), 'draft', now());
    if (!ins.changes) continue;
    const exam = await root.get('SELECT id FROM exams WHERE code = ?', content.code);
    const v = await root.run('INSERT INTO exam_versions(exam_id, version_no, content_json, note, created_at) VALUES(?,?,?,?,?)',
      exam.id, 1, JSON.stringify(content), 'Imported from the source documents', now());
    const versionId = v.lastInsertRowid || (await root.get('SELECT id FROM exam_versions WHERE exam_id = ? AND version_no = 1', exam.id)).id;
    const valid = exams.validate(content).errors.length === 0;
    await root.run('UPDATE exams SET current_version_id = ?, status = ? WHERE id = ?', versionId, valid ? 'published' : 'draft', exam.id);
  }
  // Bring untouched imported tests up to date (e.g. the Advanced letter/essay criteria now in use by default).
  // Only applies while a test is still the original import and nobody has written it yet; teacher edits are never replaced.
  for (const content of exams.loadSeeds()) {
    const row = await root.get(`SELECT e.id, e.status, v.version_no, v.note, v.content_json FROM exams e JOIN exam_versions v ON v.id = e.current_version_id WHERE e.code = ?`, content.code);
    if (!row || row.version_no !== 1 || row.note !== 'Imported from the source documents') continue;
    if (row.content_json === JSON.stringify(content)) continue;
    const used = await root.get('SELECT COUNT(*) AS n FROM attempts WHERE exam_id = ?', row.id);
    if (used.n) continue;
    const ins = await root.run('INSERT OR IGNORE INTO exam_versions(exam_id, version_no, content_json, note, created_at) VALUES(?,?,?,?,?)',
      row.id, 2, JSON.stringify(content), 'Updated to the latest built-in version', now());
    if (!ins.changes) continue;
    const ver = await root.get('SELECT id FROM exam_versions WHERE exam_id = ? AND version_no = 2', row.id);
    const valid = exams.validate(content).errors.length === 0;
    await root.run('UPDATE exams SET current_version_id = ?, status = ?, updated_at = ? WHERE id = ?', ver.id, valid ? 'published' : row.status, now(), row.id);
  }
  if (driver.name === 'local') await root.run("UPDATE marks SET status = 'queued' WHERE status = 'processing'");
  return root;
}

module.exports = { open, tursoFromEnv, DEFAULT_GRADES, DEFAULT_SETTINGS, now };
