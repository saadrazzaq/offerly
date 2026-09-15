// Offerly local bridge — routes the web page through your Claude Code license
// (uses the bundled `claude` binary headless, billed to your subscription — no API key/credits),
// fetches job pages, and sends application emails over your own SMTP account.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 8787;
const HERE = __dirname;
const MAIL_CFG = path.join(HERE, 'offerly.mail.json'); // gitignored — holds your SMTP app password

// Pages allowed to use the sensitive endpoints (send email, fetch URLs, read screenshots).
// Add a hosted origin with:  OFFERLY_ALLOWED_ORIGINS="https://your-app.vercel.app" node bridge.js
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
  ...(process.env.OFFERLY_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
]);
// Requests with no Origin come from local tools (curl etc.), not from websites.
const trustedOrigin = req => !req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin);

// --- locate the Claude Code binary ----------------------------------------
function findClaude() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const ext = path.join(process.env.USERPROFILE || process.env.HOME || '', '.vscode', 'extensions');
  try {
    const dirs = fs.readdirSync(ext)
      .filter(d => d.startsWith('anthropic.claude-code-'))
      .sort().reverse(); // newest version first
    for (const d of dirs) {
      for (const bin of ['claude.exe', 'claude']) {
        const p = path.join(ext, d, 'resources', 'native-binary', bin);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) {}
  return null;
}
const CLAUDE = findClaude();
if (!CLAUDE) {
  console.error('\n[!] Could not find the Claude Code binary. Set CLAUDE_BIN env var to claude.exe path.\n');
}

const MODELS = {
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-8': 'claude-opus-4-8',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
};

// --- run one headless prompt ----------------------------------------------
// opts.workDir: lets Claude open files (screenshots) in that folder with its Read tool.
function runClaude(prompt, model, opts = {}) {
  return new Promise((resolve, reject) => {
    const m = MODELS[model] || 'claude-sonnet-4-6';
    const args = ['-p', '--model', m, '--output-format', 'text'];
    const spawnOpts = { windowsHide: true };
    if (opts.workDir) {
      args.push('--allowedTools', 'Read', '--add-dir', opts.workDir);
      spawnOpts.cwd = opts.workDir;
    }
    const child = spawn(CLAUDE, args, spawnOpts);
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude timed out (240s).')); }, 240000);
    child.stdout.on('data', d => out += d.toString('utf8'));
    child.stderr.on('data', d => err += d.toString('utf8'));
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) return resolve(out.trim());
      reject(new Error(err.trim() || ('Claude exited with code ' + code)));
    });
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

// Save base64 images to a private temp folder, run Claude on them, then clean up.
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
async function runClaudeWithImages(prompt, model, images) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerly-'));
  try {
    const files = images.map((img, i) => {
      const ext = IMG_EXT[img.mediaType];
      if (!ext) throw new Error('Unsupported image type: ' + img.mediaType + '. Use PNG, JPG, WEBP or GIF.');
      const file = path.join(dir, `screenshot-${i + 1}.${ext}`);
      fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
      return file;
    });
    const full = prompt.replace(/\{\{IMAGES\}\}/g, files.join('\n'));
    return await runClaude(full, model, { workDir: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- job page fetching ------------------------------------------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/^\s*•?\s*$/gm, '')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function isPrivateHost(h) {
  return /^(localhost|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i.test(h)
    || h.endsWith('.local') || h.endsWith('.internal');
}
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;

async function fetchJobPage(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('That is not a valid link.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links are supported.');
  if (isPrivateHost(u.hostname)) throw new Error('Links to local or private network addresses are not allowed.');
  let r;
  try {
    r = await fetch(u, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
  } catch (e) {
    throw new Error('Could not open the link (' + (e.cause?.code || e.name || e.message) + '). Paste the job text or a screenshot instead.');
  }
  if (!r.ok) throw new Error(`The job site returned HTTP ${r.status}. Paste the job text or a screenshot instead.`);
  const html = (await r.text()).slice(0, 3_000_000);
  const jsonLd = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).filter(s => /JobPosting/i.test(s)).join('\n').slice(0, 15000);
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const emails = [...new Set((decodeEntities(html).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
    .map(e => e.toLowerCase())
    .filter(e => !/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e) && !/(sentry|wixpress|example\.|domain\.com|email\.com)/.test(e)))]
    .slice(0, 10);
  const text = htmlToText(html).slice(0, 20000);
  if (text.length < 200 && !jsonLd) {
    throw new Error('This page needs a login or JavaScript to show the job (common on LinkedIn). Paste the job text or a screenshot instead.');
  }
  return { url: r.url, title, text, jsonLd, emails };
}

// --- email -----------------------------------------------------------------
function loadMailCfg() {
  try { return JSON.parse(fs.readFileSync(MAIL_CFG, 'utf8')); } catch { return null; }
}
function saveMailCfg(cfg) {
  fs.writeFileSync(MAIL_CFG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
function publicMailCfg(cfg) {
  if (!cfg) return { configured: false };
  const { pass, ...rest } = cfg;
  return { ...rest, hasPassword: !!pass, configured: !!(cfg.host && cfg.user && pass) };
}
function mailer(cfg) {
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch { throw new Error('Sending email needs the nodemailer package. In the project folder run:  npm install'); }
  const port = Number(cfg.port) || 587;
  return nodemailer.createTransport({
    host: cfg.host, port, secure: port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
}
function parseRecipients(to) {
  const list = String(to || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  if (!list.length) throw new Error('Add a recipient email address.');
  const bad = list.filter(a => !EMAIL_RE.test(a));
  if (bad.length) throw new Error('Not a valid email address: ' + bad.join(', '));
  if (list.length > 10) throw new Error('Too many recipients (max 10).');
  return list;
}
async function sendApplication({ to, cc, subject, body, attachment }) {
  const cfg = loadMailCfg();
  if (!cfg || !cfg.host || !cfg.user || !cfg.pass) throw new Error('Email sending is not set up yet. Open “Email setup” first.');
  const recipients = parseRecipients(to);
  if (!String(subject || '').trim()) throw new Error('Add a subject line.');
  if (String(body || '').trim().length < 20) throw new Error('The email body is empty.');
  const fromAddr = cfg.fromEmail || cfg.user;
  const fromName = String(cfg.fromName || '').replace(/["<>\r\n]/g, '').trim();
  const mail = {
    from: fromName ? `"${fromName}" <${fromAddr}>` : fromAddr,
    to: recipients.join(', '),
    subject: String(subject).replace(/[\r\n]+/g, ' ').trim(),
    text: String(body),
  };
  if (cc) mail.cc = parseRecipients(cc).join(', ');
  if (cfg.bccSelf) mail.bcc = fromAddr;
  if (attachment && attachment.data) {
    mail.attachments = [{
      filename: path.basename(String(attachment.filename || 'Resume.pdf')),
      content: Buffer.from(attachment.data, 'base64'),
      contentType: attachment.contentType || undefined,
    }];
  }
  const info = await mailer(cfg).sendMail(mail);
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

// --- helpers ---------------------------------------------------------------
function readJSON(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '', size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large.')); req.destroy(); return; }
      body += c;
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON.')); } });
    req.on('error', reject);
  });
}
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function servePage(res, file) {
  fs.readFile(path.join(HERE, file), (e, data) => {
    if (e) { res.writeHead(500); return res.end(file + ' not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}
function logResponse(model, prompt, text) {
  try {
    fs.appendFileSync(path.join(HERE, 'offerly.log'),
      `\n\n===== ${new Date().toISOString()} model=${model} len=${text.length} prompt="${prompt.slice(0, 70).replace(/\n/g, ' ')}" =====\n${text}\n`);
  } catch (_) {}
}

// Sensitive routes: only callable from your own Offerly pages.
const PROTECTED = new Set(['/api/fetch-url', '/api/send-email', '/api/mail-config', '/api/mail-test']);

// --- server ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  // CORS — allow the page to call this bridge whether it's opened locally (file://,
  // http://localhost) or from a hosted HTTPS origin (e.g. the Vercel deployment).
  const origin = req.headers.origin;
  const allowOrigin = PROTECTED.has(url) ? (origin && ALLOWED_ORIGINS.has(origin) ? origin : `http://localhost:${PORT}`) : '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  // Private Network Access: a public HTTPS page (Vercel) calling http://localhost is a
  // public→private request; Chrome/Edge require this header on the preflight or it's blocked.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (PROTECTED.has(url) && !trustedOrigin(req)) {
    return sendJSON(res, 403, { error: `Blocked request from ${origin}. Open Offerly from http://localhost:${PORT}/apply, or add this site to OFFERLY_ALLOWED_ORIGINS.` });
  }

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) return servePage(res, 'index.html');
  if (req.method === 'GET' && (url === '/apply' || url === '/apply.html')) return servePage(res, 'apply.html');

  if (req.method === 'GET' && url === '/health') {
    return sendJSON(res, 200, { ok: !!CLAUDE, claude: CLAUDE || null });
  }

  try {
    if (req.method === 'POST' && url === '/api') {
      if (!CLAUDE) throw new Error('Claude Code binary not found on this machine.');
      // Screenshots are only accepted from trusted pages.
      const { prompt, model, images } = await readJSON(req, 30e6);
      if (!prompt) throw new Error('Missing prompt.');
      let text;
      if (Array.isArray(images) && images.length) {
        if (!trustedOrigin(req)) return sendJSON(res, 403, { error: 'Screenshots can only be sent from your local Offerly page.' });
        if (images.length > 5) throw new Error('Up to 5 screenshots per job.');
        text = await runClaudeWithImages(prompt, model, images);
      } else {
        text = await runClaude(prompt, model);
      }
      logResponse(model, prompt, text);
      return sendJSON(res, 200, { text });
    }

    if (req.method === 'POST' && url === '/api/fetch-url') {
      const { url: target } = await readJSON(req, 1e5);
      return sendJSON(res, 200, await fetchJobPage(target));
    }

    if (url === '/api/mail-config') {
      if (req.method === 'GET') return sendJSON(res, 200, publicMailCfg(loadMailCfg()));
      if (req.method === 'POST') {
        const b = await readJSON(req, 1e5);
        const prev = loadMailCfg() || {};
        const cfg = {
          host: String(b.host || '').trim(),
          port: Number(b.port) || 587,
          user: String(b.user || '').trim(),
          pass: b.pass ? String(b.pass).replace(/\s+/g, '') : prev.pass || '', // blank = keep saved password
          fromName: String(b.fromName || '').trim(),
          fromEmail: String(b.fromEmail || '').trim(),
          bccSelf: !!b.bccSelf,
        };
        if (!cfg.host || !cfg.user) throw new Error('SMTP server and username are required.');
        if (cfg.fromEmail && !EMAIL_RE.test(cfg.fromEmail)) throw new Error('“From” address is not a valid email.');
        saveMailCfg(cfg);
        return sendJSON(res, 200, publicMailCfg(cfg));
      }
    }

    if (req.method === 'POST' && url === '/api/mail-test') {
      const cfg = loadMailCfg();
      if (!cfg || !cfg.pass) throw new Error('Save your email settings first.');
      await mailer(cfg).verify();
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url === '/api/send-email') {
      const b = await readJSON(req, 30e6);
      const result = await sendApplication(b);
      console.log(`  ✉  sent "${String(b.subject).slice(0, 60)}" → ${b.to}`);
      return sendJSON(res, 200, { ok: true, ...result });
    }
  } catch (e) {
    return sendJSON(res, 500, { error: e.message || String(e) });
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n  Offerly bridge running');
  console.log('  → job finder   http://localhost:' + PORT + '/');
  console.log('  → bulk apply   http://localhost:' + PORT + '/apply');
  console.log('  → using ' + (CLAUDE || 'NO CLAUDE BINARY FOUND'));
  console.log('  → email ' + (publicMailCfg(loadMailCfg()).configured ? 'ready (' + loadMailCfg().user + ')' : 'not set up yet'));
  console.log('  (billed to your Claude Code subscription — no API key needed)\n');
});
