(() => {
const $ = s => document.querySelector(s);
const C = window.Core;
const TYPED = new Set(['insertText', 'insertCompositionText', 'insertFromComposition', 'insertLineBreak', 'insertParagraph']);

let CFG = { PAUSE_MS: 2000, SNAPSHOT_MS: 3000, EVENT_FLUSH_MS: 1000 };
let offset = 0;                              // server time - browser time, from the sync at session start
const now = () => Date.now() + offset;

// All state for the email currently being written (chat is fresh for each email).
const S = { pid: null, emails: [], cur: null, tab: 'email', body: '', labels: [], subject: '', seq: 0,
            copies: [], graveyard: [], pendingPaste: null, dirty: false, sent: false, timer: null,
            chat: [], streaming: false,
            sugg: null, acn: 0, cn: 0, lastAC: null, pendingAC: null, pendingAutocorrect: null, pendingUndo: null, composing: false, records: [] };

// ---------------- event log ----------------
let queue = [], flushing = false;
function log(type, data = {}) {
  const e = { t: now(), seq: ++S.seq, pid: S.pid, email: S.cur ? S.cur.index : null, type, tab: S.tab, ...data };
  queue.push(e); return e;
}
async function flush() {
  if (flushing || !queue.length || !S.cur) return true;
  flushing = true; const batch = queue.splice(0);
  try {
    const r = await post('/api/events', { pid: S.pid, index: S.cur.index, events: batch });
    if (!r.ok && r.status !== 409) throw new Error('flush failed');
    flushing = false; return true;
  } catch { queue.unshift(...batch); flushing = false; return false; }
}
async function flushAll() {
  for (let i = 0; i < 6; i++) { if (!queue.length && !flushing) return true; await flush(); await new Promise(r => setTimeout(r, 150)); }
  return !queue.length;
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
addEventListener('beforeunload', () => { if (queue.length && S.cur) navigator.sendBeacon('/api/events', new Blob([JSON.stringify({ pid: S.pid, index: S.cur.index, events: queue })], { type: 'application/json' })); });

async function syncClock() {
  let best = null;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now(); const { now: sn } = await (await fetch('/api/time')).json(); const t1 = Date.now();
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: sn - (t0 + t1) / 2 };
  }
  offset = best.offset; return best;
}

// ---------------- screens ----------------
const SCREENS = ['start', 'scenario', 'write', 'saved', 'compare'];
function show(name) { SCREENS.forEach(s => $('#s-' + s).hidden = s !== name); }
function cardHTML(em) {
  const sc = em.scenario;
  return `<h3>Scenario</h3><dl>
    <dt>You are writing to</dt><dd>${esc(sc.recipient_role)}</dd>
    <dt>Relationship</dt><dd>${esc(sc.relationship)}</dd>
    <dt>Subject</dt><dd>${esc(sc.subject)}</dd>
    <dt>Goal of the email</dt><dd>${esc(sc.goal)}</dd></dl>
    <div class="warn">Please don't include real confidential company details. Nothing is actually emailed.</div>`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const setHdr = () => { $('#hdr').hidden = false; $('#hdrinfo').textContent = `${S.pid}${S.cur ? ` · Email ${S.cur.index} of ${S.emails.length}` : ''}`; };

// ---------------- start / route ----------------
$('#pidin').value = new URLSearchParams(location.search).get('pid') || '';
$('#startbtn').onclick = async () => {
  $('#starterr').textContent = '';
  const pid = $('#pidin').value.trim(); if (!pid) return;
  try {
    const r = await post('/api/session/start', { pid }); const d = await r.json();
    if (!r.ok) { $('#starterr').textContent = d.error || 'Could not start.'; return; }
    const clock = await syncClock();
    CFG = await (await fetch('/api/config')).json();
    S.pid = d.pid; S.emails = d.emails; S.clock = clock;
    route(d.currentIndex, d.events);
  } catch { $('#starterr').textContent = 'Could not reach the server.'; }
};
$('#pidin').addEventListener('keydown', e => { if (e.key === 'Enter') $('#startbtn').click(); });

function route(idx, resumeEvents) {
  if (idx == null) { S.cur = null; setHdr(); return showSaved(S.emails.length, null); }
  S.cur = S.emails.find(e => e.index === idx); setHdr();
  if (S.cur.status === 'in_progress') return startWriting(resumeEvents && resumeEvents.length ? resumeEvents : []);
  $('#sc-kicker').textContent = `Email ${idx} of ${S.emails.length}`;
  $('#sc-card-read').innerHTML = cardHTML(S.cur);
  show('scenario');
}
$('#beginbtn').onclick = async () => {
  const r = await post('/api/email/begin', { pid: S.pid, index: S.cur.index });
  if (!r.ok) return alert('Could not start this email. Please tell the researcher.');
  S.cur.status = 'in_progress'; startWriting(null);
};

// ---------------- writing ----------------
function startWriting(resume) {
  Object.assign(S, { tab: 'email', body: '', labels: [], subject: S.cur.scenario.subject, copies: [], graveyard: [], pendingPaste: null,
                     dirty: false, sent: false, chat: [], streaming: false, qn: 0,
                     sugg: null, acn: 0, cn: 0, lastAC: null, pendingAC: null, pendingAutocorrect: null, pendingUndo: null, composing: false });
  queue = []; S.seq = 0;
  $('#chatlog').innerHTML = '<div class="hint" id="chathint">How can I help you today?</div>';   // fresh chat for every email
  if (resume) {
    const st = C.replay(resume, { subject: S.cur.scenario.subject });
    S.body = st.body; S.labels = st.labels; S.subject = st.subject;
    S.seq = resume.reduce((m, e) => Math.max(m, e.seq || 0), 0);
    S.acn = resume.filter(e => e.type === 'autocomplete_shown').length; S.cn = resume.filter(e => e.type === 'autocorrect_applied').length;
    for (const e of resume) {                     // rebuild the chat window from the log
      if (e.type === 'ai_prompt') { S.qn = Math.max(S.qn, parseInt(String(e.prompt_id).slice(1), 10) || 0); addBubble('user', e.text, e.prompt_id); }
      if (e.type === 'ai_reply') addBubble('assistant', e.text, e.reply_id, true);
    }
  }
  $('#sc-card-write').innerHTML = cardHTML(S.cur);
  $('#to').value = S.cur.scenario.to; $('#subject').value = S.subject; $('#body').value = S.body;
  for (const id of ['subject', 'body', 'sendbtn', 'chatin', 'chatsend']) $('#' + id).disabled = false;
  say(''); renderMirror(); applyTab(); show('write'); $('#body').focus();
  if (resume) log('session_resumed', { restored_chars: S.body.length, clock_offset_ms: S.clock.offset });
  else {
    log('clock_sync', { offset_ms: S.clock.offset, rtt_ms: S.clock.rtt });
    log('writing_start', { condition: S.cur.condition, scenario_id: S.cur.scenario_id, to: S.cur.scenario.to, subject: S.subject });
  }
  clearInterval(S.timer);
  S.timer = setInterval(() => { flush(); if (S.dirty && !S.sent) snapshot('interval'); }, Math.min(CFG.EVENT_FLUSH_MS, CFG.SNAPSHOT_MS));
  S.lastSnap = now();
}
function snapshot(reason) {
  if (reason === 'interval' && now() - S.lastSnap < CFG.SNAPSHOT_MS) return;
  log('snapshot', { reason, text: S.body, subject: S.subject, runs: C.runsFromLabels(S.labels) });
  S.lastSnap = now(); S.dirty = false;
}
function say(text, bad) {
  for (const id of ['#msg', '#chatmsg']) { const m = $(id); m.textContent = text; m.className = 'msg' + (bad ? ' bad' : ''); }
  clearTimeout(say.t); if (text) say.t = setTimeout(() => say('', false), 5000);
}

// ---------------- tabs ----------------
function applyTab() {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === S.tab));
  $('#v-email').hidden = S.tab !== 'email'; $('#v-chat').hidden = S.tab !== 'chat';
  $(S.tab === 'chat' ? '#chatin' : '#body').focus();
}
function setTab(t) {
  if (t === S.tab || !S.cur || S.sent) return;
  dismissSugg('tab_switch');
  log('tab_switch', { from: S.tab, to: t });      // logged with tab = the one being left
  snapshot('tab_switch');
  S.tab = t; applyTab();
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));

