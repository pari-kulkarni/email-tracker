// Turns a saved email record (raw events + final text) into the derived measures the log view and exports use:
// revisions, pauses, provenance spans, AI-edited spans, "possibly AI-inspired" flags, timeline entries, CSV rows.
// Shared by the browser (window.Analysis) and the server (require).
(function (root) {
  const Core = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.Core;
  const DEF = { PAUSE_MS: 2000, AI_INSPIRED_MATCH_WORDS: 4, LARGE_CHANGE_WORDS: 8 };
  const wc = s => (s.match(/\S+/g) || []).length;
  const KEY_OF_VIA = { typed: 'typed', autocomplete: 'autocomplete', spellcheck: 'spellcheck', autocorrect: 'autocorrect',
                       autocorrect_undo: 'typed', paste_ai: 'ai', paste_own: 'paste_own', undo: 'undo' };

  // The changed region between two strings. wordAlign expands it to whole words (for display + size).
  function region(before, after, wordAlign) {
    const d = Core.charDelta(before, after);
    let p = d.pos, eb = p + d.del.length, ea = p + d.ins.length;
    if (wordAlign) {
      const content = /\S/.test(d.ins + d.del);   // whitespace-only changes still expand to the neighbouring words
      const startsWs = content && (/^\s/.test(d.ins) || /^\s/.test(d.del)), endsWs = content && (/\s$/.test(d.ins) || /\s$/.test(d.del));
      if (!startsWs) while (p > 0 && !/\s/.test(before[p - 1])) p--;
      if (!endsWs) while (eb < before.length && !/\s/.test(before[eb])) { eb++; ea++; }
    }
    return { pos: p, del: before.slice(p, eb), ins: after.slice(p, ea) };
  }

  function analyze(email, cfgIn) {
    const cfg = { ...DEF, ...(cfgIn || {}) };
    const ev = email.events || [];
    const start = ev.find(e => e.type === 'writing_start') || ev[0] || { t: 0 };
    const t0 = start.t;
    const S = { body: '', labels: [], subject: (email.scenario && email.scenario.subject) || '' };
    const spans = [], born = [], revOf = [], graveyard = [];
    let spanSeq = 0, revSeq = 0, cur = null, lastEditT = t0, lastRev = null, lastPasteSpan = null;
    const revisions = [], entries = [], replies = [], prompts = [], tabEvents = [];
    const replyById = {}, acShown = new Map(), acorr = new Map();

    function handleEdit(e) {
      const field = e.field || 'body', isBody = field === 'body', via = e.via || 'typed', hasIns = e.ins.length > 0;
      const key = hasIns ? (KEY_OF_VIA[via] || 'unknown') : 'deleted';
      const mergeable = (key === 'typed' && via === 'typed') || key === 'deleted';
      const before = isBody ? S.body : S.subject;
      const touches = cur && cur.field === field && cur.key === key && mergeable && (e.t - cur.t1) < cfg.PAUSE_MS &&
                      e.pos <= cur.cursor && e.pos + e.del.length >= cur.cursor;
      if (!touches) {
        const gap = Math.max(0, e.t - lastEditT);
        const visitedChat = tabEvents.some(x => x.t >= lastEditT && x.t <= e.t && x.to === 'chat');
        cur = { id: ++revSeq, field, key, source: key, via, t0: e.t, t1: e.t, before, after: before, cursor: e.pos, edits: 0,
                pause_ms: gap, pause_first: lastEditT === t0 && !revisions.length, pause_where: visitedChat ? 'AI Chat tab' : 'Email tab',
                ai_edit: false, ai_reply: null, ins_chars: 0, del_chars: 0, deleted_sources: new Set(), flags: new Set(), ai_inspired: [], autocorrect: null };
        revisions.push(cur); entries.push({ kind: 'revision', t: e.t, rev: cur });
      }
      let sp = null;
      if (isBody) {
        const delLabels = S.labels.slice(e.pos, e.pos + e.del.length), delSpans = spans.slice(e.pos, e.pos + e.del.length);
        delLabels.forEach(l => cur.deleted_sources.add(l));
        delSpans.filter(Boolean).forEach(s => { s.edited = true; cur.ai_edit = true; });
        const left = spans[e.pos - 1], right = spans[e.pos + e.del.length], inside = !!(left && right && left === right);
        if (inside) { left.edited = true; cur.ai_edit = true; }
        let newSpans;
        if (via === 'paste_ai') { sp = { id: ++spanSeq, reply: null, edited: false }; newSpans = new Array(e.ins.length).fill(sp); }
        else if (inside) newSpans = new Array(e.ins.length).fill(left);
        else if (via === 'undo' && hasIns) { const g = graveyard.slice().reverse().find(x => x.text === e.ins); newSpans = g ? g.spans.slice() : new Array(e.ins.length).fill(null); }
        else newSpans = new Array(e.ins.length).fill(null);
        if (e.del.length) graveyard.push({ text: e.del, spans: delSpans });
        Core.applyEdit(S, e);
        spans.splice(e.pos, e.del.length, ...newSpans);
        born.splice(e.pos, e.del.length, ...new Array(e.ins.length).fill(e.t));
        revOf.splice(e.pos, e.del.length, ...new Array(e.ins.length).fill(cur.id));
      } else Core.applyEdit(S, e);
      cur.after = isBody ? S.body : S.subject; cur.t1 = e.t; cur.cursor = e.pos + e.ins.length; cur.edits++;
      cur.ins_chars += e.ins.length; cur.del_chars += e.del.length;
      if (e.flag || key === 'unknown') cur.flags.add('unknown_source');
      lastEditT = e.t; lastRev = cur; lastPasteSpan = sp;
    }

    for (const e of ev) {
      switch (e.type) {
        case 'tab_switch': tabEvents.push(e); break;
        case 'ai_prompt': prompts.push(e); entries.push({ kind: 'prompt', t: e.t, id: e.prompt_id, text: e.text }); break;
        case 'ai_reply': {
          const r = { id: e.reply_id, t: e.t, text: e.text, model: e.model, prompt_id: e.prompt_id, bodyAt: S.body,
                      promptsText: prompts.map(p => p.text).join('\n'), used: false, copied: false, usedIn: [] };
          replies.push(r); replyById[r.id] = r; entries.push({ kind: 'reply', t: e.t, id: r.id, reply: r }); break;
        }
        case 'copy': if (e.ai_reply && replyById[e.ai_reply]) replyById[e.ai_reply].copied = true; break;
        case 'paste':
          if (e.blocked) entries.push({ kind: 'blocked', t: e.t, what: 'paste', text: e.text || '', field: e.field });
          else if (e.from && (e.field === 'body' || e.field === 'subject') && lastRev) {
            if (lastPasteSpan) lastPasteSpan.reply = e.from;
            lastRev.ai_reply = e.from;
            const r = replyById[e.from]; if (r) { r.used = true; r.usedIn.push(lastRev.id); }
          }
          break;
        case 'drop_blocked': entries.push({ kind: 'blocked', t: e.t, what: 'drop', text: e.text || '' }); break;
        case 'autocomplete_shown': acShown.set(e.suggestion_id, { shown: e, outcome: null, dismiss: null }); break;
        case 'autocomplete_accepted': { const o = acShown.get(e.suggestion_id); if (o) o.outcome = 'accepted'; break; }
        case 'autocomplete_dismissed': { const o = acShown.get(e.suggestion_id); if (o) { o.dismiss = e; if (e.reason === 'typed_through') o.outcome = 'typed_through'; } break; }
        case 'autocorrect_applied': acorr.set(e.autocorrect_id, { outcome: 'kept' }); if (lastRev) lastRev.autocorrect = { id: e.autocorrect_id, from: e.from, to: e.to }; break;
        case 'autocorrect_undone': { const o = acorr.get(e.autocorrect_id); if (o) o.outcome = 'undone'; break; }
        case 'edit': handleEdit(e); break;
        default: break;
      }
    }

    // ---- AI-inspired flag: typed text that closely matches an earlier AI reply (N+ words in a row) ----
    const N = cfg.AI_INSPIRED_MATCH_WORDS;
    const wordsOf = s => { const out = [], re = /[a-z0-9]+(?:'[a-z]+)?/g; s = s.toLowerCase().replace(/[’‘]/g, "'"); let m; while ((m = re.exec(s))) out.push({ w: m[0], s: m.index, e: m.index + m[0].length }); return out; };
    const grams = ws => { const g = new Set(); for (let i = 0; i + N <= ws.length; i++) g.add(ws.slice(i, i + N).map(x => x.w).join(' ')); return g; };
    const rg = replies.map(r => ({ r, g: grams(wordsOf(r.text)), ex: new Set([...grams(wordsOf(r.promptsText)), ...grams(wordsOf(r.bodyAt))]) }));
    const inspiredAt = new Array(S.body.length).fill(null), inspiredRanges = [];
    for (let i = 0; i < S.body.length;) {
      if (S.labels[i] !== 'typed') { i++; continue; }
      let j = i; while (j < S.body.length && S.labels[j] === 'typed') j++;
      const ws = wordsOf(S.body.slice(i, j));
      for (let k = 0; k + N <= ws.length; k++) {
        const gram = ws.slice(k, k + N).map(x => x.w).join(' '), a = i + ws[k].s, b = i + ws[k + N - 1].e;
        const bornMin = Math.min(...born.slice(a, b));
        const hit = rg.find(x => x.r.t < bornMin && x.g.has(gram) && !x.ex.has(gram));
        if (hit) for (let c = a; c < b; c++) inspiredAt[c] = hit.r.id;
      }
      i = j;
    }
    for (let i = 0; i < inspiredAt.length;) {                       // merge flagged chars into ranges
      if (!inspiredAt[i]) { i++; continue; }
      let j = i; while (j < inspiredAt.length && inspiredAt[j] === inspiredAt[i]) j++;
      inspiredRanges.push({ start: i, end: j, reply_id: inspiredAt[i], phrase: S.body.slice(i, j) });
      const seen = new Set();
      for (let c = i; c < j; c++) { const rev = revisions.find(r => r.id === revOf[c]); if (rev && !seen.has(rev.id)) { seen.add(rev.id); rev.ai_inspired.push({ reply_id: inspiredAt[i], phrase: S.body.slice(i, j) }); } }
      i = j;
    }

    // ---- finalize revisions ----
    for (const r of revisions) {
      const wordReg = region(r.before, r.after, true), charReg = region(r.before, r.after, false);
      r.region = (r.ai_edit || r.key === 'ai') ? charReg : wordReg;       // character level when AI text is involved
      r.region_chars = charReg;
      const dw = wc(wordReg.del), iw = wc(wordReg.ins);
      r.kind = charReg.ins && charReg.del ? 'replacement' : charReg.ins ? 'addition' : charReg.del ? 'deletion' : 'none';
      const m = Math.max(dw, iw); r.words_del = dw; r.words_ins = iw;
      r.size = m <= 1 ? 'small' : m >= cfg.LARGE_CHANGE_WORDS ? 'large' : 'medium';
      if (r.pause_ms >= cfg.PAUSE_MS) r.flags.add('long_pause');
      if (r.ai_inspired.length) r.flags.add('ai_inspired');
      if (r.autocorrect && (acorr.get(r.autocorrect.id) || {}).outcome === 'undone') r.flags.add('ac_undone');
      r.deleted_sources = [...r.deleted_sources];
      r.flags = [...r.flags];
    }
    for (const r of revisions) {
      const src = ['typed', 'autocomplete', 'spellcheck', 'autocorrect', 'ai'].includes(r.key) ? [r.key] : [];
      const entry = entries.find(x => x.rev === r);
      entry.attrs = { source: src, aiEdit: r.ai_edit, kind: r.kind, size: r.size, flags: r.flags.slice() };
    }
    for (const x of entries) {
      if (x.kind === 'prompt') x.attrs = { source: ['ai'], aiEdit: false, kind: null, size: null, flags: [] };
      if (x.kind === 'reply') x.attrs = { source: ['ai'], aiEdit: false, kind: null, size: null, flags: x.reply.used ? [] : ['unused_reply'] };
      if (x.kind === 'blocked') x.attrs = { source: [], aiEdit: false, kind: null, size: null, flags: [] };
    }
    for (const [id, o] of acShown) {
      if (o.outcome === 'accepted' || o.outcome === 'typed_through') continue;
      entries.push({ kind: 'ac_rejected', t: o.shown.t, id, text: o.shown.text, visible_ms: o.dismiss && o.dismiss.visible_ms, reason: o.dismiss && o.dismiss.reason,
                     partial_chars: (o.dismiss && o.dismiss.partial_chars) || 0,
                     attrs: { source: ['autocomplete'], aiEdit: false, kind: null, size: null, flags: ['rejected_ac'] } });
    }
    entries.forEach((x, i) => { x._i = i; });
    entries.sort((a, b) => a.t - b.t || a._i - b._i);

    // ---- final text, coloured by source ----
    const replayOk = !email.final_text || email.final_text === S.body;
    const runs = [];
    if (replayOk) {
      for (let i = 0; i < S.body.length; i++) {
        const aiEd = !!(spans[i] && spans[i].edited), insp = inspiredAt[i] || null, rev = revOf[i] || null, label = S.labels[i];
        const last = runs[runs.length - 1];
        if (last && last.label === label && last.aiEdited === aiEd && last.inspired === insp && last.rev === rev) last.text += S.body[i];
        else runs.push({ text: S.body[i], label, aiEdited: aiEd, inspired: insp, rev });
      }
    } else for (const r of (email.char_labels || [])) runs.push({ text: email.final_text.slice(r.start, r.end), label: r.source, aiEdited: false, inspired: null, rev: null });

    const sendEv = ev.find(e => e.type === 'send');
    return { t0, t_end: sendEv ? sendEv.t : (ev.length ? ev[ev.length - 1].t : t0), revisions, entries, replies, runs, inspiredRanges, replayOk,
             final_subject: S.subject, final_text: replayOk ? S.body : email.final_text, cfg };
  }

  // ---- filters: groups are AND-ed, options inside a group are OR-ed ----
  const emptyFilters = () => ({ source: [], aiEdit: false, kind: [], size: [], flag: [] });
  const anyFilter = f => f.source.length || f.aiEdit || f.kind.length || f.size.length || f.flag.length;
  function matches(entry, f) {
    const a = entry.attrs || { source: [], flags: [] };
    if (f.source.length && !f.source.some(s => a.source.includes(s))) return false;
    if (f.aiEdit && !a.aiEdit) return false;
    if (f.kind.length && !(a.kind && f.kind.includes(a.kind))) return false;
    if (f.size.length && !(a.size && f.size.includes(a.size))) return false;
    if (f.flag.length && !f.flag.some(x => a.flags.includes(x))) return false;
    return true;
  }

  // ---- CSV exports ----
  const csvCell = v => { if (v === null || v === undefined) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csvRow = a => a.map(csvCell).join(',');
  const EVENT_COLS = ['pid', 'email_index', 'condition', 'scenario_id', 'seq', 't', 't_rel_ms', 'tab', 'type', 'field', 'pos', 'key', 'source', 'text', 'data'];
  const EDIT_COLS = ['pid', 'email_index', 'condition', 'scenario_id', 'revision_id', 'field', 'source', 'kind', 'size', 'start_ms', 'end_ms', 'duration_ms',
                     'pause_before_ms', 'pause_where', 'chars_added', 'chars_deleted', 'words_added', 'words_deleted', 'before_text', 'after_text',
                     'deleted_sources', 'ai_reply', 'edits_ai_text', 'long_pause', 'ac_undone', 'ai_inspired', 'ai_inspired_reply'];
  function eventsCSV(sessions, cfg) {
    const rows = [csvRow(EVENT_COLS)];
    for (const s of sessions) for (const em of s.emails) {
      if (!em.events) continue;
      const t0 = ((em.events.find(e => e.type === 'writing_start')) || em.events[0] || { t: 0 }).t;
      for (const e of em.events) {
        const { pid, seq, t, tab, type, field, pos, key, source, text, ins, email, ...rest } = e;
        rows.push(csvRow([s.pid, em.index, em.condition, em.scenario_id, seq, t, t - t0, tab, type, field, pos, key, source, text !== undefined ? text : ins, rest]));
      }
    }
    return rows.join('\n') + '\n';
  }
  function editsCSV(sessions, cfg) {
    const rows = [csvRow(EDIT_COLS)];
    for (const s of sessions) for (const em of s.emails) {
      if (!em.events) continue;
      const a = analyze(em, cfg);
      for (const r of a.revisions) rows.push(csvRow([s.pid, em.index, em.condition, em.scenario_id, r.id, r.field, r.source, r.kind, r.size, r.t0 - a.t0, r.t1 - a.t0, r.t1 - r.t0,
        r.pause_ms, r.pause_where, r.ins_chars, r.del_chars, r.words_ins, r.words_del, r.region.del, r.region.ins, r.deleted_sources.join('|'), r.ai_reply || '',
        r.ai_edit, r.flags.includes('long_pause'), r.flags.includes('ac_undone'), r.flags.includes('ai_inspired'), r.ai_inspired.map(x => x.reply_id).join('|')]));
    }
    return rows.join('\n') + '\n';
  }

  const Analysis = { analyze, region, emptyFilters, anyFilter, matches, eventsCSV, editsCSV, DEF };
  if (typeof module !== 'undefined' && module.exports) module.exports = Analysis; else root.Analysis = Analysis;
})(typeof window !== 'undefined' ? window : globalThis);
