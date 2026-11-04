// Step 3 test: mock-model chat streaming, AI paste labelled 'ai', unused-reply flag, fresh chat per email.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const C = require('../public/core.js');

const PORT = 3800 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'aimc-chat-'));
const env = { ...process.env, PORT, DATA_DIR: DATA }; delete env.ANTHROPIC_API_KEY;
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
const post = async (u, b) => { const r = await fetch(`http://localhost:${PORT}${u}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return r; };
const json = async (u, b) => { const r = await post(u, b); return { status: r.status, body: await r.json() }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function chat(pid, index, messages) {           // reads the stream the way the browser does
  const r = await post('/api/chat', { pid, index, messages });
  if (r.status !== 200) return { status: r.status };
  const evs = []; let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString('utf8'); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 2); if (l.startsWith('data:')) evs.push(JSON.parse(l.slice(5))); }
  }
  return { status: 200, evs, text: evs.filter(e => e.type === 'delta').map(e => e.text).join('') };
}

(async () => {
  try {
    await sleep(600);
    const pid = 'P01';
    const s = await json('/api/session/start', { pid });
    // config sent to the browser must not leak the model or system prompt
    const cfg = await (await fetch(`http://localhost:${PORT}/api/config`)).json();
    assert.ok(!('LLM_MODEL' in cfg) && !('CHAT_SYSTEM_PROMPT' in cfg));
    // chat refused until the email has begun
    assert.strictEqual((await chat(pid, 1, [{ role: 'user', content: 'hi' }])).status, 409);
    await json('/api/email/begin', { pid, index: 1 });

    // streams word by word and finishes
    const t0 = Date.now();
    const r1 = await chat(pid, 1, [{ role: 'user', content: 'Can you make this more professional?' }]);
    assert.strictEqual(r1.evs[0].type, 'start'); assert.strictEqual(r1.evs[0].model, 'mock-llm');
    assert.strictEqual(r1.evs[r1.evs.length - 1].type, 'done');
    assert.ok(r1.evs.filter(e => e.type === 'delta').length > 15, 'many small deltas = word-by-word');
    assert.ok(Date.now() - t0 > 300, 'replies are paced');
    assert.ok(r1.text.includes("I've finished the update"));
    const r2 = await chat(pid, 1, [{ role: 'user', content: 'what is a good subject line?' }]);
    assert.ok(r2.text.includes('subject line options'));
    assert.strictEqual((await chat(pid, 1, [{ role: 'assistant', content: 'x' }])).status, 400);

    // Events as the client logs them: R1 pasted into the email and edited; R2 never used.
    const evs = []; let seq = 0; const ev = (type, d) => evs.push({ t: Date.now(), seq: ++seq, pid, email: 1, type, ...d });
    const subject = s.body.emails[0].scenario.subject, st = { body: '', labels: [], subject };
    ev('ai_prompt', { tab: 'chat', prompt_id: 'Q1', text: 'Can you make this more professional?' });
    ev('ai_reply', { tab: 'chat', reply_id: 'R1', prompt_id: 'Q1', text: r1.text, model: 'mock-llm' });
    ev('copy', { tab: 'chat', field: 'chat', kind: 'copy_button', text: "I've", ai_reply: 'R1' });
    ev('ai_prompt', { tab: 'chat', prompt_id: 'Q2', text: 'what is a good subject line?' });
    ev('ai_reply', { tab: 'chat', reply_id: 'R2', prompt_id: 'Q2', text: r2.text, model: 'mock-llm' });
    ev('tab_switch', { tab: 'chat', from: 'chat', to: 'email' });
    const edit = (e) => { ev('edit', { tab: 'email', field: 'body', ...e }); C.applyEdit(st, { field: 'body', ...e }); };
    edit({ pos: 0, del: '', ins: "I've", source: 'ai', via: 'paste_ai', inputType: 'insertFromPaste' });
    ev('paste', { tab: 'email', field: 'body', pos: 0, text: "I've", source_tag: 'ai', from: 'R1', blocked: false });
    edit({ pos: 1, del: "'", ins: '', source: null });                                      // delete the apostrophe
    edit({ pos: 1, del: '', ins: ' ha', source: 'typed', via: 'typed', inputType: 'insertText' });
    assert.strictEqual(st.body, 'I have');
    assert.deepStrictEqual(st.labels, ['ai', 'typed', 'typed', 'typed', 'ai', 'ai']);
    await json('/api/events', { pid, index: 1, events: evs });

    const sent = await json('/api/send', { pid, index: 1, to: 'x', final_subject: st.subject, final_text: st.body, char_labels: C.rangesFromLabels(st.labels) });
    assert.strictEqual(sent.status, 200);
    assert.ok(sent.body.integrity.replay_matches_final_text && sent.body.integrity.labels_cover_text);

    const saved = JSON.parse(fs.readFileSync(path.join(DATA, pid, 'session.json'), 'utf8')).emails[0];
    assert.deepStrictEqual(saved.char_labels, [
      { start: 0, end: 1, source: 'ai' }, { start: 1, end: 4, source: 'typed' }, { start: 4, end: 6, source: 'ai' }]);
    assert.deepStrictEqual(saved.ai_replies.map(r => [r.reply_id, r.used, r.copied]), [['R1', true, true], ['R2', false, false]]);
    assert.deepStrictEqual(saved.chat.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);

    // second email starts with an empty chat history on the server side too (events are per email)
    await json('/api/email/begin', { pid, index: 2 });
    const again = await json('/api/session/start', { pid });
    assert.deepStrictEqual(again.body.events, []);
    console.log('chat tests passed');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { srv.kill(); }
})();