// ---------------- email editing ----------------
const findGrave = text => { for (let i = S.graveyard.length - 1; i >= 0; i--) if (S.graveyard[i].text === text) return S.graveyard[i]; return null; };
const sameRunsSource = runs => runs.length && runs.every(r => r[0] === runs[0][0]) ? runs[0][0] : null;

// Handles an 'input' on the email fields: works out what changed, who made it, labels the new characters, logs it.
function onInput(e, field) {
  const el = e.target, isBody = field === 'body', prev = isBody ? S.body : S.subject, cur = el.value;
  if (cur === prev) return;
  const type = e.inputType || '';
  let d = C.charDelta(prev, cur);
  // Replacements are recorded as whole words (not just the letters that differ), so "teh"->"the" is one autocorrect word.
  if (isBody && S.pendingAutocorrect) { const a = S.pendingAutocorrect; if (prev.slice(0, a.start) + a.to + prev.slice(a.start + a.from.length) === cur) d = { pos: a.start, del: a.from, ins: a.to }; }
  else if (isBody && S.pendingUndo) { const u = S.pendingUndo; if (prev.slice(0, u.start) + u.from + prev.slice(u.start + u.to.length) === cur) d = { pos: u.start, del: u.to, ins: u.from }; }
  else if (type === 'insertReplacementText' && /\S/.test(d.ins + d.del)) d = window.Analysis.region(prev, cur, true);
  else if (type === 'historyUndo' && isBody && S.lastAC) { const r = window.Analysis.region(prev, cur, true); if (r.ins === S.lastAC.from && r.del === S.lastAC.to) d = r; }
  const n = d.ins.length;
  let runs = null, via = 'typed', flag = null, pp = null, accepted = null;
  if (isBody) {
    acSeq++;                                                   // any edit invalidates in-flight suggestion requests
    const pAC = S.pendingAC, pAuto = S.pendingAutocorrect, pUndo = S.pendingUndo;
    const accepting = !!(pAC && n && d.ins === pAC.text);
    if (S.sugg && !accepting) {                                // the participant kept typing: shrink the suggestion or drop it
      if (n === 1 && !d.del && d.pos === prev.length && S.sugg.text.startsWith(d.ins) && type === 'insertText') {
        S.sugg.text = S.sugg.text.slice(1); S.sugg.matched++;
        if (!S.sugg.text) dismissSugg('typed_through');
      } else dismissSugg('typing');
    }
    if (S.lastAC && !pAuto && !pUndo) {                        // an autocorrection stays "kept" unless this edit undoes it
      if (type === 'historyUndo' && d.ins === S.lastAC.from && d.del === S.lastAC.to) { log('autocorrect_undone', { autocorrect_id: S.lastAC.id, via: 'undo_shortcut' }); S.lastAC = null; }
      else resolveAC();
    }
    if (n && accepting) { runs = [['autocomplete', n]]; via = 'autocomplete'; accepted = pAC; S.pendingAC = null; }
    else if (n && pAuto && d.ins === pAuto.to) { runs = [['autocorrect', n]]; via = 'autocorrect'; }
    else if (n && pUndo && d.ins === pUndo.from) { runs = [['typed', n]]; via = 'autocorrect_undo'; }
  }
  if (n && !runs) {
    if (type === 'insertFromPaste' && S.pendingPaste) {
      pp = S.pendingPaste; const rec = pp.rec; via = rec.replyId ? 'paste_ai' : 'paste_own';
      if (rec.text === d.ins) runs = rec.runs.map(r => r.slice());
      else if (sameRunsSource(rec.runs)) runs = [[sameRunsSource(rec.runs), n]];      // e.g. clipboard changed whitespace
      else { runs = [['unknown', n]]; flag = 'paste_text_mismatch'; }
    } else if (type === 'historyUndo' || type === 'historyRedo') {
      const g = findGrave(d.ins); via = 'undo';
      if (g) runs = g.runs.map(r => r.slice()); else { runs = [['unknown', n]]; flag = 'unknown_source'; }
    } else if (type === 'insertReplacementText') { runs = [['spellcheck', n]]; via = 'spellcheck'; }
    else if (TYPED.has(type) && !(type === 'insertText' && n > 4)) { runs = [['typed', n]]; via = 'typed'; }
    else { runs = [['unknown', n]]; via = 'other'; flag = 'unknown_source'; }   // dictation, extensions, bulk inserts...
  }
  S.pendingPaste = null;
  if (d.del.length) {
    if (isBody) S.graveyard.push({ text: d.del, runs: C.runsFromLabels(S.labels.slice(d.pos, d.pos + d.del.length)) });
    if (S.graveyard.length > 60) S.graveyard.shift();
    log('delete', { field, pos: d.pos, text: d.del, by: 'human', inputType: type });
  }
  const edit = { field, pos: d.pos, del: d.del, ins: d.ins, source: n ? C.summarize(runs) : null, inputType: type, via };
  if (runs && runs.length > 1) edit.runs = runs;
  if (flag) edit.flag = flag;
  log('edit', edit);
  if (pp) log('paste', { field, pos: d.pos, text: d.ins, source_tag: pp.rec.replyId ? 'ai' : 'own_email', from: pp.rec.replyId || null, blocked: false });
  if (via === 'spellcheck') log('spellcheck', { field, pos: d.pos, replaced: d.del, with: d.ins });
  if (accepted) { log('autocomplete_accepted', { suggestion_id: accepted.id, text: d.ins }); S.sugg = null; }

  if (isBody) {
    C.applyEdit(S, edit);
    if (S.body !== cur) {                         // safety net: should never happen; keep going and record it
      log('desync', { expected: S.body, actual: cur });
      S.body = cur; while (S.labels.length < cur.length) S.labels.push('unknown'); S.labels.length = cur.length;
    }
  } else S.subject = cur;
  S.dirty = true;
  if (isBody) { renderMirror(); maybeAutocorrect(el, d, type); scheduleAC(); }
}

