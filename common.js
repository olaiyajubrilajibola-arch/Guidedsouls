'use strict';
/* Shared helpers for every page. */
const CBT = (() => {
  async function api(method, url, body, extraHeaders) {
    const opts = { method, headers: { ...(extraHeaders || {}) }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(url, opts); } catch (e) { const err = new Error('Cannot reach the server. Check your connection.'); err.offline = true; throw err; }
    let data = {};
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.status = res.status; err.data = data; throw err; }
    return data;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const fmt2 = (x) => (x == null ? '' : Number(x).toFixed(2));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
  };
  function schoolHeader(el, school, extra) {
    const initials = (school.name || 'S').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    el.innerHTML = `${school.logo ? `<img src="${esc(school.logo)}" alt="">` : `<div class="logo-fallback" aria-hidden="true">${esc(initials)}</div>`}
      <div><div class="name">${esc(school.name)}</div>${extra ? `<div class="term">${esc(extra)}</div>` : ''}</div>`;
  }
  function wordCount(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }
  return { api, esc, $, $$, fmt2, store, schoolHeader, wordCount };
})();
