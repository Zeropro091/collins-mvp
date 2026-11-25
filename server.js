'use strict';
/* Collins MVP — auth + balance + API keys + gateway proxy to openagentic.
   Zero deps: node:http + node:sqlite. Plaintext passwords on purpose (MVP, local only). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PUB = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });   // fresh clone has no data/ (gitignored)
const db = new DatabaseSync(path.join(DATA, 'collins.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT, password TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS api_keys(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, key TEXT UNIQUE NOT NULL, label TEXT, created INTEGER, last_used INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, user_id INTEGER, key_id INTEGER, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER, cost REAL, source TEXT, created INTEGER);
`);

const now = () => Date.now();
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};
const readBody = req => new Promise((ok, bad) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 1e6) { bad(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(new Error('invalid JSON')); } });
  req.on('error', bad);
});

const userByToken = tok => tok ? db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(tok) : null;
const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
const pub = u => ({ id: u.id, username: u.username, email: u.email, balance: u.balance });

/* ---------- upstream ---------- */
function parseUpstream(raw) {
  const t = String(raw).trim();
  if (t.startsWith('{')) {
    const cut = t.indexOf('data: [DONE]');
    try { return JSON.parse(cut > 0 ? t.slice(0, cut).trim() : t); } catch { /* SSE below */ }
  }
  let content = '', usage = null, id = '', model = '';
  for (const line of t.split(/\r?\n/)) {
    const m = /^data:\s*(.*)$/.exec(line);
    if (!m || m[1] === '[DONE]') continue;
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    id = j.id || id; model = j.model || model;
    const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
    if (d) content += d;
    if (j.usage) usage = j.usage;
  }
  return { id, model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage };
}

async function callUpstream(model, messages, extra = {}) {
  const r = await fetch(CFG.upstream + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CFG.upstreamKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, ...extra }),
    signal: AbortSignal.timeout(60000)   // upstream can hang on capacity retries
  });
  const raw = await r.text();
  return { status: r.status, body: parseUpstream(raw) };
}

/* SSE passthrough: forward upstream chunks verbatim, capture the trailing usage. */
async function streamUpstream(model, messages, extra, res) {
  const r = await fetch(CFG.upstream + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CFG.upstreamKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, ...extra, stream: true, stream_options: { include_usage: true } }),
    signal: AbortSignal.timeout(180000)
  });
  if (r.status !== 200) {
    const raw = await r.text();
    return { code: r.status, error: String((parseUpstream(raw).error || {}).message || raw).slice(0, 400) };
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const dec = new TextDecoder();
  let buf = '', usage = null;
  const scan = line => {
    const m = /^data:\s*(.+)$/.exec(line.trim());
    if (!m || m[1] === '[DONE]') return;
    try { const j = JSON.parse(m[1]); if (j.usage) usage = j.usage; } catch { /* partial line */ }
  };
  for await (const chunk of r.body) {
    res.write(chunk);
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach(scan);
  }
  scan(buf);            // final usage chunk usually has no trailing newline
  res.end();
  return { streamed: true, usage };
}

/* ---------- auth ---------- */
function register(body) {
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const email = String(body.email || '').trim();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) return { code: 400, error: 'Username 3-32 karakter, huruf/angka/underscore.' };
  if (password.length < 4) return { code: 400, error: 'Password minimal 4 karakter.' };
  if (password !== String(body.password2 || '')) return { code: 400, error: 'Password dan konfirmasi tidak sama.' };
  if (!/^\S+@\S+\.\S+$/.test(email)) return { code: 400, error: 'Email tidak valid.' };
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return { code: 409, error: 'Username sudah dipakai.' };
  const starter = CFG.starterTokens || 0;
  db.prepare('INSERT INTO users(username,email,password,balance,created) VALUES(?,?,?,?,?)').run(username, email, password, starter, now());
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (starter) db.prepare('INSERT INTO usage(user_id,model,prompt_tokens,completion_tokens,total_tokens,cost,source,created) VALUES(?,?,?,?,?,?,?,?)').run(u.id, 'starter-credit', 0, 0, -starter, 0, 'grant', now());
  return { user: u, token: newSession(u.id) };
}
const newSession = uid => { const t = crypto.randomBytes(24).toString('hex'); db.prepare('INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)').run(t, uid, now()); return t; };