// ---------------- autocomplete (Smart Compose style) ----------------
let acTimer = null, acSeq = 0;
function renderMirror() {
  const m = $('#mirror'); $('#achint').textContent = S.sugg ? 'Tab to accept · Esc to dismiss' : '';
  if (!S.sugg) { m.textContent = ''; return; }
  m.innerHTML = esc(S.body) + `<span class="ghost">${esc(S.sugg.text)}</span>`; m.scrollTop = $('#body').scrollTop;
}
function acEligible() {
  const el = $('#body');
  return S.cur && !S.sent && S.tab === 'email' && !S.composing && document.activeElement === el && el.selectionStart === el.selectionEnd &&
         el.selectionStart === el.value.length && S.body.trim().length >= (CFG.AUTOCOMPLETE_MIN_CHARS || 8);
}
function scheduleAC() { clearTimeout(acTimer); if (S.sugg || !acEligible()) return; acTimer = setTimeout(requestAC, CFG.AUTOCOMPLETE_PAUSE_MS || 700); }
async function requestAC() {
  if (!acEligible() || S.sugg) return;
  const snap = S.body, my = ++acSeq;
  let d; try { d = await (await post('/api/autocomplete', { pid: S.pid, index: S.cur.index, text: snap })).json(); } catch { return; }
  if (my !== acSeq || S.body !== snap || S.sugg || !acEligible() || !d.suggestion) return;   // typed meanwhile -> drop it
  S.sugg = { id: 'A' + (++S.acn), text: d.suggestion, shownAt: now(), pos: S.body.length, matched: 0 };
  log('autocomplete_shown', { suggestion_id: S.sugg.id, text: d.suggestion, pos: S.sugg.pos, model: d.model || null });
  renderMirror();
}
function dismissSugg(reason) {
  if (!S.sugg) return;
  log('autocomplete_dismissed', { suggestion_id: S.sugg.id, reason, visible_ms: now() - S.sugg.shownAt, partial_chars: S.sugg.matched });
  S.sugg = null; renderMirror();
}
// Insert text as a normal editing action (keeps the browser's undo stack); falls back to a synthetic input event.
function insertViaCommand(el, text) {
  el.focus(); let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch {}
  if (!ok) { el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end'); el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true })); }
}
function acceptSugg() {
  const el = $('#body'), s = S.sugg; if (!s) return;
  S.pendingAC = { id: s.id, text: s.text };
  el.setSelectionRange(el.value.length, el.value.length);
  insertViaCommand(el, s.text);
  S.pendingAC = null;
}

// ---------------- autocorrect (short typo list; one key press undoes it) ----------------
const DELIMS = /[\s.,;:!?]/;
function maybeAutocorrect(el, d, type) {
  if (S.sent || !(d.ins.length === 1 && DELIMS.test(d.ins) && ['insertText', 'insertLineBreak', 'insertParagraph'].includes(type))) return;
  const caret = el.selectionStart; if (caret !== d.pos + 1 || el.selectionEnd !== caret) return;
  const m = /([A-Za-z]+)$/.exec(S.body.slice(0, d.pos)); if (!m) return;
  const word = m[1], list = CFG.AUTOCORRECT_LIST || {}, base = list[word.toLowerCase()]; if (!base) return;
  const to = /^[A-Z]/.test(word) ? base[0].toUpperCase() + base.slice(1) : base, start = d.pos - word.length, id = 'C' + (++S.cn);
  S.pendingAutocorrect = { id, from: word, to, start };
  el.setSelectionRange(start, d.pos); insertViaCommand(el, to);
  S.pendingAutocorrect = null;
  const after = caret + to.length - word.length; el.setSelectionRange(after, after);
  S.lastAC = { id, from: word, to, start, caretAfter: after };
  log('autocorrect_applied', { autocorrect_id: id, from: word, to, pos: start, delimiter: d.ins });
}
function resolveAC() { if (S.lastAC) { log('autocorrect_kept', { autocorrect_id: S.lastAC.id }); S.lastAC = null; } }
function undoAutocorrect() {                               // Backspace right after an autocorrection restores what the participant typed
  const el = $('#body'), a = S.lastAC; if (!a) return;
  S.pendingUndo = { from: a.from, to: a.to, start: a.start };
  el.setSelectionRange(a.start, a.start + a.to.length); insertViaCommand(el, a.from);
  S.pendingUndo = null;
  const pos = a.caretAfter - (a.to.length - a.from.length); el.setSelectionRange(pos, pos);
  log('autocorrect_undone', { autocorrect_id: a.id, via: 'backspace' }); S.lastAC = null;
}
function checkCaret() {                                    // moving the cursor away ends a suggestion / confirms an autocorrection
  const el = $('#body'), atEnd = el.selectionStart === el.selectionEnd && el.selectionStart === el.value.length;
  if (S.sugg && !atEnd) dismissSugg('caret_moved');
  if (S.lastAC && el.selectionStart !== S.lastAC.caretAfter) resolveAC();
}

// Where did this text come from? Only text from inside the app is allowed to be pasted.
function findSource(text) {
  const n = C.norm(text); if (!n) return null;
  const rec = S.copies.find(c => C.norm(c.text) === n); if (rec) return rec;
  for (const m of S.chat) if (m.role === 'assistant' && C.norm(m.content).includes(n)) return { text, runs: [['ai', text.length]], field: 'chat', replyId: m.id };
  for (const m of S.chat) if (m.role === 'user' && C.norm(m.content).includes(n)) return { text, runs: [['typed', text.length]], field: 'chat', replyId: null };
  return null;
}
function onPaste(e, field) {
  const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  const rec = findSource(text);
  if (!rec) {
    e.preventDefault();
    log('paste', { field, pos: e.target.selectionStart, text, chars: text.length, source_tag: 'external', blocked: true });
    say("Pasting from outside this window isn't available in this study.", true);
    return;
  }
  if (field === 'body' || field === 'subject') S.pendingPaste = { text, rec };      // logged after the input event, with labels
  else log('paste', { field, pos: e.target.selectionStart, text, source_tag: rec.replyId ? 'ai' : 'own_email', from: rec.replyId || null, blocked: false });
}
function noteCopy(field, kind, text, runs, start, end, replyId) {
  if (!text) return;
  S.copies.unshift({ text, runs, field, replyId: replyId || null }); S.copies.length = Math.min(S.copies.length, 50);
  log('copy', { field, kind, text, start, end, ai_reply: replyId || null });
}
function onCopy(e, field) {
  const el = e.target, a = el.selectionStart, b = el.selectionEnd; if (a === b) return;
  const text = el.value.slice(a, b);
  noteCopy(field, e.type, text, field === 'body' ? C.runsFromLabels(S.labels.slice(a, b)) : [['typed', text.length]], a, b);
}
function onDrop(e) {
  e.preventDefault();
  log('drop_blocked', { target: (e.target && e.target.id) || null, text: e.dataTransfer ? e.dataTransfer.getData('text/plain') : '', types: e.dataTransfer ? [...e.dataTransfer.types] : [] });
  say('Drag and drop is not available in this study.', true);
}

for (const field of ['body', 'subject']) {
  const el = $('#' + field);
  el.addEventListener('input', e => onInput(e, field));
  el.addEventListener('paste', e => onPaste(e, field));
  el.addEventListener('copy', e => onCopy(e, field));
  el.addEventListener('cut', e => onCopy(e, field));
  el.addEventListener('dragstart', e => e.preventDefault());
}
$('#chatin').addEventListener('paste', e => onPaste(e, 'chat_input'));
$('#chatin').addEventListener('copy', e => onCopy(e, 'chat_input'));
$('#chatin').addEventListener('cut', e => onCopy(e, 'chat_input'));
$('#chatin').addEventListener('dragstart', e => e.preventDefault());
// Copying a selection out of the chat window (mouse selection + Ctrl/Cmd+C)
document.addEventListener('copy', () => {
  if (S.tab !== 'chat') return;
  const sel = getSelection(), text = String(sel); if (!text || !sel.anchorNode) return;
  const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
  if (!node || !node.closest('#chatlog')) return;
  const b = node.closest('[data-reply]'), replyId = b ? b.dataset.reply : null;
  noteCopy('chat', 'copy', text, [[replyId ? 'ai' : 'typed', text.length]], null, null, replyId);
});
// Block drops anywhere on the page (also stops a dropped file from navigating away)
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', onDrop);
$('#body').addEventListener('keydown', e => {
  const k = { key: e.key, pos: e.target.selectionStart, end: e.target.selectionEnd };
  for (const m of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) if (e[m]) k[m.replace('Key', '')] = true;
  if (e.isComposing) k.composing = true;
  log('keystroke', k);
  const el = e.target;
  if (e.key === 'Tab' && !e.shiftKey && S.sugg) { e.preventDefault(); acceptSugg(); }
  else if (e.key === 'Escape' && S.sugg) { e.preventDefault(); dismissSugg('esc'); }
  else if (e.key === 'Backspace' && S.lastAC && el.selectionStart === el.selectionEnd && el.selectionStart === S.lastAC.caretAfter) { e.preventDefault(); undoAutocorrect(); }
});
for (const ev of ['keyup', 'click', 'select', 'mouseup']) $('#body').addEventListener(ev, checkCaret);
$('#body').addEventListener('scroll', () => { $('#mirror').scrollTop = $('#body').scrollTop; });
$('#body').addEventListener('compositionstart', () => { S.composing = true; });
$('#body').addEventListener('compositionend', () => { S.composing = false; scheduleAC(); });
$('#body').addEventListener('blur', () => dismissSugg('blur'));
$('#body').addEventListener('focus', scheduleAC);
document.addEventListener('visibilitychange', () => { if (S.cur) log('window_visibility', { hidden: document.hidden }); });
addEventListener('blur', () => { if (S.cur) log('window_blur'); });
addEventListener('focus', () => { if (S.cur) log('window_focus'); });

// ---------------- AI chat ----------------
const chatlog = $('#chatlog'), chatin = $('#chatin');
const scrollDown = () => { chatlog.scrollTop = chatlog.scrollHeight; };
function addBubble(role, text, id, done) {
  const h = $('#chathint'); if (h) h.remove();
  const b = document.createElement('div'); b.className = `bubble ${role}`; b.dataset.id = id;
  if (role === 'assistant') b.dataset.reply = id;
  const t = document.createElement('div'); t.className = 'txt'; t.textContent = text; b.appendChild(t);
  chatlog.appendChild(b); scrollDown();
  S.chat.push({ role, content: text, id });
  if (role === 'assistant') { if (done) addCopyButton(b, id); else b.classList.add('streaming'); }
  return b;
}
function addCopyButton(bubble, id) {
  const tools = document.createElement('div'); tools.className = 'tools';
  const btn = document.createElement('button'); btn.textContent = '⧉ Copy';
  btn.onclick = async () => {
    const text = bubble.querySelector('.txt').textContent;
    try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    noteCopy('chat', 'copy_button', text, [['ai', text.length]], null, null, id);
    btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = '⧉ Copy'; }, 1500);
  };
  tools.appendChild(btn); bubble.appendChild(tools);
}
chatin.addEventListener('input', () => { chatin.style.height = 'auto'; chatin.style.height = Math.min(chatin.scrollHeight, 200) + 'px'; });
chatin.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendPrompt(); } });
$('#chatsend').onclick = sendPrompt;

