'use strict';
(() => {
  const { esc, $, $$, fmt2 } = CBT;
  const api = (m, u, b) => CBT.api(m, u, b, { 'X-CBT': '1' });
  let settings = null, examsCache = [], activeTab = 'subs';
  const filterState = {};

  const toast = (t) => { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 3200); };
  const n2 = (x) => (x == null ? '' : fmt2(x).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'));
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const FLAG_TEXT = {
    ai_marking_not_configured: 'AI-assisted marking is not set up, so this answer needs an examiner',
    uncertain_rules: 'Rules could not apply the scheme reliably',
    processing_failed: 'Automatic marking failed after retries',
    possible_instruction_in_answer: 'Answer appears to contain instructions to the marker',
    evidence_not_verified: 'Evidence quoted by the marker was not found in the answer',
    low_confidence: 'Marker had low confidence',
    off_topic: 'Response may be off-topic',
    ai_marks_out_of_range: 'Marker returned marks outside the allowed range',
    ai_missing_criterion: 'Marker skipped a criterion',
    ai_invalid_marks: 'Marker returned invalid marks',
    ai_partial_on_all_or_nothing: 'Marker gave partial credit on an all-or-nothing criterion',
    unsupported_question_type: 'Unsupported question type',
  };
  const statusPill = (a) => {
    if (a.status === 'in_progress') return '<span class="pill info">In progress</span>';
    if (a.result_status === 'complete') return '<span class="pill ok">Complete</span>';
    if (a.result_status === 'pending_review') return '<span class="pill warn">Pending review</span>';
    return '<span class="pill info">Marking…</span>';
  };

  // ---------- auth ----------
  async function boot() {
    try { await api('GET', '/api/teacher/me'); showApp(); } catch (e) { $('#login').classList.remove('hidden'); $('#pw').focus(); }
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/teacher/login', { password: $('#pw').value }); $('#pw').value = ''; $('#login').classList.add('hidden'); showApp(); }
    catch (err) { $('#loginMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });
  $('#logout').onclick = async () => { await api('POST', '/api/teacher/logout').catch(() => {}); location.reload(); };

  async function showApp() {
    $('#app').classList.remove('hidden');
    settings = await api('GET', '/api/teacher/settings');
    examsCache = await api('GET', '/api/teacher/exams');
    refreshTop();
    openTab(activeTab);
  }
  async function refreshTop() {
    $('#brand').textContent = `${settings.schoolName} — Teacher page`;
    $('#topInfo').textContent = `Current: ${settings.assessmentName} · ${settings.session}, ${settings.term}`;
    try {
      const me = await api('GET', '/api/teacher/me');
      const rc = $('#reviewCount');
      rc.textContent = me.reviewCount; rc.classList.toggle('hidden', !me.reviewCount);
    } catch (e) { if (e.status === 401) location.reload(); }
  }

  $$('.tab').forEach((t) => { t.onclick = () => openTab(t.dataset.tab); });
  function openTab(name) {
    activeTab = name;
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    ({ subs: renderSubs, review: renderReview, results: renderResults, exams: renderExams, settings: renderSettings })[name]();
  }

  // ---------- shared filter bar ----------
  function filterBar(id, opts) {
    const f = filterState[id] || (filterState[id] = { session: settings.session, term: settings.term });
    const classes = f.level ? settings.levels[f.level] : Object.values(settings.levels).flat();
    const subjects = [...new Set(examsCache.map((e) => e.subject))];
    return `<div class="filters" id="${id}">
      <div><label>Section</label><select data-f="level"><option value="">All sections</option>${Object.keys(settings.levels).map((l) => `<option ${f.level === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div><label>Class</label><select data-f="className"><option value="">All classes</option>${classes.map((c) => `<option ${f.className === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      ${opts.subject ? `<div><label>Subject</label><select data-f="subject"><option value="">All subjects</option>${subjects.map((s) => `<option ${f.subject === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>` : ''}
      <div><label>Session</label><input data-f="session" value="${esc(f.session || '')}"></div>
      <div><label>Term</label><input data-f="term" value="${esc(f.term || '')}"></div>
      ${opts.status ? `<div><label>Status</label><select data-f="status"><option value="">Any status</option>
        ${[['in_progress', 'In progress'], ['marking', 'Marking'], ['pending_review', 'Pending review'], ['complete', 'Complete']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
      ${opts.search ? `<div><label>Search name / adm. no.</label><input data-f="search" value="${esc(f.search || '')}"></div>` : ''}
    </div>`;
  }
  function bindFilters(id, onChange) {
    const f = filterState[id];
    $$(`#${id} [data-f]`).forEach((el) => {
      el.addEventListener(el.tagName === 'INPUT' ? 'change' : 'input', () => {
        f[el.dataset.f] = el.value.trim();
        if (el.dataset.f === 'level') f.className = '';
        onChange();
      });
    });
  }
  const qs = (f) => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();

  // ---------- Submissions ----------
  async function renderSubs() {
    $('#panel').innerHTML = `<h2>Submissions</h2>${filterBar('fSubs', { subject: true, status: true, search: true })}<div id="subsTable"><span class="spinner"></span></div>`;
    bindFilters('fSubs', renderSubs);
    const rows = await api('GET', '/api/teacher/attempts?' + qs(filterState.fSubs));
    $('#subsTable').innerHTML = rows.length ? `<p class="small muted">${rows.length} test${rows.length === 1 ? '' : 's'}</p><div class="table-wrap"><table class="data"><thead><tr>
      <th>Student</th><th>Adm. no.</th><th>Class</th><th>Subject</th><th>Status</th><th>Score</th><th>Grade</th><th>Started</th><th></th></tr></thead><tbody>
      ${rows.map((a) => `<tr><td>${esc(a.student_name)}</td><td>${esc(a.adm_no)}</td><td>${esc(a.class)}</td><td>${esc(a.subject)}</td><td>${statusPill(a)}</td>
        <td>${a.result_status === 'complete' ? `<strong>Score: ${fmt2(a.final_score)} / 40</strong>` : '—'}</td><td>${esc(a.grade || '')}</td><td class="small">${when(a.started_at)}</td>
        <td><div class="row-actions"><button class="btn btn-sm" data-detail="${a.id}">Details</button>
        ${a.status === 'submitted' ? `<a class="btn btn-sm btn-ghost" target="_blank" href="/api/teacher/sheet.pdf?${qs({ adm: a.adm_norm, session: a.session, term: a.term })}">Result sheet</a>` : `<button class="btn btn-sm btn-ghost" data-forcesubmit="${a.id}">Submit now</button>`}</div></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No tests match these filters yet.</p>';
    $$('[data-detail]').forEach((b) => { b.onclick = () => openAttempt(Number(b.dataset.detail)); });
    $$('[data-forcesubmit]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Submit this student’s saved answers now? Use this only if the student cannot finish (for example, they left the room).')) return;
        await api('POST', `/api/teacher/attempts/${b.dataset.forcesubmit}/submit`); toast('Submitted.'); renderSubs();
      };
    });
  }

  // ---------- attempt detail / marking records ----------
  function critRows(m) {
    return (m.criteria || []).map((c) => `<div class="crit"><span><strong>${esc(c.name)}</strong> <span class="muted small">(${esc(c.method || m.method)})</span></span><span><strong>${n2(c.awarded)}</strong> / ${n2(c.max)}</span>
      <div class="ev">${c.evidence && c.evidence.length ? `Evidence: ${c.evidence.map((e) => '“' + esc(e) + '”').join(', ')}<br>` : ''}${esc(c.reason || '')}${c.overriddenFrom != null ? ` <em>(was ${n2(c.overriddenFrom)})</em>` : ''}</div></div>`).join('');
  }
  function schemeHtml(q) {
    if (q.type === 'mcq') return `<div class="small"><strong>Key:</strong> ${esc(q.answerKey)}</div>`;
    if (q.type === 'bank') return `<div class="small"><strong>Key:</strong> ${esc(q.answerKey)}</div>`;
    if (q.type === 'short') return `<div class="small"><strong>Scheme:</strong> ${q.scheme.criteria.map((c) => `${esc(c.expected)} (${n2(c.marks)})`).join(' + ')}</div>`;
    if (q.type === 'essay') return `<details class="small"><summary>Mark scheme</summary>${(q.scheme.task || []).map((t) => '• ' + esc(t)).join('<br>')}<br>${q.scheme.criteria.map((c) => `<strong>${esc(c.name)} (${c.marks})</strong>: ${esc(c.descriptor)}`).join('<br>')}</details>`;
    return '';
  }
  function questionDetail(q, attempt) {
    const m = q.mark;
    const flagged = m && (m.status === 'review' || m.flags.length);
    const answerText = q.type === 'mcq' && q.answer ? `${q.answer}. ${(q.options.find((o) => o.id === q.answer) || {}).text || ''}` : q.answer;
    return `<div class="q-detail ${flagged ? 'flagged' : ''}" id="q-${esc(q.id)}">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><strong>${esc(q.label || 'Question ' + q.num)}</strong>
        <span>${m ? `<strong>${n2(m.total)}</strong> / ${n2(q.marks)} · ${m.status === 'final' ? '<span class="pill ok">Final</span>' : m.status === 'review' ? '<span class="pill warn">Needs review</span>' : '<span class="pill info">Queued</span>'}` : '<span class="pill info">Not marked</span>'}</span></div>
      ${q.context ? `<div class="small muted">${esc(q.context)}</div>` : ''}
      <div class="small">${esc(q.prompt)}</div>
      <pre>${answerText ? esc(answerText) : '<em class="muted">(blank)</em>'}</pre>
      ${schemeHtml(q)}
      ${m ? `${critRows(m)}
        ${m.flags.length ? `<div class="notice warn small">${m.flags.map((f) => esc(FLAG_TEXT[f] || f)).join('<br>')}${m.last_error ? `<br><span class="muted">Last error: ${esc(m.last_error)}</span>` : ''}</div>` : ''}
        ${m.summary ? `<div class="small muted">Comment for student: ${esc(m.summary)}</div>` : ''}
        <div class="small muted" style="margin-top:6px">Method: ${esc(m.method)} · Engine: ${esc(m.engine_version)} · Question v${esc(m.question_version)} · Scheme v${esc(m.scheme_version)} · Marked ${when(m.marked_at)}${m.tries ? ` · Attempts: ${m.tries}` : ''}</div>
        ${attempt.status === 'submitted' && (q.type === 'short' || q.type === 'essay' || flagged) ? `
        <details class="override-form" ${flagged ? 'open' : ''}><summary><strong>Examiner correction</strong></summary>
          <form data-override="${m.id}">
            ${m.criteria.map((c) => `<div style="display:flex;gap:10px;align-items:center;margin:6px 0"><label style="flex:1">${esc(c.name)} (max ${n2(c.max)})</label>
              <input type="number" step="0.25" min="0" max="${c.max}" name="${esc(c.id)}" value="${c.awarded}"></div>`).join('')}
            <label class="small"><strong>Reason (required)</strong></label>
            <textarea name="reason" rows="2" style="min-height:60px" placeholder="e.g. Valid paraphrase of “modifies worked”" required></textarea>
            <div class="row-actions" style="margin-top:8px"><button class="btn btn-sm btn-primary" type="submit">Save correction</button>
            ${q.type === 'essay' || q.type === 'short' ? `<button class="btn btn-sm btn-ghost" type="button" data-retry="${m.id}">Retry automatic marking</button>` : ''}</div>
            <div class="msg"></div>
          </form></details>` : ''}
        ${q.revisions.length > 1 ? `<details class="small" style="margin-top:6px"><summary>Audit trail (${q.revisions.length} entries)</summary>
          ${q.revisions.map((r) => `<div style="padding:4px 0;border-top:1px dashed var(--line)">#${r.revision_no} ${esc(r.kind)} · ${when(r.created_at)} · ${esc(r.actor)} · total ${n2(r.total)} · ${esc(r.status)}${r.reason ? ` · “${esc(r.reason)}”` : ''}</div>`).join('')}</details>` : ''}` : ''}
    </div>`;
  }

  async function openAttempt(id, focusQ) {
    const d = await api('GET', `/api/teacher/attempts/${id}`);
    const a = d.attempt, r = d.result;
    const groups = r ? JSON.parse(r.raw_json || '[]') : [];
    $('#drawerTitle').textContent = `${a.student_name} — ${a.subject}`;
    const onlyFlagged = !!focusQ;
    $('#drawerBody').innerHTML = `
      <dl class="kv"><dt>Admission no.</dt><dd>${esc(a.adm_no)}</dd><dt>Class</dt><dd>${esc(a.level)} · ${esc(a.class)}</dd><dt>Session / term</dt><dd>${esc(a.session)} · ${esc(a.term)}</dd>
      <dt>Started</dt><dd>${when(a.started_at)} (deadline ${when(a.deadline)})</dd><dt>Submitted</dt><dd>${a.submitted_at ? when(a.submitted_at) + ' · ' + esc(a.submit_reason) : 'Not yet'}</dd>
      <dt>Exam version</dt><dd>v${d.examVersion}</dd><dt>Result code</dt><dd>${esc(a.result_code)}</dd></dl>
      ${r ? `<div class="notice ${r.status === 'complete' ? 'ok' : 'warn'}" style="margin-top:12px">${r.status === 'complete' ? `<strong>Score: ${fmt2(r.final_score)} / 40</strong> · ${n2(r.percentage)}% · Grade ${esc(r.grade)} (${esc(r.remark)})` : `<strong>${r.status === 'pending_review' ? 'Result pending review' : 'Marking in progress'}</strong>`}
        <br><span class="small">Raw marks: ${groups.map((g) => `${esc(g.title)} ${n2(g.raw)}/${g.rawMax} → ${n2(g.raw / g.rawMax * g.weight)}/${g.weight}${g.pendingQuestions ? ` (${g.pendingQuestions} pending)` : ''}`).join(' · ')} · Total raw ${n2(r.raw_total)}/${n2(r.raw_max)}</span></div>` : ''}
      <label class="small" style="display:block;margin:12px 0"><input type="checkbox" id="showAll" ${onlyFlagged ? '' : 'checked'}> Show every question (untick to see only written answers and flagged items)</label>
      <div id="qList"></div>`;
    const draw = () => {
      const all = $('#showAll').checked;
      $('#qList').innerHTML = d.sections.map((s) => {
        const qsx = s.questions.filter((q) => all || q.id === focusQ || q.type === 'essay' || (q.mark && q.mark.status !== 'final'));
        return qsx.length ? `<h3 style="margin-top:14px">${esc(s.title)}</h3>${qsx.map((q) => questionDetail(q, a)).join('')}` : '';
      }).join('');
      bindOverrides(id, focusQ);
    };
    $('#showAll').onchange = draw;
    draw();
    $('#drawer').classList.remove('hidden');
    if (focusQ) { const el = document.getElementById('q-' + focusQ); if (el) el.scrollIntoView({ block: 'start' }); }
    $('#drawerClose').focus();
  }
  function bindOverrides(attemptId, focusQ) {
    $$('[data-override]').forEach((f) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(f);
        const criteria = {};
        for (const [k, v] of fd.entries()) if (k !== 'reason') criteria[k] = v;
        try {
          await api('POST', `/api/teacher/marks/${f.dataset.override}/override`, { criteria, reason: fd.get('reason') });
          toast('Correction saved. The original assessment is kept in the audit trail.');
          refreshTop(); openAttempt(attemptId, focusQ);
        } catch (err) { $('.msg', f).innerHTML = `<div class="notice error small">${esc(err.message)}</div>`; }
      };
    });
    $$('[data-retry]').forEach((b) => {
      b.onclick = async () => {
        try { await api('POST', `/api/teacher/marks/${b.dataset.retry}/retry`); toast('Sent for automatic marking again.'); setTimeout(() => openAttempt(attemptId, focusQ), 1500); }
        catch (err) { b.closest('form').querySelector('.msg').innerHTML = `<div class="notice error small">${esc(err.message)}</div>`; }
      };
    });
  }
  $('#drawerClose').onclick = () => { $('#drawer').classList.add('hidden'); openTab(activeTab); };

  // ---------- Review ----------
  async function renderReview() {
    const rows = await api('GET', '/api/teacher/review');
    const me = await api('GET', '/api/teacher/me');
    $('#panel').innerHTML = `<h2>Marking review</h2>
      <p class="muted">Written answers that automatic marking could not finish reliably. The student’s result stays “pending review” until each item is resolved. Enter a justified correction, or retry automatic marking.</p>
      ${me.aiConfigured ? '' : '<div class="notice warn">AI-assisted marking is not set up, so letters, essays and stories (and grammar answers the rules cannot judge) come here for an examiner. Add an API key under <strong>Settings → Automatic marking</strong> to mark them automatically.</div>'}
      ${rows.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Student</th><th>Class</th><th>Subject</th><th>Question</th><th>Status</th><th>Why</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.student_name)}<br><span class="small muted">${esc(r.adm_no)}</span></td><td>${esc(r.class)}</td><td>${esc(r.subject)}</td><td>${esc(r.question_id)}</td>
        <td>${r.status === 'review' ? '<span class="pill warn">Needs examiner</span>' : `<span class="pill info">Queued (try ${r.tries + 1})</span>`}</td>
        <td class="small">${r.flags.map((f) => esc(FLAG_TEXT[f] || f)).join('<br>')}${r.last_error ? `<br><span class="muted">${esc(r.last_error)}</span>` : ''}</td>
        <td><button class="btn btn-sm btn-primary" data-open="${r.attempt_id}" data-q="${esc(r.question_id)}">Review</button></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="notice ok">Nothing waiting for review.</div>'}`;
    $$('[data-open]').forEach((b) => { b.onclick = () => openAttempt(Number(b.dataset.open), b.dataset.q); });
    refreshTop();
  }

  // ---------- Results, comments & broadsheets ----------
  async function renderResults() {
    $('#panel').innerHTML = `<h2>Results, comments &amp; broadsheets</h2>${filterBar('fRes', { subject: true })}
      <div class="notice info small" id="bsBar"></div><div id="resTable"><span class="spinner"></span></div>`;
    bindFilters('fRes', renderResults);
    const f = filterState.fRes;
    const scope = f.className || f.level;
    $('#bsBar').innerHTML = scope
      ? `<strong>Broadsheet for ${esc(f.className || f.level + ' section')}${f.subject ? ' — ' + esc(f.subject) : ''}:</strong>
         <a class="btn btn-sm btn-primary" href="/api/teacher/broadsheet.xlsx?${qs(f)}">Download Excel</a>
         <a class="btn btn-sm" href="/api/teacher/broadsheet.csv?${qs(f)}">Download CSV</a>`
      : 'Choose a section or a class above to download its broadsheet (Excel or CSV).';
    const d = await api('GET', '/api/teacher/students?' + qs(f));
    $('#resTable').innerHTML = d.students.length ? `<p class="small muted">${d.students.length} student${d.students.length === 1 ? '' : 's'} · ${esc(d.session)}, ${esc(d.term)}. Comments stay blank on result sheets until you add them.</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Student</th><th>Class</th><th>Subjects</th><th>Average</th><th>Position</th><th style="min-width:220px">Class teacher’s comment</th><th style="min-width:220px">Principal’s comment</th><th></th></tr></thead><tbody>
      ${d.students.map((s) => `<tr data-adm="${esc(s.adm_norm)}"><td>${esc(s.name)}<br><span class="small muted">${esc(s.adm_no)}</span></td><td>${esc(s.class)}</td>
        <td>${s.complete}/${s.subjects} complete</td><td>${s.average != null ? `${fmt2(s.average)} / 40` : '—'}</td><td>${esc(s.position || '—')}</td>
        <td><textarea rows="2" style="min-height:56px;font-size:.9rem" data-c="teacherComment" maxlength="600">${esc(s.teacherComment)}</textarea></td>
        <td><textarea rows="2" style="min-height:56px;font-size:.9rem" data-c="principalComment" maxlength="600">${esc(s.principalComment)}</textarea></td>
        <td><div class="row-actions"><button class="btn btn-sm btn-primary" data-save>Save</button>
          <a class="btn btn-sm btn-ghost" target="_blank" href="/api/teacher/sheet.pdf?${qs({ adm: s.adm_norm, session: d.session, term: d.term })}">Print sheet</a></div></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No results for these filters yet.</p>';
    $$('[data-save]').forEach((b) => {
      b.onclick = async () => {
        const tr = b.closest('tr');
        await api('PUT', '/api/teacher/comments', { admNorm: tr.dataset.adm, session: d.session, term: d.term,
          teacherComment: $('[data-c=teacherComment]', tr).value, principalComment: $('[data-c=principalComment]', tr).value });
        toast('Comments saved.');
      };
    });
  }

  // ---------- Exams ----------
  async function renderExams() {
    examsCache = await api('GET', '/api/teacher/exams');
    $('#panel').innerHTML = `<h2>Tests &amp; mark schemes</h2>
      <p class="muted">A test is available to students only when its questions, answer keys and mark schemes are complete. Editing a test saves a new version; students already writing keep the version they started.</p>
      ${examsCache.map((e) => `<div class="card" style="margin-bottom:14px;box-shadow:none">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><h3 style="margin:0">${esc(e.subject)} — ${esc(e.level)}</h3>
          <div class="small muted">${esc(e.classes.join(', '))} · ${e.questions} questions · version ${e.version} · ${e.attempts} attempt${e.attempts === 1 ? '' : 's'} · code ${esc(e.code)}</div></div>
          <div>${e.status === 'published' ? '<span class="pill ok">Available to students</span>' : '<span class="pill bad">Not available</span>'}</div></div>
        ${e.errors.length ? `<div class="notice error small"><strong>Must be fixed before this test can be used:</strong><br>${e.errors.map((x) => '• ' + esc(x)).join('<br>')}</div>` : ''}
        ${e.warnings.length ? `<div class="notice warn small">${e.warnings.map((x) => '• ' + esc(x)).join('<br>')}</div>` : ''}
        ${e.draftSchemes.length ? `<div class="notice warn"><strong>Draft mark schemes need your approval.</strong> The source document says these tasks keep their “existing marking guides”, but the guides were not included. These draft criteria were prepared as a starting point — check them against your own guide, edit them if needed (Edit content), then approve.
          ${e.draftSchemes.map((q) => `<div style="background:#fff;border-radius:10px;padding:10px;margin-top:10px"><strong>${esc(q.label || 'Question ' + q.num)} (${q.marks} marks)</strong><div class="small">${esc(q.prompt)}</div>
            <table class="data" style="margin-top:6px"><tbody>${q.scheme.criteria.map((c) => `<tr><td><strong>${esc(c.name)}</strong></td><td>${c.marks}</td><td class="small">${esc(c.descriptor)}</td></tr>`).join('')}</tbody></table></div>`).join('')}
          <p style="margin-top:10px"><button class="btn btn-sm btn-primary" data-approve="${e.id}">I have checked these — approve mark schemes</button></p></div>` : ''}
        <div class="row-actions" style="margin-top:10px">
          ${e.status === 'published' ? `<button class="btn btn-sm btn-ghost" data-pub="${e.id}" data-v="0">Make unavailable</button>` : `<button class="btn btn-sm btn-primary" data-pub="${e.id}" data-v="1" ${e.errors.length ? 'disabled' : ''}>Make available to students</button>`}
          <button class="btn btn-sm" data-edit="${e.id}">Edit content &amp; mark schemes</button></div></div>`).join('')}
      <button class="btn btn-ghost" id="newExam">Add another subject test (JSON)</button>`;
    $$('[data-pub]').forEach((b) => {
      b.onclick = async () => {
        try { await api('POST', `/api/teacher/exams/${b.dataset.pub}/publish`, { publish: b.dataset.v === '1' }); toast(b.dataset.v === '1' ? 'Test is now available.' : 'Test is no longer available.'); renderExams(); }
        catch (err) { alert(err.message); }
      };
    });
    $$('[data-approve]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Approve these mark schemes for automatic marking?')) return;
        try { const r = await api('POST', `/api/teacher/exams/${b.dataset.approve}/approve-schemes`, {}); toast(r.errors.length ? 'Approved, but other problems remain.' : 'Approved. You can now make the test available.'); renderExams(); }
        catch (err) { alert(err.message); }
      };
    });
    $$('[data-edit]').forEach((b) => { b.onclick = () => editExam(Number(b.dataset.edit)); });
    $('#newExam').onclick = () => editExam(null);
  }
  async function editExam(id) {
    const d = id ? await api('GET', `/api/teacher/exams/${id}`) : null;
    $('#drawerTitle').textContent = id ? `Edit ${d.content.title || d.exam.code} (v${d.version})` : 'Add a subject test';
    $('#drawerBody').innerHTML = `
      <p class="small muted">The test is stored as JSON: sections, questions, answer keys (<code>answer</code>) and mark schemes (<code>scheme</code>). Question types: <code>mcq</code>, <code>bank</code> (word bank), <code>short</code> (rule-marked written answer) and <code>essay</code> (criteria-marked writing). Criterion marks must add up to each question’s marks; scoring groups convert raw marks so the test totals 40.</p>
      ${d ? `<details class="small"><summary>Version history</summary>${d.versions.map((v) => `<div>v${v.version_no} · ${when(v.created_at)} · ${esc(v.note || '')}</div>`).join('')}</details>` : ''}
      <textarea class="json-editor" id="examJson" spellcheck="false">${esc(JSON.stringify(d ? d.content : { code: 'ENG-NEW', subject: 'Subject name', level: 'Upper', classes: ['JSS2', 'JSS3'], title: '', durationMinutes: 90, interactive: false, instructions: [], passages: {}, groups: [{ id: 'all', title: 'Whole test', rawMax: 1, weight: 40 }], sections: [{ id: 'A', title: 'Section A', group: 'all', questions: [{ id: 'X1', num: 1, type: 'mcq', prompt: 'Question text', marks: 1, options: [{ id: 'A', text: 'Option' }, { id: 'B', text: 'Option' }], answer: 'A' }] }] }, null, 2))}</textarea>
      <div class="form-row" style="margin-top:10px"><label class="small">Note about this change</label><input type="text" id="examNote" placeholder="e.g. Corrected key for question 12"></div>
      <div class="row-actions"><button class="btn btn-primary" id="examSave">${id ? 'Save as new version' : 'Create test'}</button><button class="btn btn-ghost" id="examCheck">Check for problems</button></div>
      <div id="examMsg" style="margin-top:10px"></div>`;
    $('#drawer').classList.remove('hidden');
    const parse = () => { try { return JSON.parse($('#examJson').value); } catch (e) { $('#examMsg').innerHTML = `<div class="notice error">JSON error: ${esc(e.message)}</div>`; return null; } };
    $('#examCheck').onclick = () => { if (parse()) $('#examMsg').innerHTML = '<div class="notice ok">The JSON is readable. Save to see the full completeness check.</div>'; };
    $('#examSave').onclick = async () => {
      const content = parse(); if (!content) return;
      try {
        const r = id ? await api('PUT', `/api/teacher/exams/${id}`, { content, note: $('#examNote').value }) : await api('POST', '/api/teacher/exams', { content });
        $('#examMsg').innerHTML = r.errors.length ? `<div class="notice warn">Saved as version ${r.version}, but the test cannot be available until these are fixed:<br>${r.errors.map((x) => '• ' + esc(x)).join('<br>')}</div>`
          : `<div class="notice ok">Saved as version ${r.version}. ${r.status === 'published' ? 'Still available to students.' : 'Make it available from the Tests tab when ready.'}</div>`;
        examsCache = await api('GET', '/api/teacher/exams');
      } catch (err) { $('#examMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
    };
  }

  // ---------- Settings ----------
  function renderSettings() {
    const s = settings;
    const localDT = s.feedbackReleaseAt ? new Date(new Date(s.feedbackReleaseAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    $('#panel').innerHTML = `<h2>Settings</h2><p class="small muted">Records are stored in: <strong>${esc(s.storage || '')}</strong></p><div class="grid-2">
      <section><h3>School</h3>
        <div class="form-row"><label class="field" for="sName">School name</label><input type="text" id="sName" value="${esc(s.schoolName)}"></div>
        <div class="form-row"><label class="field" for="sAssess">Assessment name <span class="field-hint">(shown to students and on result sheets)</span></label><input type="text" id="sAssess" value="${esc(s.assessmentName)}" placeholder="e.g. First Term Test"></div>
        <div class="form-row"><label class="field">Logo</label>
          <div style="display:flex;gap:12px;align-items:center">${s.logo ? `<img src="${esc(s.logo)}" alt="Current logo" style="width:64px;height:64px;object-fit:contain;border:1px solid var(--line);border-radius:8px">` : '<span class="muted small">No logo yet</span>'}
          <input type="file" id="sLogo" accept="image/*">${s.logo ? '<button class="btn btn-sm btn-ghost" id="sLogoRemove" type="button">Remove</button>' : ''}</div></div>
        <h3>Academic session and term</h3>
        <p class="small muted">Students do not enter these; every new test uses the values here.</p>
        <div class="grid-2"><div class="form-row"><label class="field" for="sSession">Session</label><input type="text" id="sSession" value="${esc(s.session)}"></div>
        <div class="form-row"><label class="field" for="sTerm">Term</label><select id="sTerm">${['First Term', 'Second Term', 'Third Term'].concat([s.term].filter((t) => !['First Term', 'Second Term', 'Third Term'].includes(t))).map((t) => `<option ${t === s.term ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div></div>
        <h3>Positions</h3>
        <label class="toggle"><input type="checkbox" id="sPos" ${s.positionsEnabled ? 'checked' : ''}><span>Show class positions on result sheets and broadsheets<br><span class="small muted">Positions appear only after every result in the class is complete.</span></span></label>
        <h3 style="margin-top:18px">Feedback release</h3>
        <p class="small muted">Scores are shown as soon as marking is complete. Detailed per-question feedback is hidden until you release it. Answer keys and mark schemes are never sent to students.</p>
        ${[['never', 'Keep detailed feedback hidden'], ['immediate', 'Show detailed feedback with results'], ['scheduled', 'Release detailed feedback at a set time']].map(([v, l]) => `<label style="display:block;margin:6px 0"><input type="radio" name="sRel" value="${v}" ${s.feedbackReleaseMode === v ? 'checked' : ''}> ${l}</label>`).join('')}
        <input type="datetime-local" id="sRelAt" value="${localDT}" style="max-width:280px">
      </section>
      <section><h3>Grading</h3>
        <p class="small muted">Grades use the percentage of the score out of 40.</p>
        <table class="data grade-table"><thead><tr><th>From %</th><th>Grade</th><th>Remark</th><th></th></tr></thead><tbody id="gradeRows">
        ${s.gradingScale.map((g) => `<tr><td><input type="number" min="0" max="100" value="${g.min}" data-g="min"></td><td><input value="${esc(g.grade)}" data-g="grade"></td><td><input value="${esc(g.remark)}" data-g="remark"></td><td><button class="btn btn-sm btn-ghost" data-delg type="button">✕</button></td></tr>`).join('')}
        </tbody></table><button class="btn btn-sm btn-ghost" id="addGrade" type="button" style="margin-top:6px">Add grade</button>
        <h3 style="margin-top:18px">Automatic marking of written work</h3>
        <p class="small muted">Objective questions and most grammar answers are marked by fixed rules. Letters, essays, stories and unusual grammar answers use AI-assisted criterion-by-criterion marking. Without it, those answers go to Marking review and results stay pending.</p>
        <p class="small">Status: <strong>${s.aiKeySource === 'none' ? 'Not set up' : 'Set up (' + esc(s.aiKeySource) + ')'}</strong></p>
        <div class="form-row"><label class="field" for="sKey">Anthropic API key</label><input type="password" id="sKey" placeholder="${s.aiKeySource === 'saved in settings' ? 'Saved — enter a new key to replace it' : 'sk-ant-…'}" autocomplete="off"></div>
        <div class="form-row"><label class="field" for="sModel">Model</label><input type="text" id="sModel" value="${esc(s.aiModel)}"></div>
        ${s.aiKeySource === 'saved in settings' ? '<button class="btn btn-sm btn-ghost" id="sKeyClear" type="button">Remove saved key</button>' : ''}
        <h3 style="margin-top:18px">Teacher password</h3>
        <div class="form-row"><input type="password" id="pwCur" placeholder="Current password" autocomplete="current-password"></div>
        <div class="form-row"><input type="password" id="pwNew" placeholder="New password (at least 8 characters)" autocomplete="new-password"></div>
        <button class="btn btn-sm" id="pwSave" type="button">Change password</button>
      </section></div>
      <div id="setMsg" style="margin-top:14px"></div>
      <button class="btn btn-primary" id="saveSettings" style="margin-top:8px">Save settings</button>`;
    let logoPayload;
    $('#sLogo').onchange = (e) => {
      const file = e.target.files[0]; if (!file) return;
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 320 / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
        logoPayload = { dataUrl: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height };
        URL.revokeObjectURL(img.src);
        toast('Logo ready — press Save settings.');
      };
      img.src = URL.createObjectURL(file);
    };
    if ($('#sLogoRemove')) $('#sLogoRemove').onclick = () => { logoPayload = null; toast('Logo will be removed when you save.'); };
    $('#addGrade').onclick = () => $('#gradeRows').insertAdjacentHTML('beforeend', '<tr><td><input type="number" min="0" max="100" data-g="min"></td><td><input data-g="grade"></td><td><input data-g="remark"></td><td><button class="btn btn-sm btn-ghost" data-delg type="button">✕</button></td></tr>');
    $('#gradeRows').onclick = (e) => { if (e.target.closest('[data-delg]')) e.target.closest('tr').remove(); };
    if ($('#sKeyClear')) $('#sKeyClear').onclick = async () => { settings = await api('PUT', '/api/teacher/settings', { clearAiKey: true }); toast('Key removed.'); renderSettings(); };
    $('#pwSave').onclick = async () => {
      try { await api('POST', '/api/teacher/password', { current: $('#pwCur').value, next: $('#pwNew').value }); toast('Password changed.'); $('#pwCur').value = $('#pwNew').value = ''; }
      catch (err) { $('#setMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
    };
    $('#saveSettings').onclick = async () => {
      const mode = ($('input[name=sRel]:checked') || {}).value;
      const body = {
        schoolName: $('#sName').value, assessmentName: $('#sAssess').value, session: $('#sSession').value, term: $('#sTerm').value, positionsEnabled: $('#sPos').checked,
        gradingScale: $$('#gradeRows tr').map((tr) => ({ min: $('[data-g=min]', tr).value, grade: $('[data-g=grade]', tr).value, remark: $('[data-g=remark]', tr).value })),
        feedbackReleaseMode: mode, feedbackReleaseAt: mode === 'scheduled' && $('#sRelAt').value ? new Date($('#sRelAt').value).toISOString() : '',
        aiModel: $('#sModel').value,
      };
      if ($('#sKey').value.trim()) body.aiApiKey = $('#sKey').value.trim();
      if (logoPayload !== undefined) body.logo = logoPayload;
      try {
        settings = await api('PUT', '/api/teacher/settings', body);
        Object.values(filterState).forEach((f) => { f.session = settings.session; f.term = settings.term; });
        toast('Settings saved.'); refreshTop(); renderSettings();
      } catch (err) { $('#setMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
    };
  }

  boot();
})();