/* ---------- metering ---------- */
function meter(u, model, usage, source, keyId) {
  const p = Number((usage && usage.prompt_tokens) || 0);
  const c = Number((usage && usage.completion_tokens) || 0);
  const tot = Number((usage && usage.total_tokens) || p + c);
  const cost = Number((usage && usage.cost) || 0);
  db.prepare('INSERT INTO usage(user_id,key_id,model,prompt_tokens,completion_tokens,total_tokens,cost,source,created) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(u.id, keyId || null, model, p, c, tot, cost, source, now());
  if (tot) db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(tot, u.id);
  return { prompt_tokens: p, completion_tokens: c, total_tokens: tot, cost };
}

/* ---------- routes ---------- */
const routes = {
  'POST /api/auth/register': async ({ body }) => {
    const r = register(body);
    return r.error ? r : { body: { token: r.token, user: pub(r.user) } };
  },
  'POST /api/auth/login': async ({ body }) => {
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(body.username || '').trim().toLowerCase());
    if (!u || u.password !== String(body.password || '')) return { code: 401, error: 'Username atau password salah.' };
    return { body: { token: newSession(u.id), user: pub(u) } };
  },
  'POST /api/auth/logout': async ({ user, token }) => {
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return { body: { ok: true } };
  },
  'GET /api/me': async ({ user }) => ({ body: pub(user) }),
  'GET /api/keys': async ({ user }) => ({
    body: {
      base_url: CFG.publicBaseUrl + '/api/v1',
      models: CFG.models,
      keys: db.prepare('SELECT id,key,label,created,last_used,revoked FROM api_keys WHERE user_id = ? ORDER BY id DESC').all(user.id)
    }
  }),
  'POST /api/keys': async ({ user, body }) => {
    const key = 'collins_live_' + crypto.randomBytes(20).toString('hex');
    db.prepare('INSERT INTO api_keys(user_id,key,label,created) VALUES(?,?,?,?)').run(user.id, key, String(body.label || 'default').slice(0, 40), now());
    return { body: { key, base_url: CFG.publicBaseUrl + '/api/v1' } };
  },
  'DELETE /api/keys': async ({ user, query }) => {
    db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?').run(Number(query.id), user.id);
    return { body: { ok: true } };
  },
  'POST /api/credit/convert': async ({ user, body }) => {
    const rp = Math.floor(Number(body.rp || 0));
    if (!(rp > 0)) return { code: 400, error: 'rp harus > 0' };
    if (rp > (CFG.maxConvertRp || 100000)) return { code: 400, error: 'Maksimal Rp' + (CFG.maxConvertRp || 100000) + ' per convert.' };
    const tokens = rp * (CFG.tokensPerRp || 5000);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(tokens, user.id);
    db.prepare('INSERT INTO usage(user_id,model,prompt_tokens,completion_tokens,total_tokens,cost,source,created) VALUES(?,?,?,?,?,?,?,?)').run(user.id, 'ads-convert', 0, 0, -tokens, 0, 'grant', now());
    return { body: { tokens, rp, balance: db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id).balance } };
  },
  'GET /api/usage': async ({ user }) => ({
    body: {
      balance: user.balance,
      recent: db.prepare("SELECT model,prompt_tokens,completion_tokens,total_tokens,cost,source,created FROM usage WHERE user_id = ? AND source = 'chat' ORDER BY id DESC LIMIT 50").all(user.id),
      totals: db.prepare("SELECT COUNT(*) runs, COALESCE(SUM(prompt_tokens),0) pt, COALESCE(SUM(completion_tokens),0) ct, COALESCE(SUM(total_tokens),0) tt, COALESCE(SUM(cost),0) cost FROM usage WHERE user_id = ? AND source = 'chat'").get(user.id)
    }
  }),

  /* session-auth chat for the workstation UI */
  'POST /api/chat': async ({ user, body }) => {
    if (user.balance <= 0) return { code: 402, error: 'Balance habis — tonton iklan lalu Convert ke token.' };
    const model = String(body.model || CFG.models[0]);
    if (!CFG.models.includes(model)) return { code: 400, error: 'Model tidak tersedia: ' + model };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return { code: 400, error: 'messages kosong' };
    const up = await callUpstream(model, messages, { max_tokens: 1200 });
    if (up.status !== 200 || up.body.error) {
      const msg = (up.body.error && (up.body.error.message || up.body.error)) || ('upstream HTTP ' + up.status);
      return { code: 502, error: String(msg).slice(0, 400) };
    }
    const usage = meter(user, model, up.body.usage, 'chat');
    const content = (up.body.choices && up.body.choices[0] && up.body.choices[0].message && up.body.choices[0].message.content) || '';
    return { body: { content, usage, model, balance: db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id).balance } };
  },

  /* OpenAI-compatible public API — authenticated by Collins API key */
  'GET /api/v1/models': async ({ keyUser }) => ({
    body: { object: 'list', data: CFG.models.map(m => ({ id: m, object: 'model', created: 0, owned_by: 'collins' })) }
  }),
  'POST /api/v1/chat/completions': async ({ keyUser, keyRow, body, res }) => {
    const model = String(body.model || '');
    if (!CFG.models.includes(model)) return { code: 404, error: 'model_not_found: ' + model };
    if (!Array.isArray(body.messages) || !body.messages.length) return { code: 400, error: 'messages kosong' };
    if (keyUser.balance <= 0) return { code: 402, error: 'insufficient_quota: balance habis' };
    const extra = {};
    ['temperature', 'top_p', 'max_tokens', 'stop'].forEach(k => { if (body[k] !== undefined) extra[k] = body[k]; });

    if (body.stream) {
      const s = await streamUpstream(model, body.messages, extra, res);
      if (s.error) return { code: s.code || 502, error: s.error };
      meter(keyUser, model, s.usage, 'chat', keyRow.id);
      db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').run(now(), keyRow.id);
      return { streamed: true };
    }

    const up = await callUpstream(model, body.messages, extra);
    if (up.status !== 200 || up.body.error) {
      const msg = (up.body.error && (up.body.error.message || up.body.error)) || ('upstream HTTP ' + up.status);
      return { code: 502, error: String(msg).slice(0, 400) };
    }
    const usage = meter(keyUser, model, up.body.usage, 'chat', keyRow.id);
    db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').run(now(), keyRow.id);
    return { body: { ...up.body, model, usage: { ...up.body.usage, ...usage } } };
  }
};