async function sendPrompt() {
  const text = chatin.value.trim();
  if (!text || S.streaming || S.sent) return;
  S.streaming = true; chatin.value = ''; chatin.style.height = 'auto';
  const n = ++S.qn, promptId = 'Q' + n, replyId = 'R' + n;
  const messages = S.chat.map(m => ({ role: m.role, content: m.content })).concat({ role: 'user', content: text });
  addBubble('user', text, promptId);
  log('ai_prompt', { prompt_id: promptId, text });
  const bubble = addBubble('assistant', '', replyId, false), txt = bubble.querySelector('.txt');
  const mine = S.chat[S.chat.length - 1];
  let model = null, startT = null, err = null;
  try {
    const r = await post('/api/chat', { pid: S.pid, index: S.cur.index, messages });
    if (!r.ok) throw new Error((await r.json()).error || 'Request failed');
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'start') model = ev.model;
        else if (ev.type === 'delta') { if (startT === null) startT = now(); mine.content += ev.text; txt.textContent = mine.content; scrollDown(); }
        else if (ev.type === 'error') err = ev.message;
      }
    }
  } catch (e) { err = String(e.message || e); }
  bubble.classList.remove('streaming');
  if (err && !mine.content) {
    txt.textContent = 'Something went wrong. Please try again.';
    S.chat.splice(S.chat.length - 2, 2);          // drop the failed exchange from the conversation sent to the model
    log('ai_error', { prompt_id: promptId, error: err });
  } else {
    log('ai_reply', { reply_id: replyId, prompt_id: promptId, text: mine.content, model, stream_start_t: startT, tab: 'chat', ...(err ? { error: err, partial: true } : {}) });
    addCopyButton(bubble, replyId);
  }
  S.streaming = false;
}

