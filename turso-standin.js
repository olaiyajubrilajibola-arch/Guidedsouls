'use strict';
// A small stand-in for Turso Cloud's "SQL over HTTP" API (POST /v2/pipeline), backed by a local SQLite file.
// It follows the documented request/response format, opens a separate connection per stream (so transactions
// and locking behave like a real server), adds a little network-like delay, and checks the bearer token.
const http = require('http');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function startStandIn(file, token) {
  const streams = new Map();
  const open = () => { const c = new DatabaseSync(file); c.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;'); return c; };
  const val = (v) => {
    if (!v || v.type === 'null') return null;
    if (v.type === 'integer') return BigInt(v.value) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v.value) : BigInt(v.value);
    if (v.type === 'float') return Number(v.value);
    if (v.type === 'blob') return Buffer.from(v.base64, 'base64');
    return v.value;
  };
  const cell = (x) => {
    if (x === null || x === undefined) return { type: 'null' };
    if (typeof x === 'bigint') return { type: 'integer', value: x.toString() };
    if (typeof x === 'number') return Number.isInteger(x) ? { type: 'integer', value: String(x) } : { type: 'float', value: String(x) };
    if (Buffer.isBuffer(x) || x instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(x).toString('base64') };
    return { type: 'text', value: String(x) };
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      await new Promise((r) => setTimeout(r, 1 + Math.random() * 4));
      if (req.url !== '/v2/pipeline' || req.method !== 'POST') { res.writeHead(404); return res.end('not found'); }
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('unauthorized'); }
      const { baton, requests } = JSON.parse(body);
      let conn;
      if (baton) { conn = streams.get(baton); if (!conn) { res.writeHead(400); return res.end('invalid baton'); } streams.delete(baton); } else conn = open();
      const results = [];
      let closed = false;
      for (const r of requests) {
        if (r.type === 'close') { closed = true; results.push({ type: 'ok', response: { type: 'close' } }); continue; }
        try {
          const st = conn.prepare(r.stmt.sql);
          st.setReadBigInts(true);
          const args = (r.stmt.args || []).map(val);
          const cols = st.columns().map((c) => ({ name: c.name, decltype: c.type }));
          let rows = [], affected = 0, last = null;
          if (cols.length) rows = st.all(...args).map((row) => cols.map((c) => cell(row[c.name])));
          else { const info = st.run(...args); affected = Number(info.changes); last = info.lastInsertRowid != null ? String(info.lastInsertRowid) : null; }
          results.push({ type: 'ok', response: { type: 'execute', result: { cols, rows, affected_row_count: affected, last_insert_rowid: last, replication_index: '1', rows_read: rows.length, rows_written: affected, query_duration_ms: 0.1 } } });
        } catch (e) {
          results.push({ type: 'error', error: { message: e.message, code: /locked|busy/i.test(e.message) ? 'SQLITE_BUSY' : 'SQLITE_ERROR' } });
        }
      }
      let newBaton = null;
      if (closed) conn.close();
      else { newBaton = crypto.randomBytes(12).toString('hex'); streams.set(newBaton, conn); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ baton: newBaton, base_url: null, results }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, server })));
}

module.exports = { startStandIn };
