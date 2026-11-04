// Zero-dependency server (Node 18+).  Run: node server.js   ->  http://localhost:3000
// Data layout:  data/<PID>/session.json  (master record, written at start / begin / send)
//               data/<PID>/email<N>.events.jsonl  (raw events, appended continuously)
// Chat: uses the Anthropic API when ANTHROPIC_API_KEY is set, otherwise a built-in mock model
//       (override with "LLM_PROVIDER": "mock" | "anthropic" in config/config.json).
const http = require('http');
const fs = require('fs');
const path = require('path');
const Core = require('./public/core.js');
const Analysis = require('./public/analysis.js');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_DIR = path.join(ROOT, 'config');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const config = () => readJSON(path.join(CONFIG_DIR, 'config.json'));
const scenarios = () => readJSON(path.join(CONFIG_DIR, 'scenarios.json'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The browser only gets the settings it needs; the model and system prompt stay on the server.
const publicConfig = () => Object.fromEntries(Object.entries(config()).filter(([k]) => !/^(LLM_|CHAT_)/.test(k)));
const llmMode = cfg => (cfg.LLM_PROVIDER === 'mock' || (cfg.LLM_PROVIDER !== 'anthropic' && !process.env.ANTHROPIC_API_KEY)) ? 'mock' : 'anthropic';

// ---- participants sheet (config/participants.csv): re-read on every request so edits apply live ----
function sheet() {
  const lines = fs.readFileSync(path.join(CONFIG_DIR, 'participants.csv'), 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  const head = lines[0].split(',').map(s => s.trim());
  return lines.slice(1).map(l => { const c = l.split(',').map(s => s.trim()); return Object.fromEntries(head.map((h, i) => [h, c[i]])); })
    .filter(r => /^[A-Za-z0-9_-]{1,40}$/.test(r.pid || ''));
}
const findParticipant = pid => sheet().find(r => r.pid.toLowerCase() === String(pid || '').trim().toLowerCase());

// ---- storage helpers ----
const pidDir = pid => path.join(DATA_DIR, pid);
const sessionFile = pid => path.join(pidDir(pid), 'session.json');
const eventsFile = (pid, i) => path.join(pidDir(pid), `email${i}.events.jsonl`);
function writeAtomic(file, obj) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, file); }
function readEvents(pid, i) {
  if (!fs.existsSync(eventsFile(pid, i))) return [];
  return fs.readFileSync(eventsFile(pid, i), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function loadOrCreateSession(row) {
  fs.mkdirSync(pidDir(row.pid), { recursive: true });
  if (fs.existsSync(sessionFile(row.pid))) return readJSON(sessionFile(row.pid));
  const sc = scenarios(), order = [row.scenario_1, row.scenario_2];
  if (!order.every(c => sc[c])) throw new Error('participants.csv names a scenario that is not in scenarios.json');
  const sess = {
    pid: row.pid, order, started_at: Date.now(),
    emails: order.map((condition, k) => ({ index: k + 1, condition, scenario_id: sc[condition].id, scenario: sc[condition], status: 'pending' })),
  };
  writeAtomic(sessionFile(row.pid), sess);
  return sess;
}
const currentIndex = sess => (sess.emails.find(e => e.status !== 'sent') || {}).index || null;

// Chat transcript + per-reply usage, derived from the raw events.
function chatSummary(events) {
  const chat = [], replies = [];
  const pastedFrom = new Set(events.filter(e => e.type === 'paste' && !e.blocked && e.from && e.field !== 'chat_input').map(e => e.from));
  const copiedFrom = new Set(events.filter(e => e.type === 'copy' && e.ai_reply).map(e => e.ai_reply));
  for (const e of events) {
    if (e.type === 'ai_prompt') chat.push({ role: 'user', t: e.t, prompt_id: e.prompt_id, text: e.text });
    if (e.type === 'ai_reply') {
      chat.push({ role: 'assistant', t: e.t, reply_id: e.reply_id, prompt_id: e.prompt_id, model: e.model, text: e.text });
      replies.push({ reply_id: e.reply_id, prompt_id: e.prompt_id, t: e.t, used: pastedFrom.has(e.reply_id), copied: copiedFrom.has(e.reply_id) });
    }
  }
  return { chat, ai_replies: replies };
}

// ---- chat models ----
function mockReply(messages) {
  const last = (messages[messages.length - 1] || {}).content || '';
  if (/subject/i.test(last)) return "Here are a few subject line options:\n\n1. Quick update on the project\n2. Project status and next steps\n3. Checking in about the project\n\nWant me to adjust the tone of any of these?";
  if (/friendly|casual|warm|relax/i.test(last)) return "Sure, here's a friendlier version:\n\nHi there,\n\nHope your week is going well! I've finished the update and wanted to share where things stand. Let me know what you think, and I'm happy to chat if that's easier.\n\nThanks so much,\n[Your name]";
  if (/professional|formal|polish|rewrite|rephrase|improve|shorter|concise|tone|edit|fix|revise|better|email|draft/i.test(last)) return "Certainly! Here's a more polished version:\n\nHello,\n\nI've finished the update and wanted to share where things stand. Please let me know if you'd like to discuss any of the details.\n\nBest regards,\n[Your name]";
  return "I'd be happy to help with that. Could you tell me a bit more about what you're trying to do, or paste the draft you'd like me to look at?";
}
async function streamMock(messages, send, res) {
  for (const tok of mockReply(messages).split(/(\s+)/).filter(Boolean)) {
    if (res.destroyed) return;
    send({ type: 'delta', text: tok }); if (tok.trim()) await sleep(30);
  }
}
async function streamAnthropic(cfg, messages, send, res) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.LLM_MODEL, max_tokens: cfg.CHAT_MAX_TOKENS || 1024, stream: true, ...(cfg.CHAT_SYSTEM_PROMPT ? { system: cfg.CHAT_SYSTEM_PROMPT } : {}), messages }),
  });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error((d.error && d.error.message) || `LLM error ${r.status}`); }
  const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done || res.destroyed) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      try { const ev = JSON.parse(line.slice(5)); if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') send({ type: 'delta', text: ev.delta.text }); } catch {}
    }
  }
}


