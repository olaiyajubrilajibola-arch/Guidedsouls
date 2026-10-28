'use strict';
(() => {
  const { api, esc, $, $$, store, wordCount } = CBT;
  const token = decodeURIComponent((location.hash.match(/t=([^&]+)/) || [])[1] || '') || (store.get('cbt_active') || {}).token;
  if (!token) { location.href = '/'; return; }
  const PENDING_KEY = 'cbt_pending_' + token, POS_KEY = 'cbt_pos_' + token;

  let data, exam, flat = [], current = 0, offset = 0, deadlineMs = 0;
  const answers = {};                       // qid -> { value, locked, feedback }
  let pending = store.get(PENDING_KEY) || {}; // qid -> value not yet confirmed saved by the server
  let saving = false, saveTimer = null, lastSaved = null, offline = false, finished = false;
  let reduceMotion = store.get('cbt_reduce_motion');
  if (reduceMotion === null) reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- helpers ----------
  const safeHtml = (s) => esc(s).replace(/&lt;(\/?)(u|b|i|em|strong)&gt;/g, '<$1$2>');
  const isInteractive = () => exam && exam.interactive;
  const valueOf = (qid) => (answers[qid] ? answers[qid].value || '' : '');
  const isAnswered = (qid) => String(valueOf(qid)).trim() !== '';
  const announce = (t) => { $('#srAnnounce').textContent = ''; setTimeout(() => { $('#srAnnounce').textContent = t; }, 50); };
  function goResult(code) {
    finished = true;
    store.del('cbt_active'); store.del(PENDING_KEY); store.del(POS_KEY);
    if (code) store.set('cbt_last_result', code);
    location.href = '/result' + (code ? '?code=' + encodeURIComponent(code) : '');
  }

  // ---------- save status ----------
  function setStatus(kind, text) {
    const el = $('#saveStatus');
    el.classList.toggle('saving', kind === 'saving');
    el.classList.toggle('offline', kind === 'offline');
    $('.txt', el).textContent = text;
  }
  function refreshStatus() {
    if (offline) return setStatus('offline', 'Not connected — answers kept on this device');
    if (Object.keys(pending).length) return setStatus('saving', 'Saving…');
    setStatus('ok', lastSaved ? `All answers saved ✓ ${lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'All answers saved ✓');
  }

  function setValue(qid, value, delay = 0) {
    if (answers[qid] && answers[qid].locked) return;
    answers[qid] = { ...(answers[qid] || {}), value };
    pending[qid] = value;
    store.set(PENDING_KEY, pending);
    refreshStatus();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delay);
    updateProgress();
    updateNavState();
  }

  async function flush() {
    if (saving || finished) return;
    const snapshot = { ...pending };
    if (!Object.keys(snapshot).length) { refreshStatus(); return; }
    saving = true;
    try {
      const r = await api('PUT', `/api/attempt/${encodeURIComponent(token)}/answers`, { answers: snapshot });
      for (const [k, v] of Object.entries(snapshot)) if (pending[k] === v) delete pending[k];
      for (const k of r.lockedSkipped || []) delete pending[k];
      store.set(PENDING_KEY, pending);
      offline = false; lastSaved = new Date();
    } catch (e) {
      if (e.data && e.data.submitted) { goResult(data.attempt.resultCode); return; }
      offline = !!e.offline || e.status >= 500;
      if (!offline) { for (const k of Object.keys(snapshot)) delete pending[k]; store.set(PENDING_KEY, pending); }
    } finally {
      saving = false;
      refreshStatus();
      if (Object.keys(pending).length) { clearTimeout(saveTimer); saveTimer = setTimeout(flush, offline ? 5000 : 300); }
    }
  }
  window.addEventListener('online', () => { offline = false; flush(); });
  window.addEventListener('beforeunload', (e) => { if (!finished && Object.keys(pending).length) { e.preventDefault(); e.returnValue = ''; } });
  setInterval(() => { if (Object.keys(pending).length) flush(); }, 15000);

  // ---------- timer ----------
  let timeUpStarted = false;
  function tick() {
    const remaining = deadlineMs - (Date.now() + offset);
    const secs = Math.max(0, Math.ceil(remaining / 1000));
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    const t = $('#timer');
    t.textContent = [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
    t.classList.toggle('warn', secs <= 600 && secs > 120);
    t.classList.toggle('danger', secs <= 120);
    if (secs === 600) announce('Ten minutes left.');
    if (secs === 60) announce('One minute left.');
    if (remaining <= 0 && !timeUpStarted) timeUp();
  }
  async function timeUp() {
    timeUpStarted = true;
    $('#timeUp').classList.remove('hidden');
    document.activeElement && document.activeElement.blur();
    for (let i = 0; i < 100 && !finished; i++) {
      try {
        await flush();
        const r = await api('POST', `/api/attempt/${encodeURIComponent(token)}/submit`, { reason: 'time_expired' });
        goResult(r.resultCode); return;
      } catch (e) {
        $('#timeUpMsg').textContent = 'Trying to reach the server… Your saved answers will be submitted automatically.';
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  // ---------- rendering ----------
  function passageHtml(p) {
    return p.paragraphs.map((t) => `<p>${p.html ? safeHtml(t) : esc(t)}</p>`).join('');
  }
  function renderPassage(sec) {
    const pane = $('#passagePane');
    const p = sec.passage && exam.passages[sec.passage];
    $('#exam').classList.toggle('with-passage', !!p);
    pane.classList.toggle('hidden', !p);
    if (p && pane.dataset.key !== sec.passage) {
      pane.dataset.key = sec.passage;
      pane.innerHTML = `<h2>${esc(p.title)}</h2><div class="passage-text">${passageHtml(p)}</div>`;
    }
  }

  function updateProgress() {
    const total = flat.length;
    const done = flat.filter(({ q }) => (isInteractive() ? answers[q.id] && answers[q.id].locked : isAnswered(q.id))).length;
    $('#progressFill').style.width = (total ? (done / total) * 100 : 0) + '%';
    const lbl = $('#progressLabel');
    if (lbl) lbl.textContent = isInteractive() ? `${done} of ${total} answers confirmed` : `${done} of ${total} answered`;
  }

  function renderNavigator() {
    const nav = $('#navigator');
    nav.innerHTML = exam.sections.map((s) => `<h3>${esc(s.title)}</h3><div class="nav-grid">${s.questions.map((q) => {
      const i = flat.findIndex((f) => f.q.id === q.id);
      return `<button type="button" class="nav-btn" data-idx="${i}" aria-label="Question ${esc(q.label || q.num)}">${esc(q.num)}</button>`;
    }).join('')}</div>`).join('') +
      `<div class="nav-legend"><span class="l-none">Not answered</span><span class="l-ans">${isInteractive() ? 'Chosen, not confirmed' : 'Answered'}</span>${isInteractive() ? '<span class="l-lock">Confirmed</span>' : ''}</div>` +
      (isInteractive() ? `<p class="small" style="margin:12px 0 0"><button type="button" class="btn btn-ghost btn-sm" id="motionToggle">Celebrations: ${reduceMotion ? 'still picture' : 'balloons'} (change)</button></p>` : '');
    updateNavState();
  }
  function updateNavState() {
    $$('.nav-btn').forEach((b) => {
      const { q } = flat[Number(b.dataset.idx)];
      const locked = answers[q.id] && answers[q.id].locked;
      b.classList.toggle('locked', !!locked);
      b.classList.toggle('answered', !locked && isAnswered(q.id));
      b.classList.toggle('current', Number(b.dataset.idx) === current);
      if (Number(b.dataset.idx) === current) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
  }

  function usedWords(sec, exceptId) {
    const used = {};
    for (const q of sec.questions) if (q.id !== exceptId && isAnswered(q.id)) used[valueOf(q.id)] = q.num;
    return used;
  }

  function feedbackBlock(state) {
    const msgs = {
      correct: ['🎉', 'Correct! Well done.'],
      partial: ['⭐', 'Good effort! You earned some marks for this answer.'],
      incorrect: ['💪', 'Your answer has been saved. Keep going — you can do it!'],
      pending: ['📝', 'Answer submitted for marking.'],
    };
    const [icon, text] = msgs[state] || msgs.pending;
    return `<div class="feedback ${state}" role="status"><span class="icon" aria-hidden="true">${icon}</span><span>${text}</span></div>`;
  }

  function renderQuestion() {
    const { q, s } = flat[current];
    renderPassage(s);
    const a = answers[q.id] || {};
    const locked = !!a.locked;
    const interactive = isInteractive();
    const val = a.value || '';
    const passage = s.passage && exam.passages[s.passage];
    let body = '';
    if (q.type === 'mcq') {
      body = `<div class="options" role="radiogroup" aria-label="Answer options">${q.options.map((o) => `
        <button type="button" class="option" role="radio" aria-checked="${val === o.id}" data-opt="${esc(o.id)}" ${locked ? 'disabled' : ''}>
          <span class="letter">${esc(o.id)}</span><span>${esc(o.text)}</span></button>`).join('')}</div>`;
    } else if (q.type === 'bank') {
      const parts = q.prompt.split('[____]');
      const slot = `<button type="button" class="slot ${val ? 'filled' : ''}" id="slot" ${locked ? 'disabled' : ''} aria-label="${val ? 'Your answer: ' + esc(val) + '. Tap to clear.' : 'Empty answer box'}">${val ? esc(val) : 'tap a word'}</button>`;
      const used = usedWords(s, q.id);
      body = `<div class="blank-line">${esc(parts[0])}${slot}${esc(parts.slice(1).join('[____]'))}</div>
        ${q.hint ? `<div class="qhint">(${esc(q.hint)})</div>` : ''}
        ${locked ? '' : `<div class="bank" aria-label="Word bank"><span class="bank-title">Word bank — tap a word to place it</span>${s.bank.map((w) => {
          const usedIn = used[w];
          return `<button type="button" class="chip ${val === w ? 'selected' : ''}" draggable="${usedIn ? 'false' : 'true'}" data-word="${esc(w)}" ${usedIn ? `disabled title="Used in question ${usedIn}"` : ''}>${esc(w)}</button>`;
        }).join('')}</div>`}`;
    } else if (q.type === 'short') {
      body = `<label class="sr-only" for="ans">Your answer</label><input type="text" id="ans" maxlength="400" autocomplete="off" spellcheck="false" value="${esc(val)}" ${locked ? 'readonly' : ''} placeholder="Type your answer">`;
    } else if (q.type === 'essay') {
      const wcount = wordCount(val);
      body = `<label class="sr-only" for="ans">Your answer</label><textarea id="ans" rows="14" ${locked ? 'readonly' : ''} placeholder="Write your answer here">${esc(val)}</textarea>
        <div class="word-count ${q.minWords && wcount >= q.minWords && wcount <= q.maxWords ? 'good' : ''}" id="wc"><span>Words: <strong>${wcount}</strong></span><span>Aim for ${q.minWords}–${q.maxWords} words</span></div>`;
    }

    const controls = interactive
      ? (locked
        ? `${feedbackBlock(a.feedback || 'pending')}<div class="locked-note">🔒 This answer is confirmed and locked.</div>
           <div class="qnav"><button type="button" class="btn btn-ghost" id="prevBtn" ${current === 0 ? 'disabled' : ''}>← Previous</button>
           <button type="button" class="btn btn-primary" id="nextBtn" ${current === flat.length - 1 ? 'disabled' : ''}>Next question →</button></div>`
        : `<div class="qnav"><button type="button" class="btn btn-ghost" id="prevBtn" ${current === 0 ? 'disabled' : ''}>← Previous</button>
           <button type="button" class="btn btn-accent" id="confirmBtn" ${isAnswered(q.id) ? '' : 'disabled'}>Confirm Answer</button>
           <button type="button" class="btn btn-ghost" id="nextBtn" ${current === flat.length - 1 ? 'disabled' : ''}>Skip for now →</button></div>
           <div id="confirmMsg"></div>`)
      : `<div class="qnav"><button type="button" class="btn btn-ghost" id="prevBtn" ${current === 0 ? 'disabled' : ''}>← Previous</button>
         <button type="button" class="btn btn-primary" id="nextBtn" ${current === flat.length - 1 ? 'disabled' : ''}>Next →</button></div>`;

    $('#qArea').innerHTML = `
      <div class="qcard ${interactive ? 'jss1' : ''}">
        <div class="section-head">
          <div class="label">${esc(s.title)}</div>
          ${s.instructions ? `<div class="instr">${esc(s.instructions)}</div>` : ''}
          ${passage ? `<button type="button" class="btn btn-ghost btn-sm passage-toggle" id="openPassage" style="margin-top:8px">📖 Read passage: ${esc(passage.title)}</button>` : ''}
        </div>
        <div class="qnum"><span>${q.label ? esc(q.label) : 'Question ' + esc(q.num)} <span class="muted">· ${current + 1} of ${flat.length}</span></span><span class="marks">${q.marks === 0.5 ? '½ mark' : q.marks + (q.marks === 1 ? ' mark' : ' marks')}</span></div>
        ${q.context ? `<div class="qcontext">${esc(q.context)}</div>` : ''}
        ${q.type === 'bank' ? '' : `<div class="qprompt" id="qprompt">${esc(q.prompt)}</div>`}
        ${q.type !== 'bank' && q.hint ? `<div class="qhint">${esc(q.hint)}</div>` : ''}
        ${body}
        ${controls}
        ${interactive ? '<div class="celebrate-lane" id="lane" aria-hidden="true"></div>' : ''}
        <div class="small muted" id="progressLabel" style="margin-top:10px"></div>
      </div>`;
    updateProgress();
    updateNavState();
    store.set(POS_KEY, current);
    bindQuestion(q, s);
  }

  function go(i) {
    if (i < 0 || i >= flat.length) return;
    current = i; renderQuestion();
    const h = $('#qprompt') || $('.qcard');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    window.scrollTo({ top: 0 });
  }

  function bindQuestion(q, s) {
    const prev = $('#prevBtn'), next = $('#nextBtn');
    if (prev) prev.onclick = () => go(current - 1);
    if (next) next.onclick = () => go(current + 1);
    const op = $('#openPassage');
    if (op) op.onclick = () => openSheet(s);
    $$('.option').forEach((b) => { b.onclick = () => { setValue(q.id, b.dataset.opt, 0); $$('.option').forEach((x) => x.setAttribute('aria-checked', String(x === b))); enableConfirm(); }; });
    const ans = $('#ans');
    if (ans && !ans.readOnly) {
      ans.addEventListener('input', () => {
        setValue(q.id, ans.value, 800);
        enableConfirm();
        const wcEl = $('#wc');
        if (wcEl) { const n = wordCount(ans.value); wcEl.querySelector('strong').textContent = n; wcEl.classList.toggle('good', n >= q.minWords && n <= q.maxWords); }
      });
      ans.addEventListener('blur', () => flush());
    }
    if (q.type === 'bank') {
      const slot = $('#slot');
      const place = (w) => { if (answers[q.id] && answers[q.id].locked) return; setValue(q.id, w, 0); renderQuestion(); };
      $$('.chip').forEach((c) => {
        c.onclick = () => place(c.dataset.word);
        c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.dataset.word); });
      });
      if (slot && !slot.disabled) {
        slot.onclick = () => { if (valueOf(q.id)) { setValue(q.id, '', 0); renderQuestion(); } };
        slot.addEventListener('dragover', (e) => { e.preventDefault(); slot.classList.add('over'); });
        slot.addEventListener('dragleave', () => slot.classList.remove('over'));
        slot.addEventListener('drop', (e) => { e.preventDefault(); const w = e.dataTransfer.getData('text/plain'); if (s.bank.includes(w) && !usedWords(s, q.id)[w]) place(w); });
      }
    }
    const cb = $('#confirmBtn');
    if (cb) cb.onclick = () => confirmAnswer(q);
    const mt = $('#motionToggle');
    if (mt) mt.onclick = () => { reduceMotion = !reduceMotion; store.set('cbt_reduce_motion', reduceMotion); renderNavigator(); bindQuestion(q, s); };
  }
  function enableConfirm() { const cb = $('#confirmBtn'); if (cb) cb.disabled = !isAnswered(flat[current].q.id); }

  async function confirmAnswer(q) {
    const cb = $('#confirmBtn');
    const value = valueOf(q.id);
    if (!String(value).trim()) return;
    cb.disabled = true; cb.textContent = q.type === 'essay' ? 'Saving and marking…' : 'Saving…';
    try {
      const r = await api('POST', `/api/attempt/${encodeURIComponent(token)}/confirm`, { questionId: q.id, value });
      answers[q.id] = { value: r.value, locked: true, feedback: r.feedback };
      delete pending[q.id]; store.set(PENDING_KEY, pending); lastSaved = new Date(); refreshStatus();
      renderQuestion();
      announce({ correct: 'Correct! Well done.', partial: 'Good effort! You earned some marks.', incorrect: 'Answer saved. Keep going.', pending: 'Answer submitted for marking.' }[r.feedback] || 'Answer saved.');
      if (r.feedback === 'correct' && !r.already) celebrate();
      const nb = $('#nextBtn'); if (nb && !nb.disabled) nb.focus();
    } catch (e) {
      if (e.data && e.data.submitted) { goResult(data.attempt.resultCode); return; }
      cb.disabled = false; cb.textContent = 'Confirm Answer';
      $('#confirmMsg').innerHTML = `<div class="notice ${e.offline ? 'warn' : 'error'}">${esc(e.offline ? 'Not connected. Your choice is kept on this device — press Confirm Answer again when you are back online.' : e.message)}</div>`;
    }
  }

  const COLORS = ['#e94f37', '#f6ae2d', '#33a1fd', '#2fbf71', '#a259ff', '#ff6fb5', '#ffd23f'];
  function celebrate() {
    const lane = $('#lane');
    if (!lane) return;
    if (reduceMotion) {
      lane.innerHTML = `<div class="static-celebrate">${COLORS.slice(0, 4).map((c) => `<span class="b" style="background:${c}"></span>`).join('')} Well done! ${COLORS.slice(3, 7).map((c) => `<span class="b" style="background:${c}"></span>`).join('')}</div>`;
      setTimeout(() => { if (lane.isConnected) lane.innerHTML = ''; }, 2600);
      return;
    }
    lane.innerHTML = '';
    for (let i = 0; i < 10; i++) {
      const b = document.createElement('span');
      b.className = 'balloon';
      const c = COLORS[i % COLORS.length];
      b.style.background = c; b.style.borderTopColor = c;
      b.style.left = (4 + i * 9.4 + Math.random() * 3) + '%';
      b.style.animationDelay = (Math.random() * 0.45) + 's';
      lane.appendChild(b);
    }
    setTimeout(() => { if (lane.isConnected) lane.innerHTML = ''; }, 2900);
  }

  // ---------- passage sheet (small screens) ----------
  let sheetReturn = null;
  function openSheet(s) {
    const p = exam.passages[s.passage];
    sheetReturn = document.activeElement;
    $('#sheetTitle').textContent = p.title;
    $('#sheetText').innerHTML = passageHtml(p);
    $('#passageSheet').classList.remove('hidden');
    $('#sheetClose').focus();
  }
  function closeSheet() { $('#passageSheet').classList.add('hidden'); if (sheetReturn) sheetReturn.focus(); }
  $('#sheetClose').onclick = closeSheet;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('#passageSheet').classList.contains('hidden')) closeSheet(); else if (!$('#submitDialog').classList.contains('hidden')) $('#submitDialog').classList.add('hidden'); } });

  // ---------- submit ----------
  $('#submitBtn').onclick = () => {
    const total = flat.length;
    const answered = flat.filter(({ q }) => isAnswered(q.id)).length;
    const unconfirmed = isInteractive() ? flat.filter(({ q }) => isAnswered(q.id) && !(answers[q.id] && answers[q.id].locked)).length : 0;
    $('#submitSummary').innerHTML = `You have answered <strong>${answered} of ${total}</strong> questions.` +
      (total - answered ? ` <strong>${total - answered}</strong> ${total - answered === 1 ? 'is' : 'are'} still blank.` : '') +
      (unconfirmed ? ` ${unconfirmed} chosen ${unconfirmed === 1 ? 'answer has' : 'answers have'} not been confirmed yet; ${unconfirmed === 1 ? 'it' : 'they'} will still be submitted.` : '');
    $('#submitMsg').innerHTML = '';
    $('#submitDialog').classList.remove('hidden');
    $('#submitCancel').focus();
  };
  $('#submitCancel').onclick = () => $('#submitDialog').classList.add('hidden');
  $('#submitConfirm').onclick = async () => {
    const btn = $('#submitConfirm');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      await flush();
      if (Object.keys(pending).length) throw Object.assign(new Error('offline'), { offline: true });
      const r = await api('POST', `/api/attempt/${encodeURIComponent(token)}/submit`, {});
      goResult(r.resultCode);
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Yes, submit my test';
      $('#submitMsg').innerHTML = `<div class="notice ${e.offline ? 'warn' : 'error'}">${e.offline ? 'Cannot reach the server. Your answers are kept on this device. Please try again in a moment.' : esc(e.message)}</div>`;
    }
  };

  $('#navigator').addEventListener('click', (e) => { const b = e.target.closest('.nav-btn'); if (b) go(Number(b.dataset.idx)); });

  // ---------- load ----------
  async function load() {
    try { data = await api('GET', `/api/attempt/${encodeURIComponent(token)}`); } catch (e) {
      if (e.status === 404) { store.del('cbt_active'); $('#qArea').innerHTML = `<div class="qcard"><p>${esc(e.message)}</p><a class="btn btn-primary" href="/">Go to the start page</a></div>`; return; }
      $('#qArea').innerHTML = `<div class="qcard"><p>${esc(e.message)}</p><button class="btn btn-primary" id="retryLoad">Try again</button></div>`;
      $('#retryLoad').onclick = () => location.reload();
      return;
    }
    if (data.attempt.status !== 'in_progress') { goResult(data.attempt.resultCode); return; }
    exam = data.exam;
    offset = Date.parse(data.attempt.serverNow) - Date.now();
    deadlineMs = Date.parse(data.attempt.deadline);
    document.title = `${exam.subject} — ${data.attempt.className}`;
    $('#tTitle').textContent = `${exam.subject} — ${data.attempt.className}`;
    $('#tSub').textContent = `${data.assessmentName} · ${data.attempt.name} · ${data.attempt.admNo} · ${data.attempt.session}, ${data.attempt.term}`;
    for (const [qid, a] of Object.entries(data.answers)) answers[qid] = a;
    for (const [qid, v] of Object.entries(pending)) {
      if (answers[qid] && answers[qid].locked) delete pending[qid];
      else answers[qid] = { ...(answers[qid] || {}), value: v };
    }
    store.set(PENDING_KEY, pending);
    flat = [];
    exam.sections.forEach((s) => s.questions.forEach((q) => flat.push({ q, s })));
    const saved = Number(store.get(POS_KEY));
    current = Number.isInteger(saved) && saved >= 0 && saved < flat.length ? saved : 0;
    renderNavigator();
    renderQuestion();
    refreshStatus();
    tick(); setInterval(tick, 250);
    if (Object.keys(pending).length) flush();
  }
  load();
})();
