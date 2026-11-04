// Pure logic shared by the browser (window.Core) and the server (require). No DOM access here.
(function (root) {
  const norm = s => s.replace(/\s+/g, ' ').trim();

  // Minimal change between two strings: common prefix/suffix trimmed.
  function charDelta(a, b) {
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return { pos: p, del: a.slice(p, a.length - s), ins: b.slice(p, b.length - s) };
  }

  // labels: one source string per character.  runs: [[source, count], ...]  ranges: [{start,end,source}]
  function runsFromLabels(labels) {
    const runs = [];
    for (const l of labels) { const last = runs[runs.length - 1]; if (last && last[0] === l) last[1]++; else runs.push([l, 1]); }
    return runs;
  }
  function labelsFromRuns(runs) { const out = []; for (const [s, n] of runs) for (let i = 0; i < n; i++) out.push(s); return out; }
  function rangesFromLabels(labels) {
    const out = []; let i = 0;
    for (const [source, n] of runsFromLabels(labels)) { out.push({ start: i, end: i + n, source }); i += n; }
    return out;
  }
  const summarize = runs => (runs.length === 1 ? runs[0][0] : 'mixed');

  // Apply one logged 'edit' event to a state {body, labels, subject}. Used live and for replay.
  function applyEdit(state, e) {
    if (e.field === 'subject') {
      state.subject = state.subject.slice(0, e.pos) + e.ins + state.subject.slice(e.pos + e.del.length);
      return state;
    }
    const insLabels = e.runs ? labelsFromRuns(e.runs) : new Array(e.ins.length).fill(e.source);
    state.body = state.body.slice(0, e.pos) + e.ins + state.body.slice(e.pos + e.del.length);
    state.labels.splice(e.pos, e.del.length, ...insLabels);
    return state;
  }
  function replay(events, initial) {
    const state = { body: '', labels: [], subject: (initial && initial.subject) || '' };
    for (const e of events) if (e.type === 'edit') applyEdit(state, e);
    return state;
  }

  const Core = { norm, charDelta, runsFromLabels, labelsFromRuns, rangesFromLabels, summarize, applyEdit, replay };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core; else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
