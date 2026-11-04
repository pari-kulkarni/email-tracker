// Generates a realistic fake session (same event shapes the browser logs) and saves it through the real API.
//   node scripts/simulate.js [PID=DEMO] [PORT=3000]
// NOTE: this checks the saving, analysis and log view. It does NOT prove the browser captures events correctly
//       (that needs a real typing session) — it replays what the browser code is designed to emit.
const fs = require('fs'), path = require('path');
const Core = require('../public/core.js');

let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

class Sim {
  constructor(pid, email, scenario, t0) {
    Object.assign(this, { pid, email, t: t0, seq: 0, events: [], tab: 'email', aid: 0, cid: 0, S: { body: '', labels: [], subject: scenario.subject } });
    this.log('clock_sync', { offset_ms: 3, rtt_ms: 12 });
    this.log('writing_start', { scenario_id: scenario.id, to: scenario.to, subject: scenario.subject });
  }
  log(type, d = {}) { this.events.push({ t: Math.round(this.t), seq: ++this.seq, pid: this.pid, email: this.email, type, tab: this.tab, ...d }); }
  wait(ms) { this.t += ms; return this; }
  get len() { return this.S.body.length; }
  edit(pos, del, ins, via, source, inputType, extra = {}) {
    if (del) this.log('delete', { field: 'body', pos, text: del, by: 'human', inputType });
    const e = { field: 'body', pos, del, ins, source: ins ? source : null, inputType, via, ...extra };
    this.log('edit', e); Core.applyEdit(this.S, e);
  }
  key(k, extra = {}) { this.log('keystroke', { key: k, pos: this.len, end: this.len, ...extra }); }
  type(str) { for (const ch of str) { this.wait(90 + rnd() * 140); this.key(ch === '\n' ? 'Enter' : ch); this.edit(this.len, '', ch, 'typed', 'typed', ch === '\n' ? 'insertLineBreak' : 'insertText'); } return this; }
  typeAt(pos, str) { for (const ch of str) { this.wait(110 + rnd() * 90); this.key(ch, { pos }); this.edit(pos, '', ch, 'typed', 'typed', 'insertText'); pos++; } return this; }
  backspace(n) { for (let i = 0; i < n; i++) { this.wait(120); this.key('Backspace'); this.edit(this.len - 1, this.S.body.slice(-1), '', 'typed', null, 'deleteContentBackward'); } return this; }
  deleteAt(pos, text) { this.wait(300); this.key('Backspace', { pos: pos + text.length }); this.edit(pos, text, '', 'typed', null, 'deleteContentBackward'); return this; }
  suggestion(text, outcome, extraMs = 0) {                       // shown -> accepted | dismissed
    const id = 'A' + (++this.aid), pos = this.len;
    this.wait(700); this.log('autocomplete_shown', { suggestion_id: id, text, pos, model: 'mock-llm' });
    this.wait(1200 + extraMs);
    if (outcome === 'accepted') {
      this.key('Tab'); this.edit(pos, '', text, 'autocomplete', 'autocomplete', 'insertText');
      this.log('autocomplete_accepted', { suggestion_id: id, text });
    } else this.log('autocomplete_dismissed', { suggestion_id: id, reason: outcome, visible_ms: 1200 + extraMs, partial_chars: 0 });
    return this;
  }
  spellcheck(word, fix) { this.wait(1800); const pos = this.len - word.length; this.edit(pos, word, fix, 'spellcheck', 'spellcheck', 'insertReplacementText'); this.log('spellcheck', { field: 'body', pos, replaced: word, with: fix }); return this; }
  autocorrect(from, to, delim, undo) {                           // call right after typing `from + delim`
    const id = 'C' + (++this.cid), pos = this.len - delim.length - from.length;
    this.edit(pos, from, to, 'autocorrect', 'autocorrect', 'insertText');
    this.log('autocorrect_applied', { autocorrect_id: id, from, to, pos, delimiter: delim });
    if (undo) { this.wait(500); this.key('Backspace'); this.edit(pos, to, from, 'autocorrect_undo', 'typed', 'insertText'); this.log('autocorrect_undone', { autocorrect_id: id }); }
    else this.log('autocorrect_kept', { autocorrect_id: id });
    return this;
  }
  tabTo(to) { this.log('tab_switch', { from: this.tab, to }); this.log('snapshot', { reason: 'tab_switch', text: this.S.body, subject: this.S.subject, runs: Core.runsFromLabels(this.S.labels) }); this.tab = to; return this; }
  prompt(n, text) { this.log('ai_prompt', { prompt_id: 'Q' + n, text, tab: 'chat' }); return this; }
  reply(n, text, ms = 2500) { this.wait(ms); this.log('ai_reply', { reply_id: 'R' + n, prompt_id: 'Q' + n, text, model: 'mock-llm', stream_start_t: Math.round(this.t - ms + 400), tab: 'chat' }); return this; }
  copyBody(start, end) { this.log('copy', { field: 'body', kind: 'copy', text: this.S.body.slice(start, end), start, end, ai_reply: null }); return this; }
  copyChat(n, text, kind) { this.log('copy', { field: 'chat', kind, text, start: null, end: null, ai_reply: 'R' + n, tab: 'chat' }); return this; }
  pasteIntoChat(text) { this.log('paste', { field: 'chat_input', pos: 0, text, source_tag: 'own_email', from: null, blocked: false, tab: 'chat' }); return this; }
  pasteAI(n, text) {
    const pos = this.len; this.wait(600);
    this.edit(pos, '', text, 'paste_ai', 'ai', 'insertFromPaste');
    this.log('paste', { field: 'body', pos, text, source_tag: 'ai', from: 'R' + n, blocked: false });
    return this;
  }
  blockedPaste(text) { this.wait(800); this.log('paste', { field: 'body', pos: this.len, text, chars: text.length, source_tag: 'external', blocked: true }); return this; }
  blockedDrop() { this.wait(800); this.log('drop_blocked', { target: 'body', text: 'dragged text', types: ['text/plain'] }); return this; }
  snapshot(reason) { this.log('snapshot', { reason, text: this.S.body, subject: this.S.subject, runs: Core.runsFromLabels(this.S.labels) }); return this; }
  send() { this.wait(1500); this.log('send', { subject: this.S.subject, text: this.S.body }); this.snapshot('send'); return this; }
}

