'use strict';
(async () => {
  const { api, esc, $, store, schoolHeader } = CBT;
  const LEVEL_INFO = { Lower: 'JSS1', Upper: 'JSS2 and JSS3', Advanced: 'SSS1, SSS2 and SSS3' };
  let cfg;
  const state = { level: null, className: null };
  const msg = (html, kind = 'error') => { $('#formMsg').innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : ''; };

  try { cfg = await api('GET', '/api/config'); } catch (e) { msg(esc(e.message)); return; }
  schoolHeader($('#schoolHead'), { name: cfg.schoolName, logo: cfg.logo }, `${cfg.assessmentName} • ${cfg.session} session • ${cfg.term}`);
  $('#pageTitle').textContent = `Start your ${cfg.assessmentName}`;
  document.title = `${cfg.schoolName} — ${cfg.assessmentName}`;

  const active = store.get('cbt_active');
  if (active && active.token) {
    $('#resumeBox').innerHTML = `You have a test in progress (${esc(active.className)}). <a href="/test#t=${encodeURIComponent(active.token)}"><strong>Continue your test</strong></a>`;
    $('#resumeBox').classList.remove('hidden');
  }

  $('#levels').innerHTML = Object.keys(cfg.levels).map((lv) =>
    `<button type="button" class="choice" data-level="${lv}" aria-pressed="false"><strong>${lv}</strong><span>${LEVEL_INFO[lv] || cfg.levels[lv].join(', ')}</span></button>`).join('');

  function renderClasses() {
    const classes = cfg.levels[state.level] || [];
    $('#classes').innerHTML = classes.map((c) => `<button type="button" class="choice classes-btn" data-class="${c}" aria-pressed="${state.className === c}">${c}</button>`).join('');
    $('#classRow').classList.toggle('hidden', !state.level);
  }
  function renderSubjects() {
    const list = (state.className && cfg.available[state.className]) || [];
    $('#subjectRow').classList.toggle('hidden', list.length < 2);
    $('#subject').innerHTML = list.map((e) => `<option value="${e.examId}">${esc(e.subject)}</option>`).join('');
    if (state.className && !list.length) msg(`No test is available for ${esc(state.className)} yet. Please tell your teacher.`, 'warn');
    else msg('');
  }

  $('#levels').addEventListener('click', (e) => {
    const b = e.target.closest('[data-level]'); if (!b) return;
    state.level = b.dataset.level; state.className = null;
    document.querySelectorAll('[data-level]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderClasses(); renderSubjects();
    if (cfg.levels[state.level].length === 1) { state.className = cfg.levels[state.level][0]; renderClasses(); renderSubjects(); }
  });
  $('#classes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-class]'); if (!b) return;
    state.className = b.dataset.class; renderClasses(); renderSubjects();
  });

  const reduce = store.get('cbt_reduce_motion');
  $('#reduceMotion').checked = reduce === null ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : !!reduce;

  async function begin() {
    const body = { name: $('#name').value, admNo: $('#adm').value, level: state.level, className: state.className, examId: Number($('#subject').value) || undefined };
    $('#startBtn').disabled = true; $('#rulesGo').disabled = true;
    try {
      const r = await api('POST', '/api/start', body);
      if (r.chooseSubject) { renderSubjects(); msg('Please choose your subject.', 'warn'); return; }
      if (r.alreadySubmitted) { $('#rulesDialog').classList.add('hidden'); msg(`${esc(r.message)} <a href="/result">Go to results</a>.`, 'info'); return; }
      store.set('cbt_active', { token: r.token, className: state.className });
      location.href = '/test#t=' + encodeURIComponent(r.token);
    } catch (e) {
      $('#rulesDialog').classList.add('hidden');
      msg(esc(e.message));
    } finally { $('#startBtn').disabled = false; $('#rulesGo').disabled = false; }
  }

  $('#startForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if ($('#name').value.trim().length < 3) return msg('Please enter your full name.'), $('#name').focus();
    if (!$('#adm').value.trim()) return msg('Please enter your admission number.'), $('#adm').focus();
    if (!state.level) return msg('Please choose your level.');
    if (!state.className) return msg('Please choose your class.');
    if (!(cfg.available[state.className] || []).length) return msg(`No test is available for ${esc(state.className)} yet. Please tell your teacher.`, 'warn');
    if (state.level === 'Lower') { $('#rulesDialog').classList.remove('hidden'); $('#rulesGo').focus(); return; }
    begin();
  });
  $('#rulesBack').addEventListener('click', () => $('#rulesDialog').classList.add('hidden'));
  $('#rulesGo').addEventListener('click', () => { store.set('cbt_reduce_motion', $('#reduceMotion').checked); begin(); });
})();
