// Autocomplete (mock), saved-email fetch, researcher endpoints, CSV export, delete. Uses the simulator to make a full session.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { run } = require('../scripts/simulate.js');

const PORT = 3700 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'aimc-admin-'));
const env = { ...process.env, PORT, DATA_DIR: DATA }; delete env.ANTHROPIC_API_KEY; delete env.RESEARCHER_KEY;
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
const base = `http://localhost:${PORT}`;
const post = async (u, b) => { const r = await fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try {
    await sleep(600);
    await run(base, 'DEMO');                                   // full two-email session through the real API
    // participant can fetch only their own saved emails, with events
    const mine = await post('/api/session/emails', { pid: 'DEMO' });
    assert.strictEqual(mine.body.emails.length, 2);
    assert.ok(mine.body.emails.every(e => e.status === 'sent' && e.events.length > 50 && e.integrity.replay_matches_final_text));
    const boss = mine.body.emails.find(e => e.condition === 'boss');
    assert.deepStrictEqual(boss.ai_replies.map(r => [r.reply_id, r.used]), [['R1', true], ['R2', false]]);

    // autocomplete: needs an in-progress email; returns a short suggestion
    await post('/api/session/start', { pid: 'P01' }); await post('/api/email/begin', { pid: 'P01', index: 1 });
    const ac = await post('/api/autocomplete', { pid: 'P01', index: 1, text: 'Hello,\n\nI wanted to' });
    assert.strictEqual(ac.status, 200); assert.strictEqual(ac.body.suggestion, ' follow up on'); assert.strictEqual(ac.body.model, 'mock-llm');
    const ac2 = await post('/api/autocomplete', { pid: 'P01', index: 1, text: 'Hi Sam,\n' });
    assert.ok(!/^\s/.test(ac2.body.suggestion), 'no leading space after a newline');
    assert.ok(ac.body.suggestion.split(/\s+/).filter(Boolean).length <= 6);
    assert.strictEqual((await post('/api/autocomplete', { pid: 'P02', index: 1, text: 'abc' })).status, 409);

    // researcher endpoints (loopback allowed when RESEARCHER_KEY is unset)
    const list = await (await fetch(base + '/api/admin/sessions')).json();
    assert.ok(list.some(s => s.pid === 'DEMO' && s.statuses.join() === 'sent,sent'));
    const full = await (await fetch(base + '/api/admin/session?pid=DEMO')).json();
    assert.strictEqual(full.emails.length, 2);
    const edits = await (await fetch(base + '/api/admin/export?pid=DEMO&type=edits')).text();
    const evts = await (await fetch(base + '/api/admin/export?pid=DEMO&type=events')).text();
    assert.ok(edits.startsWith('pid,email_index,condition') && /,ai,/.test(edits) && /autocomplete/.test(edits));
    assert.ok(evts.startsWith('pid,email_index') && /paste/.test(evts));
    const chat = await (await fetch(base + '/api/admin/export?pid=DEMO&type=chat')).text();
    assert.ok(/PARTICIPANT:/.test(chat) && /AI: Certainly/.test(chat));
    const emails = await (await fetch(base + '/api/admin/export?pid=DEMO&type=emails')).text();
    assert.ok(/I have finished the update/.test(emails));
    assert.strictEqual((await fetch(base + '/api/admin/export?pid=../etc&type=json')).status, 404);

    // delete needs the PID typed to confirm
    assert.strictEqual((await post('/api/admin/delete', { pid: 'DEMO', confirm: 'nope' })).status, 400);
    assert.strictEqual((await post('/api/admin/delete', { pid: 'DEMO', confirm: 'DEMO' })).status, 200);
    assert.ok(!fs.existsSync(path.join(DATA, 'DEMO')));
    // static files for the new pages are served
    for (const f of ['researcher.html', 'logview.js', 'analysis.js', 'logview.css']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
    console.log('admin tests passed');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { srv.kill(); }
})();
