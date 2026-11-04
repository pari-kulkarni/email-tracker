const assert = require('assert');
const C = require('../public/core.js');

// Simulate the editor: apply edits to a state, as app.js does.
const S = { body: '', labels: [], subject: '' };
const ed = (pos, del, ins, source, runs) => C.applyEdit(S, { field: 'body', pos, del, ins, source, ...(runs ? { runs } : {}) });

// participant types "Hi. "
'Hi. '.split('').forEach((ch, i) => ed(i, '', ch, 'typed'));
// pastes AI text "I've" (labelled ai)
ed(4, '', "I've", 'ai');
assert.strictEqual(S.body, "Hi. I've");
// changes "I've" -> "I have": delete the apostrophe, then type " ha" before "ve"
ed(5, "'", '', null);
ed(5, '', ' ha', 'typed');
assert.strictEqual(S.body, 'Hi. I have');
const tail = C.rangesFromLabels(S.labels).filter(r => r.start >= 4);
console.log('labels for "I have":', JSON.stringify(S.labels.slice(4)));
assert.deepStrictEqual(S.labels.slice(4), ['ai', 'typed', 'typed', 'typed', 'ai', 'ai']);   // I | " ha" | ve

// mixed-source insert (paste of own text that has several sources) + replay round trip
const events = [
  { type: 'edit', field: 'body', pos: 0, del: '', ins: 'abc', source: 'typed' },
  { type: 'edit', field: 'body', pos: 3, del: '', ins: 'XYZ', source: 'mixed', runs: [['ai', 1], ['spellcheck', 2]] },
  { type: 'edit', field: 'subject', pos: 0, del: '', ins: 'Re: ', source: 'typed' },
  { type: 'edit', field: 'body', pos: 1, del: 'b', ins: '', source: null },
];
const r = C.replay(events, { subject: 'Hello' });
assert.strictEqual(r.body, 'acXYZ');
assert.deepStrictEqual(r.labels, ['typed', 'typed', 'ai', 'spellcheck', 'spellcheck']);
assert.strictEqual(r.subject, 'Re: Hello');
assert.deepStrictEqual(C.rangesFromLabels(r.labels), [{ start: 0, end: 2, source: 'typed' }, { start: 2, end: 3, source: 'ai' }, { start: 3, end: 5, source: 'spellcheck' }]);

// charDelta
assert.deepStrictEqual(C.charDelta('hello world', 'hello brave world'), { pos: 6, del: '', ins: 'brave ' });
assert.deepStrictEqual(C.charDelta('abc', 'abc'), { pos: 3, del: '', ins: '' });
console.log('core tests passed');