const R1 = "Certainly! Here's a more polished version:\n\nHello,\n\nI've finished the update and wanted to share where things stand. Please let me know if you'd like to discuss any of the details.\n\nBest regards,\n[Your name]";
const R2 = "Here are a few subject line options:\n\n1. Quick update on the project\n2. Project status and next steps\n3. Checking in about the project\n\nWant me to adjust the tone of any of these?";

function bossEmail(sim) {
  sim.wait(6500).type('Hi Sam,\n\n').wait(2500).type('I wanted to').suggestion(' follow up on', 'accepted');
  sim.type(' the project. Thanks for ').type('teh').type(' ').autocorrect('teh', 'the', ' ').type('help last week. ');
  sim.wait(3200).type('Could we sheduel').spellcheck('sheduel', 'schedule').type(' a call? ');
  sim.suggestion('Please let me know if that works.', 'typing');       // rejected: typed over it
  const draft = sim.S.body;
  sim.type('Anyway').wait(2500).backspace(6);
  // ask the AI (pastes the draft into the chat first)
  sim.copyBody(0, draft.length).tabTo('chat').pasteIntoChat(draft).wait(1500);
  sim.prompt(1, draft + '\n\nmake this sound more professional').reply(1, R1);
  const pick = "I've finished the update and wanted to share where things stand.";
  sim.wait(2000).copyChat(1, pick, 'copy').tabTo('email').wait(3500);
  sim.type('\n\n').pasteAI(1, pick);
  const p = sim.S.body.indexOf("I've") + 1;                           // change I've -> I have
  sim.wait(2500).deleteAt(p, "'").typeAt(p, ' ha');
  sim.wait(2200).type(" Please let me know if you'd like to discuss any of the details.");   // typed, but close to the AI reply
  sim.tabTo('chat').prompt(2, 'what is a good subject line?').reply(2, R2).tabTo('email');
  sim.blockedPaste('Dear Sir, as per my last email').blockedDrop();
  sim.wait(1800).type('\n\nThanks,\nAlex');
  return sim.send();
}
function colleagueEmail(sim) {
  sim.wait(4000).type('Hey Jordan,\n\n').wait(1800).type('Quick note: the draft has ');
  sim.type('alot').type(' ').autocorrect('alot', 'a lot', ' ', true);   // autocorrected, then undone with Backspace
  sim.type('of comments, can you take a look? ');
  sim.suggestion('Thanks so much for your help.', 'esc');
  sim.type('No rush, ').wait(2400).type('whenever you have time.');
  sim.tabTo('chat').prompt(1, 'how do i say thanks casually').reply(1, "I'd be happy to help with that. Could you tell me a bit more about what you're trying to do, or paste the draft you'd like me to look at?", 1500).tabTo('email');
  sim.wait(1200).type('\n\nThanks!\nAlex');
  return sim.send();
}

async function run(base, pid) {
  const post = async (u, b) => { const r = await fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); const j = await r.json(); if (!r.ok) throw new Error(u + ': ' + j.error); return j; };
  const s = await post('/api/session/start', { pid });
  let t = Date.now() - 25 * 60 * 1000;
  for (const em of s.emails) {
    await post('/api/email/begin', { pid, index: em.index });
    const sim = new Sim(pid, em.index, em.scenario, t);
    (em.condition === 'boss' ? bossEmail : colleagueEmail)(sim);
    for (let i = 0; i < sim.events.length; i += 400) await post('/api/events', { pid, index: em.index, events: sim.events.slice(i, i + 400) });
    const out = await post('/api/send', { pid, index: em.index, to: em.scenario.to, final_subject: sim.S.subject, final_text: sim.S.body, char_labels: Core.rangesFromLabels(sim.S.labels) });
    console.log(`email ${em.index} (${em.condition}): saved, ${sim.events.length} events, integrity ${JSON.stringify(out.integrity)}`);
    t = sim.t + 8 * 60 * 1000;                                       // pretend the recall interview happened in between
  }
}
module.exports = { Sim, bossEmail, colleagueEmail, run };

if (require.main === module) {
  const pid = process.argv[2] || 'DEMO', port = process.argv[3] || 3000;
  if (!/^DEMO/i.test(pid)) { console.error('Refusing to simulate a non-DEMO PID (it would overwrite real data).'); process.exit(1); }
  const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), pid);
  fs.rmSync(dir, { recursive: true, force: true });                   // re-runnable
  run(`http://localhost:${port}`, pid).then(() => console.log(`Done. Open http://localhost:${port}/researcher.html and pick ${pid}.`)).catch(e => { console.error(e.message); process.exit(1); });
}
