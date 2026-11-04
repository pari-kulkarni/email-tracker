// Zero-dependency server (Node 18+). Run: ANTHROPIC_API_KEY=sk-... node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 5e6) req.destroy(); });
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
    if (req.method === 'POST' && req.url === '/api/log') {
      const { pid, events } = JSON.parse(await readBody(req));
      const lines = (events || []).map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFileSync(path.join(LOG_DIR, `${safe(pid)}.jsonl`), lines);
      res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && req.url === '/api/submit') {
      // Consolidated record written once when the participant clicks Send.
      const body = JSON.parse(await readBody(req));
      const file = `${safe(body.pid)}-${safe(body.sid)}.submission.json`;
      fs.writeFileSync(path.join(LOG_DIR, file), JSON.stringify({ ...body, savedAt: Date.now() }, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ saved: file }));
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      if (!process.env.ANTHROPIC_API_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set on the server.' }));
      }
      const { messages } = JSON.parse(await readBody(req));
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 2048, messages }),
      });
      const data = await r.json();
      if (!r.ok) {
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: data.error?.message || 'API error' }));
      }
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ text, model: MODEL }));
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, () => console.log(`Open http://localhost:${PORT}/?pid=P01   (model: ${MODEL})`));