// ---- autocomplete (Smart Compose style) ----
function cleanSuggestion(raw, text, maxWords) {
  let s = String(raw || '').split('\n')[0].replace(/^["'`]+|["'`]+$/g, '');
  const words = s.trim().split(/\s+/).filter(Boolean).slice(0, maxWords);
  if (!words.length) return '';
  s = words.join(' ');
  const startsWithSpace = /^\s/.test(String(raw || ''));
  if (/\s$/.test(text)) return s;                              // text already ends in a space/newline
  return startsWithSpace ? ' ' + s : s;
}
function mockComplete(text) {
  const t = text.replace(/\s+$/, '');
  const rules = [
    [/\bi wanted to$/i, ' follow up on'], [/\bplease let me know$/i, ' if you have any questions.'], [/\blet me know if$/i, ' that works for you.'],
    [/\bthank you for$/i, ' your time and consideration.'], [/\bthanks for$/i, ' your help with this.'], [/\blooking forward to$/i, ' hearing from you.'],
    [/\bi'?m writing to$/i, ' let you know about'], [/\bwould it be possible to$/i, ' schedule a quick call'], [/\bcould we$/i, ' find a time to talk'],
    [/\bi hope (you|this)\b[^.]*$/i, ' finds you well.'], [/^(hi|hello|hey)\b[^\n]{0,40},\s*$/i, 'I hope you are doing well.'],
  ];
  for (const [re, out] of rules) if (re.test(t)) return /\s$/.test(text) ? out.trimStart() : out;
  if (/[.!?]\s*$/.test(text) && /\s$/.test(text)) return ['Please let me know if you have any questions.', 'I appreciate your help with this.', 'Let me know what you think.'][text.length % 3];
  return text.length < 8 ? '' : [' as soon as possible.', ' when you have a moment.', ' and I will follow up.', ' if that works for you.'][text.length % 4];
}
async function completeAnthropic(cfg, text) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.LLM_AUTOCOMPLETE_MODEL || 'claude-haiku-5-5', max_tokens: 24, system: cfg.LLM_AUTOCOMPLETE_SYSTEM_PROMPT, messages: [{ role: 'user', content: text }] }),
  });
  const d = await r.json(); if (!r.ok) throw new Error((d.error && d.error.message) || 'autocomplete error');
  return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// ---- researcher access: loopback only, unless RESEARCHER_KEY is set (then ?key= or x-researcher-key) ----
function adminOK(req, u) {
  const key = process.env.RESEARCHER_KEY;
  if (key) return req.headers['x-researcher-key'] === key || u.searchParams.get('key') === key;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}