// ---------------- send ----------------
$('#sendbtn').onclick = async () => {
  if (S.sent) return;
  if (S.streaming) return say('Please wait for the AI reply to finish first.', true);
  dismissSugg('send');
  const btn = $('#sendbtn'); btn.disabled = true; say('Saving…');
  log('send', { subject: S.subject, text: S.body });
  snapshot('send');
  try {
    if (!(await flushAll())) throw new Error('events not saved');
    const r = await post('/api/send', { pid: S.pid, index: S.cur.index, to: S.cur.scenario.to,
      final_subject: S.subject, final_text: S.body, char_labels: C.rangesFromLabels(S.labels) });
    const d = await r.json();
    if (!r.ok || !d.saved) throw new Error(d.error || 'save failed');
    S.sent = true; clearInterval(S.timer);
    S.emails.find(e => e.index === S.cur.index).status = 'sent';
    S.nextIndex = d.nextIndex;
    await showSaved(S.cur.index, d.nextIndex);
  } catch (err) {
    btn.disabled = false; say('Could not save — please try Send again, or tell the researcher.', true);
    log('send_failed', { error: String(err.message || err) });
  }
};


// ---------------- log view (after Send) + comparison ----------------
async function loadRecords() {
  const r = await post('/api/session/emails', { pid: S.pid }); S.records = (await r.json()).emails || [];
  return S.records;
}
async function showSaved(index, nextIdx) {
  const recs = await loadRecords(), rec = recs.find(e => e.index === index);
  S.nextIndex = nextIdx; setHdr();
  $('#savedtitle').textContent = '✓ Email saved';
  $('#savedtxt').textContent = rec ? `Email ${index} of ${S.emails.length} was saved under ${S.pid}. Click any entry below to see how it was written.` : 'Saved.';
  $('#nextbtn').hidden = nextIdx == null;
  $('#cmpbtn').hidden = !(nextIdx == null && recs.length === S.emails.length);
  const logEl = $('#savedlog'); logEl.innerHTML = '';
  if (rec) {
    let lv; const fb = LogFilters.create($('#savedfilters'), f => lv && lv.setFilters(f));
    lv = LogView.create(logEl, rec, { cfg: CFG, layout: 'wide', onFilterReset: () => fb.reset() });
  }
  show('saved');
}
$('#nextbtn').onclick = () => { S.cur = null; route(S.nextIndex, []); };
$('#cmpbtn').onclick = async () => {
  const recs = S.records.length ? S.records : await loadRecords();
  const ordered = ['boss', 'colleague'].map(c => recs.find(r => r.condition === c)).filter(Boolean);
  const views = []; $('#cmpL').innerHTML = ''; $('#cmpR').innerHTML = '';
  const fb = LogFilters.create($('#cmpfilters'), f => views.forEach(v => v.setFilters(f)));   // one filter bar controls both sides
  ordered.forEach((rec, i) => views.push(LogView.create($(i ? '#cmpR' : '#cmpL'), rec, { cfg: CFG, layout: 'stack', title: rec.condition === 'boss' ? 'Email to your boss' : 'Email to your colleague', onFilterReset: () => fb.reset() })));
  show('compare');
};
$('#cmpback').onclick = () => show('saved');
})();
