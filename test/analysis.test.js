const assert = require('assert');
const A = require('../public/analysis.js');
const Core = require('../public/core.js');
const { Sim, bossEmail, colleagueEmail } = require('../scripts/simulate.js');
const scen = { id: 'S1', to: 'x', subject: 'Subj' };

const boss = new Sim('T', 1, scen, 1e12); bossEmail(boss);
const email = { events: boss.events, final_text: boss.S.body, final_subject: boss.S.subject, scenario: scen, char_labels: Core.rangesFromLabels(boss.S.labels) };
const a = A.analyze(email);
assert.ok(a.replayOk, 'replay reproduces the final text');
console.log('--- final text ---\n' + a.final_text + '\n------------------');

// "I've" -> "I have": I, v, e are ai; " ha" typed; and the span is marked AI-edited
const i = a.final_text.indexOf('I have');
const runs = []; let pos = 0; for (const r of a.runs) { runs.push([pos, pos + r.text.length, r]); pos += r.text.length; }
const at = k => runs.find(([s, e]) => k >= s && k < e)[2];
assert.strictEqual(at(i).label, 'ai'); assert.strictEqual(at(i + 1).label, 'typed'); assert.strictEqual(at(i + 3).label, 'typed');
assert.strictEqual(at(i + 4).label, 'ai'); assert.strictEqual(at(i + 5).label, 'ai');
assert.ok(at(i).aiEdited && at(i + 4).aiEdited, 'AI span with human changes is marked AI-edited');

const R = a.revisions;
const bySrc = s => R.filter(r => r.source === s);
assert.ok(bySrc('autocomplete').length === 1 && bySrc('spellcheck').length === 1 && bySrc('autocorrect').length === 1 && bySrc('ai').length === 1);
assert.ok(R.some(r => r.ai_edit && r.kind === 'deletion' && r.region.del === "'"), 'apostrophe deletion is a human change to AI text');
assert.ok(R.some(r => r.ai_edit && r.source === 'typed' && r.region.ins === ' ha'));
assert.strictEqual(bySrc('ai')[0].ai_reply, 'R1');
// pauses: first revision waited 6.5s before the first keystroke; revisions after the chat visit say so
assert.ok(R[0].pause_ms > 6000 && R[0].pause_first);
assert.ok(R.some(r => r.pause_where === 'AI Chat tab'));
// flags
assert.ok(a.entries.some(e => e.kind === 'ac_rejected'), 'rejected autocomplete suggestion is listed');
const q2 = a.entries.find(e => e.kind === 'reply' && e.id === 'R2'); assert.strictEqual(q2.reply.used, false);
assert.strictEqual(a.entries.find(e => e.kind === 'reply' && e.id === 'R1').reply.used, true);
assert.ok(a.entries.filter(e => e.kind === 'blocked').length === 2);
assert.ok(a.inspiredRanges.length >= 1 && a.inspiredRanges[0].reply_id === 'R1', 'typed copy of AI wording flagged as possibly AI-inspired');
console.log('inspired:', a.inspiredRanges.map(x => x.phrase));
assert.ok(!a.inspiredRanges.some(x => /thank/i.test(x.phrase)));

// filters
const f = A.emptyFilters(); f.source = ['ai'];
const kept = a.entries.filter(e => A.matches(e, f));
assert.ok(kept.every(e => e.kind === 'prompt' || e.kind === 'reply' || (e.kind === 'revision' && e.rev.source === 'ai')));
assert.ok(kept.some(e => e.kind === 'revision' && e.rev.ai_reply === 'R1'));
const g = A.emptyFilters(); g.aiEdit = true; assert.ok(a.entries.filter(e => A.matches(e, g)).every(e => e.rev && e.rev.ai_edit));
const h = A.emptyFilters(); h.flag = ['unused_reply']; assert.deepStrictEqual(a.entries.filter(e => A.matches(e, h)).map(e => e.id), ['R2']);
const k = A.emptyFilters(); k.flag = ['rejected_ac']; assert.strictEqual(a.entries.filter(e => A.matches(e, k)).length, 1);
const l = A.emptyFilters(); l.kind = ['deletion']; l.source = ['typed']; // AND across groups: deletions have no source -> none
assert.strictEqual(a.entries.filter(e => A.matches(e, l)).length, 0);

// colleague: autocorrect then Backspace = undone
const col = new Sim('T', 2, scen, 1e12); colleagueEmail(col);
const b = A.analyze({ events: col.events, final_text: col.S.body, scenario: scen });
assert.ok(b.replayOk);
const ac = b.revisions.find(r => r.source === 'autocorrect'); assert.ok(ac.flags.includes('ac_undone'));
assert.ok(b.final_text.includes('alot'), 'undo restored the typed word');
assert.ok(b.revisions.find(r => r.source === 'typed' && r.region.ins === 'alot' || r.region.ins === 'alot'), 'undo is its own revision');
assert.strictEqual(b.entries.filter(e => e.kind === 'reply' && !e.reply.used).length, 1);

// CSV
const sess = [{ pid: 'T', emails: [{ index: 1, condition: 'boss', scenario_id: 'S1', scenario: scen, events: boss.events, final_text: boss.S.body }] }];
const ec = A.editsCSV(sess), evc = A.eventsCSV(sess);
assert.ok(ec.split('\n').length > 20 && evc.split('\n').length > 200);
console.log(ec.split('\n').slice(0, 3).join('\n'));
console.log('analysis tests passed');
