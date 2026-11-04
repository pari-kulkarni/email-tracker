// Log view + filter bar. Used for the post-Send recall interview, the comparison view and the researcher page.
//   const lv = LogView.create(container, emailRecord, { cfg, title, layout: 'wide'|'stack' });   lv.setFilters(f)
//   const fb = LogFilters.create(container, f => lv.setFilters(f));
(function (root) {
  const A = root.Analysis;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const secs = ms => (ms / 1000).toFixed(1) + 's';
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const vis = s => esc(s).replace(/\n/g, '↵\n');
  const SRC = { typed: 'Typed', autocomplete: 'Autocomplete', spellcheck: 'Spellcheck', autocorrect: 'Autocorrect', ai: 'AI pasted', paste_own: 'Pasted (own text)',
                undo: 'Undo / redo', unknown: 'Unknown source', deleted: 'Deleted' };
  const FLAG = { rejected_ac: 'Autocomplete rejected', ac_undone: 'Autocorrect undone', unused_reply: 'AI reply not used', ai_inspired: 'Possibly AI-inspired',
                 long_pause: 'Long pause', unknown_source: 'Unknown source' };

  function snippet(text, pos, len, mid, cls, ctx) {
    const pre = text.slice(Math.max(0, pos - ctx), pos), post = text.slice(pos + len, pos + len + ctx);
    return `${pos - ctx > 0 ? '…' : ''}${esc(pre)}${mid ? `<${cls}>${vis(mid)}</${cls}>` : '<span class="lv-gap">∅</span>'}${esc(post)}${pos + len + ctx < text.length ? '…' : ''}`;
  }

  function create(container, rec, opts = {}) {
    const a = A.analyze(rec, opts.cfg), sc = rec.scenario || {};
    let filters = A.emptyFilters(), openIdx = null, selRev = null;
    container.classList.add('lv'); container.classList.toggle('lv-wide', opts.layout === 'wide');
    container.innerHTML = `
      ${opts.title ? `<h2 class="lv-title">${esc(opts.title)}</h2>` : ''}
      <div class="lv-left">
        <div class="lv-card lv-scn"><h3>Scenario</h3><dl>
          <dt>Writing to</dt><dd>${esc(sc.recipient_role)}</dd><dt>Relationship</dt><dd>${esc(sc.relationship)}</dd>
          <dt>Goal</dt><dd>${esc(sc.goal)}</dd></dl></div>
        <div class="lv-card lv-final"><h3>Final email <span class="lv-ro">view only</span></h3>
          <div class="lv-hdr"><b>To:</b> ${esc(rec.to || sc.to || '')}<br><b>Subject:</b> ${esc(a.final_subject || rec.final_subject || '')}</div>
          <div class="lv-body"></div>
          <div class="lv-legend"></div></div>
      </div>
      <div class="lv-right"><div class="lv-listhead">Revision history <span class="lv-hint">click an entry for details</span></div><div class="lv-list"></div></div>`;
    const $ = s => container.querySelector(s);

    // final email, colour-coded by source
    const body = $('.lv-body');
    body.innerHTML = a.runs.map(r => `<span class="lv-c s-${esc(r.label)}${r.aiEdited ? ' ai-edited' : ''}${r.inspired ? ' inspired' : ''}" ${r.rev ? `data-rev="${r.rev}"` : ''}>${esc(r.text)}</span>`).join('') || '<span class="lv-gap">(empty)</span>';
    const used = new Set(a.runs.map(r => r.label));
    $('.lv-legend').innerHTML = ['typed', 'autocomplete', 'spellcheck', 'autocorrect', 'ai', 'unknown'].filter(k => k === 'typed' || used.has(k))
      .map(k => `<span class="lv-key"><i class="lv-sw s-${k}"></i>${SRC[k]}</span>`).join('')
      + (a.runs.some(r => r.aiEdited) ? '<span class="lv-key"><i class="lv-sw ai-edited s-ai"></i>AI text you edited</span>' : '')
      + (a.runs.some(r => r.inspired) ? '<span class="lv-key"><i class="lv-sw inspired"></i>Possibly AI-inspired</span>' : '');

    const list = $('.lv-list');
    const entryHead = (x, i) => {
      const t = `<span class="lv-time">${clock(x.t - a.t0)}</span>`;
      if (x.kind === 'prompt') return `${t}<span class="lv-badge b-ai">You asked the AI</span><span class="lv-sum">${esc(cut(x.text.replace(/\s+/g, ' '), 80))}</span>`;
      if (x.kind === 'reply') return `${t}<span class="lv-badge b-ai">AI replied</span><span class="lv-sum">${esc(cut(x.reply.text.replace(/\s+/g, ' '), 80))}</span>${x.reply.used ? `<span class="lv-chip">used in #${x.reply.usedIn.join(', #')}</span>` : '<span class="lv-chip flag">not used</span>'}`;
      if (x.kind === 'ac_rejected') return `${t}<span class="lv-badge b-autocomplete">Suggestion rejected</span><span class="lv-sum">“${esc(x.text.trim())}”</span>`;
      if (x.kind === 'blocked') return `${t}<span class="lv-badge b-blocked">Blocked ${x.what}</span><span class="lv-sum">${esc(cut(x.text, 60))}</span>`;
      const r = x.rev, g = r.region;
      let sum;
      if (r.key === 'ai') sum = `Pasted${r.ai_reply ? ' from reply ' + esc(r.ai_reply) : ''}: “${esc(cut(g.ins, 50))}”`;
      else if (r.key === 'spellcheck' || r.key === 'autocorrect') sum = `<del>${esc(cut(g.del, 30))}</del> → <ins>${esc(cut(g.ins, 30))}</ins>`;
      else if (r.kind === 'addition') sum = `+ <ins>${vis(cut(g.ins, 60))}</ins>`;
      else if (r.kind === 'deletion') sum = `− <del>${vis(cut(g.del, 60))}</del>`;
      else if (r.kind === 'replacement') sum = `<del>${vis(cut(g.del, 30))}</del> → <ins>${vis(cut(g.ins, 30))}</ins>`;
      else sum = '<span class="lv-gap">no net change</span>';
      const chips = r.flags.filter(f => f !== 'unknown_source' || r.key !== 'unknown').map(f => `<span class="lv-chip flag">${FLAG[f] || f}</span>`).join('')
        + (r.ai_edit ? '<span class="lv-chip ai">edits AI text</span>' : '');
      return `${t}<span class="lv-badge b-${r.key}">${SRC[r.key] || r.key}</span>${r.field === 'subject' ? '<span class="lv-chip">subject</span>' : ''}<span class="lv-sum">${sum}</span>${r.pause_ms >= a.cfg.PAUSE_MS ? `<span class="lv-chip pause">⏸ ${secs(r.pause_ms)}</span>` : ''}${chips}`;
    };
    const entryDetail = x => {
      if (x.kind === 'prompt') return `<div class="lv-full">${esc(x.text)}</div>`;
      if (x.kind === 'reply') return `<div class="lv-full">${esc(x.reply.text)}</div><div class="lv-kv"><span>Model</span><b>${esc(x.reply.model || '')}</b><span>Copied</span><b>${x.reply.copied ? 'yes' : 'no'}</b>
        <span>Pasted into email</span><b>${x.reply.used ? 'yes — revision #' + x.reply.usedIn.join(', #') : 'no (never pasted from)'}</b></div>`;
      if (x.kind === 'ac_rejected') return `<div class="lv-kv"><span>Suggestion</span><b>“${esc(x.text)}”</b><span>Shown for</span><b>${x.visible_ms != null ? secs(x.visible_ms) : '—'}</b>
        <span>Dismissed by</span><b>${esc({ typing: 'typing something else', esc: 'pressing Esc', caret_moved: 'moving the cursor', blur: 'leaving the box', tab_switch: 'switching tabs' }[x.reason] || x.reason || 'unknown')}</b>
        ${x.partial_chars ? `<span>Typed through</span><b>${x.partial_chars} characters</b>` : ''}</div>`;
      if (x.kind === 'blocked') return `<div class="lv-kv"><span>Attempt</span><b>${x.what} blocked</b></div><div class="lv-full">${esc(x.text)}</div>`;
      const r = x.rev, g = r.region, c = 40;
      const where = r.pause_first ? 'before the first edit' : r.pause_where === 'AI Chat tab' ? 'incl. time in the AI Chat tab' : 'in the Email tab';
      let extra = '';
      if (r.ai_reply) extra += `<span>From</span><b>AI reply ${esc(r.ai_reply)} <a href="#" data-goto="reply:${esc(r.ai_reply)}">show reply</a></b>`;
      if (r.ai_edit) extra += '<span>Note</span><b>Change made inside AI-pasted text (character level)</b>';
      if (r.deleted_sources.length) extra += `<span>Removed text was</span><b>${r.deleted_sources.map(s => esc(SRC[s] || s)).join(', ')}</b>`;
      if (r.autocorrect) extra += `<span>Autocorrect</span><b>“${esc(r.autocorrect.from)}” → “${esc(r.autocorrect.to)}” — ${r.flags.includes('ac_undone') ? 'undone by the participant' : 'kept'}</b>`;
      for (const q of r.ai_inspired) extra += `<span>Possibly AI-inspired</span><b>“${esc(q.phrase)}” resembles AI reply ${esc(q.reply_id)} <a href="#" data-goto="reply:${esc(q.reply_id)}">show reply</a></b>`;
      if (r.flags.includes('unknown_source')) extra += '<span>Warning</span><b>Text appeared without a known source</b>';
      return `<div class="lv-ba"><div><span class="lv-lbl">Before</span><div class="lv-snip">${snippet(r.before, g.pos, g.del.length, g.del, 'del', c)}</div></div>
        <div><span class="lv-lbl">After</span><div class="lv-snip">${snippet(r.after, g.pos, g.ins.length, g.ins, 'ins', c)}</div></div></div>
        <div class="lv-kv"><span>Source</span><b>${esc(SRC[r.key] || r.key)}</b><span>Field</span><b>${esc(r.field)}</b>
        <span>Time</span><b>${clock(r.t0 - a.t0)} – ${clock(r.t1 - a.t0)} (${secs(r.t1 - r.t0)}, ${r.edits} edit${r.edits === 1 ? '' : 's'})</b>
        <span>Pause before</span><b>${secs(r.pause_ms)} ${esc(where)}</b>${extra}</div>`;
    };

    function render() {
      const rows = a.entries.map((x, i) => [x, i]).filter(([x]) => A.matches(x, filters));
      list.innerHTML = rows.length ? rows.map(([x, i]) => `<div class="lv-entry k-${x.kind}${openIdx === i ? ' open' : ''}${x.rev && x.rev.id === selRev ? ' sel' : ''}" data-i="${i}">
          <div class="lv-head">${entryHead(x, i)}</div>${openIdx === i ? `<div class="lv-detail">${entryDetail(x)}</div>` : ''}</div>`).join('')
        : `<div class="lv-none">${A.anyFilter(filters) ? 'No entries match these filters.' : 'No activity recorded.'}</div>`;
      body.querySelectorAll('.lv-c').forEach(el => el.classList.toggle('sel', selRev != null && el.dataset.rev == selRev));
    }
    function select(i, scroll) {
      const x = a.entries[i]; if (!x) return;
      openIdx = openIdx === i ? null : i; selRev = openIdx !== null && x.rev ? x.rev.id : null; render();
      if (scroll) { const el = list.querySelector(`[data-i="${i}"]`); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
    list.addEventListener('click', e => {
      const g = e.target.closest('[data-goto]');
      if (g) { e.preventDefault(); const id = g.dataset.goto.split(':')[1]; const i = a.entries.findIndex(x => x.kind === 'reply' && x.id === id);
        if (i >= 0) { filters = A.emptyFilters(); opts.onFilterReset && opts.onFilterReset(); openIdx = null; select(i, true); } return; }
      const el = e.target.closest('.lv-entry'); if (el) select(+el.dataset.i, false);
    });
    body.addEventListener('click', e => {                                    // click text in the final email -> its revision
      const el = e.target.closest('[data-rev]'); if (!el) return;
      const i = a.entries.findIndex(x => x.rev && x.rev.id == el.dataset.rev); if (i < 0) return;
      if (!A.matches(a.entries[i], filters)) { filters = A.emptyFilters(); opts.onFilterReset && opts.onFilterReset(); }
      openIdx = null; select(i, true);
    });
    render();
    return { setFilters(f) { filters = f; openIdx = null; selRev = null; render(); }, analysis: a, el: container };
  }

  // ---- filter bar ----
  const GROUPS = [
    { key: 'source', label: 'Source', opts: [['typed', 'Typed'], ['autocomplete', 'Autocomplete'], ['spellcheck', 'Spellcheck'], ['autocorrect', 'Autocorrect'], ['ai', 'AI pasted']] },
    { key: 'aiEdit', label: 'Your changes to AI text', toggle: true, opts: [[true, 'Only edits inside AI-pasted text']] },
    { key: 'kind', label: 'Kind of change', opts: [['addition', 'Additions'], ['deletion', 'Deletions'], ['replacement', 'Replacements']] },
    { key: 'size', label: 'Size', opts: [['small', 'Small (a word or less)'], ['large', 'Large (sentence or more)']] },
    { key: 'flag', label: 'Flags', opts: [['rejected_ac', 'Rejected autocomplete'], ['ac_undone', 'Undone autocorrect'], ['unused_reply', 'Unused AI replies'], ['ai_inspired', 'Possibly AI-inspired'], ['long_pause', 'Long pauses']] },
  ];
  function createFilters(container, onChange) {
    let f = A.emptyFilters();
    container.classList.add('lf');
    container.innerHTML = GROUPS.map(g => `<div class="lf-group"><span class="lf-label">${g.label}</span>${g.opts.map(([v, l]) =>
      `<button type="button" class="lf-chip" aria-pressed="false" data-g="${g.key}" data-v="${v}">${l}</button>`).join('')}</div>`).join('') +
      '<button type="button" class="lf-clear" hidden>Clear filters</button>';
    const sync = () => {
      container.querySelectorAll('.lf-chip').forEach(b => {
        const g = b.dataset.g, on = g === 'aiEdit' ? f.aiEdit : f[g].includes(b.dataset.v);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      container.querySelector('.lf-clear').hidden = !A.anyFilter(f);
    };
    container.onclick = e => {
      const b = e.target.closest('.lf-chip');
      if (b) {
        const g = b.dataset.g;
        if (g === 'aiEdit') f.aiEdit = !f.aiEdit;
        else { const i = f[g].indexOf(b.dataset.v); if (i >= 0) f[g].splice(i, 1); else f[g].push(b.dataset.v); }
      } else if (e.target.closest('.lf-clear')) f = A.emptyFilters(); else return;
      sync(); onChange(JSON.parse(JSON.stringify(f)));
    };
    sync();
    return { get: () => f, reset() { f = A.emptyFilters(); sync(); onChange(JSON.parse(JSON.stringify(f))); } };
  }

  root.LogView = { create };
  root.LogFilters = { create: createFilters };
})(window);
