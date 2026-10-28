'use strict';
(async () => {
  const { api, esc, $, store, schoolHeader, fmt2 } = CBT;
  let timer = null;
  const params = new URLSearchParams(location.search);
  let code = (params.get('code') || store.get('cbt_last_result') || '').toUpperCase();

  try { const cfg = await api('GET', '/api/config'); schoolHeader($('#schoolHead'), { name: cfg.schoolName, logo: cfg.logo }, `${cfg.assessmentName} • ${cfg.session} session • ${cfg.term}`); } catch (_) { /* header optional */ }

  function codeBlock(r) {
    const link = `${location.origin}/result?code=${encodeURIComponent(r.code)}`;
    return `<div class="notice info"><strong>Keep your result code:</strong><br><span class="code-box" style="margin:8px 0">${esc(r.code)}</span><br>
      <span class="small">You can come back any time to <a href="${esc(link)}">${esc(link)}</a> or enter this code below. No account is needed.</span></div>`;
  }
  function details(r) {
    return `<dl class="kv"><dt>Name</dt><dd>${esc(r.student.name)}</dd><dt>Admission no.</dt><dd>${esc(r.student.admNo)}</dd>
      <dt>Section</dt><dd>${esc(r.student.level)}</dd><dt>Class</dt><dd>${esc(r.student.className)}</dd><dt>Subject</dt><dd>${esc(r.subject)}</dd>
      <dt>Session</dt><dd>${esc(r.session)}</dd><dt>Term</dt><dd>${esc(r.term)}</dd></dl>`;
  }
  function feedbackHtml(fb) {
    if (!fb) return '';
    return `<div class="card" style="margin-top:16px"><h2>Marking feedback</h2>${fb.map((s) => `
      <div class="fb-section"><h3>${esc(s.title)}</h3>${s.questions.map((q) => `
        <div class="fb-row"><span>${esc(q.label || 'Question ' + q.num)}</span><strong>${fmt2(q.awarded).replace(/\.00$/, '')} / ${q.max}</strong></div>
        ${q.criteria ? `<div class="small" style="padding:4px 0 8px 12px">${q.criteria.map((c) => `<div><strong>${esc(c.name)}:</strong> ${fmt2(c.awarded).replace(/\.00$/, '')} / ${c.max}${c.feedback ? ' — ' + esc(c.feedback) : ''}</div>`).join('')}${q.comment ? `<div class="muted">${esc(q.comment)}</div>` : ''}</div>` : ''}`).join('')}</div>`).join('')}</div>`;
  }

  async function show(c) {
    clearTimeout(timer);
    if (!c) { $('#out').innerHTML = ''; return; }
    let r;
    try { r = await api('GET', '/api/result/' + encodeURIComponent(c)); } catch (e) {
      $('#out').innerHTML = ''; $('#codeMsg').innerHTML = `<div class="notice error">${esc(e.message)}</div>`; return;
    }
    $('#codeMsg').innerHTML = '';
    store.set('cbt_last_result', r.code);
    $('#code').value = r.code;
    let main;
    if (r.status === 'complete') {
      main = `<div class="card">
        <p class="muted" style="margin:0">Your result</p>
        <div class="big-score">Score: ${esc(fmt2(r.score))} / 40</div>
        <p style="font-size:1.1rem"><strong>Grade ${esc(r.grade)}</strong> — ${esc(r.remark)} <span class="muted">(${esc(fmt2(r.percentage))}%)</span></p>
        ${details(r)}
        <p style="margin-top:18px"><a class="btn btn-primary btn-big" href="/api/result/${encodeURIComponent(r.code)}/pdf">Download Result as PDF</a></p>
        ${codeBlock(r)}
      </div>${feedbackHtml(r.feedback)}`;
    } else if (r.status === 'pending_review') {
      main = `<div class="card"><h1>Result pending review</h1>
        <p>Your test was submitted successfully. A teacher needs to check part of your work before your result is ready.</p>
        ${details(r)}${codeBlock(r)}</div>`;
    } else if (r.status === 'marking') {
      main = `<div class="card"><h1><span class="spinner"></span> Marking your answers…</h1><p>Your test was submitted. This page updates by itself.</p>${details(r)}${codeBlock(r)}</div>`;
      timer = setTimeout(() => show(r.code), 4000);
    } else {
      main = `<div class="card"><h1>Test still in progress</h1><p>This test has not been submitted yet.</p><a class="btn btn-primary" href="/">Go to the start page</a></div>`;
    }
    $('#out').innerHTML = main;
  }

  $('#codeForm').addEventListener('submit', (e) => { e.preventDefault(); const c = $('#code').value.trim().toUpperCase(); if (c) { history.replaceState(null, '', '/result?code=' + encodeURIComponent(c)); show(c); } });
  show(code);
})();
