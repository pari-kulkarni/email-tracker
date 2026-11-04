(() => {
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let CFG = {}, curPid = null, sess = null;
const key = () => sessionStorage.getItem('rkey') || '';
const withKey = u => u + (key() ? (u.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key()) : '');
async function api(u, opts) {
  const r = await fetch(withKey(u), opts);
  if (r.status === 401) { $('#auth').hidden = false; throw new Error('locked'); }
  return r;
}
$('#keybtn').onclick = () => { sessionStorage.setItem('rkey', $('#key').value); $('#auth').hidden = true; load(); };

function wireDownloads(pid) {
  document.querySelectorAll('[data-dl]').forEach(a => {
    const [p, t] = a.dataset.dl.includes(':') ? a.dataset.dl.split(':') : [pid, a.dataset.dl];
    a.href = withKey(`/api/admin/export?pid=${encodeURIComponent(p)}&type=${t}`);
  });
}
async function load() {
  try { CFG = await (await fetch('/api/config')).json(); const rows = await (await api('/api/admin/sessions')).json(); renderList(rows); } catch (e) { if (e.message !== 'locked') console.error(e); }
}
function renderList(rows) {
  $('#empty').hidden = rows.length > 0; wireDownloads(null);
  $('#rows').innerHTML = rows.map(r => `<tr class="row" data-pid="${esc(r.pid)}"><td><b>${esc(r.pid)}</b></td><td>${r.order.join(' → ')}</td>
    ${r.statuses.map(s => `<td><span class="pill ${s}">${s.replace('_', ' ')}</span></td>`).join('')}<td>${new Date(r.started_at).toLocaleString()}</td></tr>`).join('');
}
$('#rows').onclick = e => { const tr = e.target.closest('tr.row'); if (tr) openSession(tr.dataset.pid); };
$('#back').onclick = () => { $('#sessview').hidden = true; $('#listview').hidden = false; load(); };

async function openSession(pid) {
  curPid = pid; sess = await (await api('/api/admin/session?pid=' + encodeURIComponent(pid))).json();
  $('#listview').hidden = true; $('#sessview').hidden = false; $('#sesstitle').textContent = `${pid} · ${sess.order.join(' → ')}`; wireDownloads(pid);
  const tabs = sess.emails.map(e => `<button class="tab" data-v="${e.index}">Email ${e.index}: ${esc(e.condition)} <span class="pill ${e.status}">${e.status.replace('_', ' ')}</span></button>`);
  if (sess.emails.length === 2) tabs.push('<button class="tab" data-v="cmp">Compare side by side</button>');
  $('#tabsr').innerHTML = tabs.join('');
  $('#tabsr').onclick = e => { const b = e.target.closest('.tab'); if (b) showView(b.dataset.v); };
  showView('1');
}
function showView(v) {
  document.querySelectorAll('#tabsr .tab').forEach(b => b.classList.toggle('active', b.dataset.v === v));
  $('#rview').innerHTML = ''; $('#rL').innerHTML = ''; $('#rR').innerHTML = ''; $('#rfilters').innerHTML = '';
  const views = [], fb = LogFilters.create($('#rfilters'), f => views.forEach(x => x.setFilters(f)));
  const mk = (el, em, layout) => {
    if (!em.events || !em.events.length) { el.innerHTML = '<p class="note">No events recorded yet for this email.</p>'; return; }
    views.push(LogView.create(el, { ...em, to: em.to || em.scenario.to }, { cfg: CFG, layout, title: `Email ${em.index} (${em.condition}) — ${em.status.replace('_', ' ')}`, onFilterReset: () => fb.reset() }));
  };
  $('#rview').hidden = v === 'cmp'; $('#rcmp').hidden = v !== 'cmp';
  if (v === 'cmp') { ['boss', 'colleague'].forEach((c, i) => { const em = sess.emails.find(e => e.condition === c); if (em) mk($(i ? '#rR' : '#rL'), em, 'stack'); }); }
  else mk($('#rview'), sess.emails.find(e => String(e.index) === v), 'wide');
}
$('#del').onclick = async () => {
  const t = prompt(`This permanently deletes ALL data for ${curPid}. (Remember to delete the interview recording too.)\n\nType the PID to confirm:`);
  if (t !== curPid) return;
  const r = await api('/api/admin/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: curPid, confirm: t }) });
  alert(r.ok ? 'Deleted.' : 'Could not delete.'); $('#back').click();
};
load();
})();