/* ---------- static ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams);

  if (pathname.startsWith('/api/v1/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const route = routes[req.method + ' ' + pathname];
  if (!route) return json(res, 404, { error: 'not found' });

  try {
    const token = bearer(req);
    const ctx = { req, res, query, token, body: {} };
    const isV1 = pathname.startsWith('/api/v1/');
    const fail = (code, msg) => isV1
      ? json(res, code, { error: { message: String(msg), type: code === 401 ? 'authentication_error' : 'invalid_request_error', code } })
      : json(res, code, { error: msg });
    if (isV1) {
      const row = db.prepare('SELECT * FROM api_keys WHERE key = ? AND revoked = 0').get(token);
      if (!row) return fail(401, 'invalid_api_key');
      ctx.keyRow = row;
      ctx.keyUser = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    } else if (pathname !== '/api/auth/register' && pathname !== '/api/auth/login') {
      const u = userByToken(token);
      if (!u) return fail(401, 'unauthorized');
      ctx.user = u;
    }
    if (req.method !== 'GET' && req.method !== 'DELETE') ctx.body = await readBody(req);
    const out = await route(ctx);
    if (out.streamed) return;                       // SSE already flushed to the client
    if (out.error) return fail(out.code || 400, out.error);
    return json(res, 200, out.body);
  } catch (e) {
    console.error(e);
    if (res.headersSent) return res.end();
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(CFG.port, '127.0.0.1', () => console.log(`Collins MVP → http://localhost:${CFG.port}`));
