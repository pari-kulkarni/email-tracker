// End-to-end API test: starts the server on a temp data dir, runs two participants through both emails.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const C = require('../public/core.js');

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'aimc-'));
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: 'ignore' });
const post = async (u, b) => { const r = await fetch(`http://localhost:${PORT}${u}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try {
    await sleep(600);
    // unknown PID rejected
    assert.strictEqual((await post('/api/session/start', { pid: 'NOPE' })).status, 404);

    const out = {};
    for (const pid of ['P01', 'P02']) {
      const s = await post('/api/session/start', { pid });
      assert.strictEqual(s.status, 200);
      out[pid] = s.body.emails.map(e => e.condition);
      // cannot send before beginning
      assert.strictEqual((await post('/api/send', { pid, index: 1, final_text: '', final_subject: '', char_labels: [] })).status, 409);
      assert.strictEqual((await post('/api/email/begin', { pid, index: 1 })).status, 200);

      // a typed email with one spellcheck pick, as the client would log it
      const subject = s.body.emails[0].scenario.subject;
      const st = { body: '', labels: [], subject };
      const evs = []; let seq = 0;
      const edit = (pos, del, ins, source) => { const e = { t: Date.now(), seq: ++seq, pid, email: 1, type: 'edit', field: 'body', pos, del, ins, source }; evs.push(e); C.applyEdit(st, e); };
      'Helo team'.split('').forEach((ch, i) => edit(i, '', ch, 'typed'));
      edit(0, 'Helo', 'Hello', 'spellcheck');
      evs.push({ t: Date.now(), seq: ++seq, pid, email: 1, type: 'paste', source_tag: 'external', blocked: true, text: 'from outside' });
      // events arrive in two batches (as the 1s flush would send them)
      await post('/api/events', { pid, index: 1, events: evs.slice(0, 5) });
      // mid-session "crash": starting again resumes under the same PID with the events so far
      const again = await post('/api/session/start', { pid });
      assert.strictEqual(again.body.currentIndex, 1);
      assert.strictEqual(again.body.emails[0].status, 'in_progress');
      assert.strictEqual(again.body.events.length, 5);
      assert.strictEqual(C.replay(again.body.events, { subject }).body, 'Helo ');
      await post('/api/events', { pid, index: 1, events: evs.slice(5) });

      const sent = await post('/api/send', { pid, index: 1, to: 'x', final_subject: st.subject, final_text: st.body, char_labels: C.rangesFromLabels(st.labels) });
      assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
      assert.ok(sent.body.integrity.replay_matches_final_text && sent.body.integrity.labels_cover_text, JSON.stringify(sent.body));
      assert.strictEqual(sent.body.nextIndex, 2);

      const saved = JSON.parse(fs.readFileSync(path.join(DATA, pid, 'session.json'), 'utf8'));
      const e1 = saved.emails[0];
      assert.strictEqual(e1.final_text, 'Hello team');
      assert.deepStrictEqual(e1.char_labels, [{ start: 0, end: 5, source: 'spellcheck' }, { start: 5, end: 10, source: 'typed' }]);
      assert.ok(e1.events.some(e => e.type === 'paste' && e.blocked));
      assert.strictEqual(saved.emails[1].status, 'pending');
      // second email starts only after the first was sent, and cannot be skipped to
      assert.strictEqual((await post('/api/email/begin', { pid, index: 2 })).status, 200);
    }
    // order alternates across PIDs
    assert.deepStrictEqual(out.P01, ['boss', 'colleague']);
    assert.deepStrictEqual(out.P02, ['colleague', 'boss']);
    // skipping ahead is refused
    const p3 = await post('/api/session/start', { pid: 'P03' });
    assert.strictEqual((await post('/api/email/begin', { pid: 'P03', index: 2 })).status, 409);
    assert.ok(fs.existsSync(path.join(DATA, 'P01', 'session.json')) && fs.existsSync(path.join(DATA, 'P02', 'session.json')));
    console.log('api tests passed; two sessions saved under', fs.readdirSync(DATA).join(', '));
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { srv.kill(); }
})();