const validPid = p => /^[A-Za-z0-9_-]{1,40}$/.test(String(p || ''));
function fullSession(pid) {                                    // session.json, plus raw events for emails still in progress
  const sess = readJSON(sessionFile(pid));
  for (const em of sess.emails) if (em.status !== 'sent') em.events = readEvents(pid, em.index);
  return sess;
}
function adminSessions() {
  return fs.readdirSync(DATA_DIR).filter(d => fs.existsSync(path.join(DATA_DIR, d, 'session.json'))).sort().map(pid => {
    const s = readJSON(sessionFile(pid));
    return { pid, order: s.order, started_at: s.started_at, statuses: s.emails.map(e => e.status), sent_at: s.emails.map(e => e.sent_at || null) };
  });
}

// ---- http ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
function body(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 20e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const reply = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && !url.startsWith('/api/')) {
      const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
      const file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && url === '/api/time') return reply(res, 200, { now: Date.now() });
    if (req.method === 'GET' && url === '/api/config') return reply(res, 200, publicConfig());


    if (url.startsWith('/api/admin/')) {
      const u = new URL(req.url, 'http://x');
      if (!adminOK(req, u)) return reply(res, 401, { error: 'Researcher access only' });
      if (req.method === 'GET' && url === '/api/admin/sessions') return reply(res, 200, adminSessions());
      if (req.method === 'GET' && url === '/api/admin/session') {
        const pid = u.searchParams.get('pid'); if (!validPid(pid) || !fs.existsSync(sessionFile(pid))) return reply(res, 404, { error: 'No such session' });
        return reply(res, 200, fullSession(pid));
      }
      if (req.method === 'GET' && url === '/api/admin/export') {
        const pid = u.searchParams.get('pid'), type = u.searchParams.get('type') || 'json';
        const pids = pid === 'all' ? adminSessions().map(s => s.pid) : [pid];
        if (!pids.every(p => validPid(p) && fs.existsSync(sessionFile(p)))) return reply(res, 404, { error: 'No such session' });
        const sessions = pids.map(fullSession), cfg = config();
        const send = (body, mime, name) => { res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `attachment; filename="${name}"` }); res.end(body); };
        if (type === 'json') return send(JSON.stringify(pid === 'all' ? sessions : sessions[0], null, 2), 'application/json', `${pid}.session.json`);
        if (type === 'events') return send(Analysis.eventsCSV(sessions, cfg), 'text/csv', `${pid}.events.csv`);
        if (type === 'edits') return send(Analysis.editsCSV(sessions, cfg), 'text/csv', `${pid}.edits.csv`);
        const lines = [];
        for (const s of sessions) for (const em of s.emails) {
          if (type === 'chat') { lines.push(`=== ${s.pid} · email ${em.index} (${em.condition}) · AI chat ===`); for (const m of chatSummary(em.events || []).chat) lines.push(`[${new Date(m.t).toISOString()}] ${m.role === 'user' ? 'PARTICIPANT' : 'AI'}: ${m.text}\n`); }
          else if (type === 'emails') lines.push(`=== ${s.pid} · email ${em.index} (${em.condition}) ===\nTo: ${em.to || em.scenario.to}\nSubject: ${em.final_subject || ''}\n\n${em.final_text || '(not sent)'}\n`);
          else return reply(res, 400, { error: 'Unknown export type' });
        }
        return send(lines.join('\n'), 'text/plain; charset=utf-8', `${pid}.${type}.txt`);
      }
      if (req.method === 'POST' && url === '/api/admin/delete') {
        const b = await body(req);
        if (!validPid(b.pid) || b.confirm !== b.pid) return reply(res, 400, { error: 'Type the PID to confirm' });
        fs.rmSync(pidDir(b.pid), { recursive: true, force: true });
        return reply(res, 200, { deleted: b.pid, note: 'Also delete the interview recording for this PID.' });
      }
      return reply(res, 404, { error: 'Not found' });
    }

    if (req.method !== 'POST') return reply(res, 404, { error: 'Not found' });
    const b = await body(req);
    const row = findParticipant(b.pid);
    if (!row) return reply(res, 404, { error: 'Unknown participant ID' });
    const pid = row.pid;

    if (url === '/api/session/start') {
      const sess = loadOrCreateSession(row), idx = currentIndex(sess);
      const cur = sess.emails.find(e => e.index === idx);
      return reply(res, 200, {
        pid, currentIndex: idx,
        emails: sess.emails.map(({ index, condition, scenario, status }) => ({ index, condition, scenario, status })),
        events: cur && cur.status === 'in_progress' ? readEvents(pid, idx) : [],
      });
    }
    const sess = fs.existsSync(sessionFile(pid)) ? readJSON(sessionFile(pid)) : null;
    if (!sess) return reply(res, 409, { error: 'Session not started' });
    if (url === '/api/session/emails') {                         // the participant's own saved emails, for the log + comparison views
      const sent = fullSession(pid).emails.filter(e => e.status === 'sent');
      return reply(res, 200, { emails: sent });
    }
    const em = sess.emails.find(e => e.index === b.index);
    if (!em) return reply(res, 400, { error: 'Bad email index' });

    if (url === '/api/email/begin') {
      if (em.index !== currentIndex(sess)) return reply(res, 409, { error: 'Not the current email' });
      if (em.status === 'pending') { em.status = 'in_progress'; em.writing_started_at = Date.now(); writeAtomic(sessionFile(pid), sess); }
      return reply(res, 200, { status: em.status });
    }
    if (url === '/api/events') {
      if (em.status === 'sent') return reply(res, 409, { error: 'Already sent' });
      const lines = (b.events || []).map(e => JSON.stringify(e)).join('\n');
      if (lines) fs.appendFileSync(eventsFile(pid, em.index), lines + '\n');
      return reply(res, 200, { ok: true, n: (b.events || []).length });
    }
    if (url === '/api/autocomplete') {
      if (em.status !== 'in_progress') return reply(res, 409, { error: 'Email is not in progress' });
      const cfg = config(), mode = llmMode(cfg), text = String(b.text || '').slice(-4000);
      let raw = '';
      try { raw = mode === 'mock' ? mockComplete(text) : await completeAnthropic(cfg, text); } catch (e) { return reply(res, 200, { suggestion: '', error: String(e.message || e) }); }
      return reply(res, 200, { suggestion: cleanSuggestion(raw, text, cfg.AUTOCOMPLETE_MAX_WORDS || 6), model: mode === 'mock' ? 'mock-llm' : cfg.LLM_AUTOCOMPLETE_MODEL, mock: mode === 'mock' });
    }
    if (url === '/api/chat') {
      if (em.status !== 'in_progress') return reply(res, 409, { error: 'Email is not in progress' });
      const msgs = Array.isArray(b.messages) ? b.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-40) : [];
      if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return reply(res, 400, { error: 'Need a final user message' });
      const cfg = config(), mode = llmMode(cfg);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = o => { if (!res.destroyed) res.write(`data: ${JSON.stringify(o)}\n\n`); };
      send({ type: 'start', model: mode === 'mock' ? 'mock-llm' : cfg.LLM_MODEL, mock: mode === 'mock' });
      try { await (mode === 'mock' ? streamMock(msgs, send, res) : streamAnthropic(cfg, msgs, send, res)); send({ type: 'done' }); }
      catch (e) { send({ type: 'error', message: String(e.message || e) }); }
      return res.end();
    }
    if (url === '/api/send') {
      if (em.status !== 'in_progress') return reply(res, 409, { error: 'Email is not in progress' });
      const events = readEvents(pid, em.index);
      const replayed = Core.replay(events, { subject: em.scenario.subject });
      const ranges = b.char_labels || [];
      Object.assign(em, {
        status: 'sent', sent_at: Date.now(), to: b.to, final_subject: b.final_subject, final_text: b.final_text,
        char_labels: ranges, ...chatSummary(events), events,
        integrity: {
          replay_matches_final_text: replayed.body === b.final_text,
          replay_matches_final_subject: replayed.subject === b.final_subject,
          labels_cover_text: (ranges.length ? ranges[ranges.length - 1].end : 0) === b.final_text.length,
          event_count: events.length,
        },
      });
      writeAtomic(sessionFile(pid), sess);
      return reply(res, 200, { saved: true, sent_at: em.sent_at, integrity: em.integrity, nextIndex: currentIndex(sess) });
    }
    reply(res, 404, { error: 'Not found' });
  } catch (e) { if (!res.headersSent) reply(res, 500, { error: String(e.message || e) }); else res.end(); }
}).listen(PORT, () => {
  console.log(`Study app: http://localhost:${PORT}   (data in ${DATA_DIR})`);
  const m = llmMode(config());
  console.log(m === 'mock' ? 'Chat model: MOCK replies (no ANTHROPIC_API_KEY set)' : `Chat model: ${config().LLM_MODEL} via Anthropic API`);
});
