// Zero-dependency server (Node 18+). Run: ANTHROPIC_API_KEY=sk-... node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// PROVIDER=anthropic (default) or openai (any OpenAI-compatible API; set LLM_BASE_URL + LLM_API_KEY)
const PROVIDER = (process.env.PROVIDER || 'anthropic').toLowerCase();
const MODEL = process.env.MODEL || (PROVIDER === 'openai' ? 'gpt-4o' : 'claude-sonnet-5-5');
// Small, fast model for autocomplete suggestions in the email body
const AC_MODEL = process.env.AC_MODEL || (PROVIDER === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-5-5');
const CHAT_SYSTEM_PROMPT = process.env.CHAT_SYSTEM_PROMPT || '';
const AC_SYSTEM_PROMPT = process.env.AC_SYSTEM_PROMPT ||
  'You are an email autocomplete engine like Gmail Smart Compose. You are given an email draft. ' +
  'Predict the next 1 to 5 words the writer is most likely to type, continuing exactly where the draft ends. ' +
  'Reply with only those words: no quotes, no explanation, and do not repeat any of the draft. ' +
  'If you cannot make a confident prediction, reply with nothing.';

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// One call to the configured provider; returns the reply text.
async function callLLM({ model, system, messages, maxTokens }) {
  if (PROVIDER === 'openai') {
    // Any OpenAI-compatible API: OpenAI, Gemini, OpenRouter, Groq, Ollama, ...
    const headers = { 'content-type': 'application/json' };
    if (process.env.LLM_API_KEY) headers.authorization = `Bearer ${process.env.LLM_API_KEY}`;
    const base = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: system ? [{ role: 'system', content: system }, ...messages] : messages }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(r.status, data.error?.message || `API error (${r.status})`);
    return data.choices?.[0]?.message?.content || '';
  }
  if (!process.env.ANTHROPIC_API_KEY) throw httpError(500, 'ANTHROPIC_API_KEY is not set on the server.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages, ...(system ? { system } : {}) }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(r.status, data.error?.message || `API error (${r.status})`);
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => {
      d += c;
      if (d.length > 25e6) { reject(httpError(413, 'Request too large')); req.destroy(); }
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
const safe = s => String(s || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'anon';

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (req.method === 'GET' && req.url === '/scenarios.json') {
      // read on every request so edits to the file show up without restarting the server
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'scenarios.json')));
    }
    if (req.method === 'POST' && req.url === '/api/log') {
      const { pid, events } = JSON.parse(await readBody(req));
      const lines = (events || []).map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFileSync(path.join(LOG_DIR, `${safe(pid)}.jsonl`), lines);
      res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && req.url === '/api/submit') {
      // Written once when the participant clicks Send, into logs/<PID>/:
      //   <PID>-<session>-session.json  master record (everything)
      //   <PID>-<session>-report.html   readable report, opens in any browser
      //   <PID>-<session>-edits.csv     one row per revision, for coding/counting
      //   <PID>-<session>-events.csv    one row per raw event
      const body = JSON.parse(await readBody(req));
      const pid = safe(body.pid), base = `${pid}-${safe(body.sid)}`;
      const dir = path.join(LOG_DIR, pid);
      fs.mkdirSync(dir, { recursive: true });
      const files = { [`${base}-session.json`]: JSON.stringify({ ...body.session, savedAt: Date.now() }, null, 2) };
      if (typeof body.report === 'string') files[`${base}-report.html`] = body.report;
      if (typeof body.edits_csv === 'string') files[`${base}-edits.csv`] = body.edits_csv;
      if (typeof body.events_csv === 'string') files[`${base}-events.csv`] = body.events_csv;
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ saved: `logs/${pid}/`, files: Object.keys(files) }));
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      const { messages } = JSON.parse(await readBody(req));
      const text = await callLLM({ model: MODEL, system: CHAT_SYSTEM_PROMPT, messages, maxTokens: 2048 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ text, model: MODEL }));
    }
    if (req.method === 'POST' && req.url === '/api/complete') {
      // Autocomplete: next few words for the email body (only the draft so far is sent, never the chat)
      const { subject, body } = JSON.parse(await readBody(req));
      const draft = `Subject: ${String(subject || '').slice(0, 300)}\n\n${String(body || '').slice(-4000)}`;
      const text = await callLLM({ model: AC_MODEL, system: AC_SYSTEM_PROMPT, messages: [{ role: 'user', content: draft }], maxTokens: 20 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ text, model: AC_MODEL }));
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, () => console.log(`Open http://localhost:${PORT}/?pid=P01   (provider: ${PROVIDER}, chat model: ${MODEL}, autocomplete model: ${AC_MODEL})`));
