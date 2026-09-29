// Offerly routes — shared by the local bridge (bridge.js) and the serverless
// functions used when Offerly is deployed to Vercel (api/).
//
// The same handler covers both because the only real difference is which engine is
// reachable: locally that is an agent CLI billed to your own subscription, on Vercel
// it is whichever API key is set in the project's environment variables.
const fs = require('fs');
const path = require('path');
const engines = require('./engines');
const jobfeeds = require('./jobfeeds');

let VERSION = '';
try { VERSION = require('./package.json').version; } catch (_) {}

const PORT = Number(process.env.PORT) || 8787;
const HERE = __dirname;
const HOSTED = !!process.env.VERCEL; // running as a Vercel function, not as the local bridge
const MAIL_CFG = path.join(HERE, 'offerly.mail.json'); // gitignored — holds your SMTP app password

// Pages allowed to use the sensitive endpoints (send email, fetch URLs, read screenshots).
// Add a hosted origin with:  OFFERLY_ALLOWED_ORIGINS="https://your-app.vercel.app" node bridge.js
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
  ...[process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
    .filter(Boolean).map(h => 'https://' + h),
  ...(process.env.OFFERLY_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
]);
// A page served by this same deployment is always trusted — that covers custom domains
// and preview URLs without having to list them.
function sameOrigin(req) {
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
// Requests with no Origin come from local tools (curl etc.), not from websites.
const trustedOrigin = req => !req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin) || sameOrigin(req);

// --- AI engines -------------------------------------------------------------
// Everything about *which* agent runs the prompt lives in engines.js.
const available = () => engines.listEngines().filter(e => e.available);

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
// A Vercel deployment has no writable disk, so there the SMTP login comes from the
// project's environment variables instead of offerly.mail.json.
const ENV_MAIL = process.env.OFFERLY_SMTP_HOST ? {
  host: process.env.OFFERLY_SMTP_HOST,
  port: Number(process.env.OFFERLY_SMTP_PORT) || 587,
  user: process.env.OFFERLY_SMTP_USER || '',
  pass: process.env.OFFERLY_SMTP_PASS || '',
  fromName: process.env.OFFERLY_SMTP_FROM_NAME || '',
  fromEmail: process.env.OFFERLY_SMTP_FROM || '',
  bccSelf: process.env.OFFERLY_SMTP_BCC_SELF === '1',
} : null;

function loadMailCfg() {
  if (ENV_MAIL) return ENV_MAIL;
  // A deployed image could carry a developer's own offerly.mail.json. Never use it:
  // on a hosted backend the only trusted source is the environment.
  if (HOSTED) return null;
  try { return JSON.parse(fs.readFileSync(MAIL_CFG, 'utf8')); } catch { return null; }
}
function saveMailCfg(cfg) {
  if (ENV_MAIL) throw new Error('Email is set by environment variables on this deployment. Change OFFERLY_SMTP_* in your hosting project settings.');
  if (HOSTED) throw new Error('This deployment cannot store an email login — its disk is wiped between requests. Reload the page and save again: your login is then kept in your own browser and sent with your own messages. To have the deployment send for everyone instead, set OFFERLY_SMTP_HOST, OFFERLY_SMTP_PORT, OFFERLY_SMTP_USER and OFFERLY_SMTP_PASS in the hosting project.');
  fs.writeFileSync(MAIL_CFG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
function publicMailCfg(cfg) {
  const editable = !ENV_MAIL && !HOSTED; // false = the page must keep its own copy
  if (!cfg) return { configured: false, editable };
  const { pass, ...rest } = cfg;
  return { ...rest, hasPassword: !!pass, editable, configured: !!(cfg.host && cfg.user && pass) };
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
// A hosted copy has nowhere to store an SMTP login, so the page may carry its own.
// Only our own pages can pass one (see PROTECTED), and it is never written to disk.
function mailFrom(override) {
  if (override && override.host && override.user && override.pass) {
    return {
      host: String(override.host).trim(),
      port: Number(override.port) || 587,
      user: String(override.user).trim(),
      pass: String(override.pass).replace(/\s+/g, ''),
      fromName: String(override.fromName || '').trim(),
      fromEmail: String(override.fromEmail || '').trim(),
      bccSelf: !!override.bccSelf,
    };
  }
  return loadMailCfg();
}

async function sendApplication({ to, cc, subject, body, attachment, mail: creds }) {
  const cfg = mailFrom(creds);
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
  // Vercel's Node runtime parses JSON bodies before the function runs, so the stream
  // is already drained by the time we get here.
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    if (typeof req.body !== 'string') return Promise.resolve(req.body);
    try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.reject(new Error('Invalid JSON.')); }
  }
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
// The pages are the app: served with no-store so a reload always picks up the
// current build. Without this a browser caches the HTML heuristically and an
// update appears to have changed nothing.
function servePage(res, file) {
  fs.readFile(path.join(HERE, file), (e, data) => {
    if (e) { res.writeHead(500); return res.end(file + ' not found'); }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, must-revalidate',
    });
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
const PROTECTED = new Set(['/api/fetch-url', '/api/send-email', '/api/mail-config', '/api/mail-test',
  '/api/engine-config', '/api/engine-connect', '/api/engine-forget', '/api/engine-login', '/api/engine-auth', '/api/jobs']);
// A hosted deployment may hold the owner's API key, so its AI endpoint must not be
// callable from other websites. The local bridge deliberately stays open: that is how
// a page hosted elsewhere reaches the agent on your machine.
if (HOSTED) PROTECTED.add('/api');

// --- routes ----------------------------------------------------------------
async function handle(req, res) {
  // Vercel rewrites /health onto the function, so accept it under /api too.
  const url = (req.url || '').split('?')[0].replace(/^\/api\/health$/, '/health').replace(/(.)\/+$/, '$1');

  // CORS — allow the page to call this bridge whether it's opened locally (file://,
  // http://localhost) or from a hosted HTTPS origin (e.g. the Vercel deployment).
  const origin = req.headers.origin;
  const allowOrigin = PROTECTED.has(url) ? (origin && trustedOrigin(req) ? origin : `http://localhost:${PORT}`) : '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  // Private Network Access: a public HTTPS page (Vercel) calling http://localhost is a
  // public→private request; Chrome/Edge require this header on the preflight or it's blocked.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (PROTECTED.has(url) && !trustedOrigin(req)) {
    return sendJSON(res, 403, { error: HOSTED
      ? `Blocked request from ${origin}. This endpoint only answers pages served by this deployment.`
      : `Blocked request from ${origin}. Open Offerly from http://localhost:${PORT}/apply, or add this site to OFFERLY_ALLOWED_ORIGINS.` });
  }

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) return servePage(res, 'index.html');
  if (req.method === 'GET' && (url === '/apply' || url === '/apply.html')) return servePage(res, 'apply.html');

  // /health tells the page whether anything can run; /api/engines fills the picker.
  // Stored secrets are never included — a field only reports that one is set.
  if (req.method === 'GET' && (url === '/health' || url === '/api/engines')) {
    const list = engines.listEngines();
    return sendJSON(res, 200, {
      ok: list.some(e => e.available),
      engines: list,
      defaultEngine: engines.defaultEngine(),
      // Where to point the picker when nothing is connected yet: on a hosted copy
      // that is the first engine a visitor could enable with a key of their own.
      suggested: engines.defaultEngine() || (list.find(e => e.kind === 'api' && !e.blocked) || {}).id || null,
      hosted: engines.SERVERLESS,
      version: VERSION,
      canSave: !engines.SERVERLESS, // a serverless deployment has no writable disk
    });
  }

  try {
    // Save what you typed in ⚙ Engine (API key, base URL, binary path, command).
    if (req.method === 'POST' && url === '/api/engine-config') {
      const { engine, values } = await readJSON(req, 1e5);
      if (!engine) throw new Error('Missing engine.');
      return sendJSON(res, 200, engines.saveConfig(engine, values || {}));
    }

    // Forget everything stored for one engine.
    if (req.method === 'POST' && url === '/api/engine-forget') {
      const { engine } = await readJSON(req, 1e5);
      if (!engine) throw new Error('Missing engine.');
      return sendJSON(res, 200, engines.forgetConfig(engine));
    }

    // Who is signed in to a CLI, asked of the CLI itself. Cheap, so the page can
    // show it without spending a model request.
    if (req.method === 'POST' && url === '/api/engine-auth') {
      const { engine } = await readJSON(req, 1e5);
      if (!engine) throw new Error('Missing engine.');
      return sendJSON(res, 200, { status: await engines.authStatus(engine) });
    }

    // Open the provider's own sign-in. No provider lets a third-party page run on a
    // consumer subscription, so the only honest route is their official CLI's flow.
    if (req.method === 'POST' && url === '/api/engine-login') {
      const { engine } = await readJSON(req, 1e5);
      if (!engine) throw new Error('Missing engine.');
      return sendJSON(res, 200, engines.startLogin(engine));
    }

    // The Connect button: save first (unless the page is keeping the key itself),
    // then prove the engine answers before anyone waits on a real analysis.
    if (req.method === 'POST' && url === '/api/engine-connect') {
      const { engine, model, values, remember } = await readJSON(req, 1e5);
      if (!engine) throw new Error('Missing engine.');
      if (remember !== false && !engines.SERVERLESS && values && Object.keys(values).length) {
        engines.saveConfig(engine, values);
      }
      let result;
      try {
        result = await engines.test(engine, model, values || null);
      } catch (ex) {
        return sendJSON(res, 200, {
          ok: false, error: ex.message, kind: engines.classifyFailure(ex.message),
          engineInfo: engines.describe(engines.BY_ID.get(engine)),
        });
      }
      return sendJSON(res, 200, { ...result, engineInfo: engines.describe(engines.BY_ID.get(engine)) });
    }

    if (req.method === 'POST' && url === '/api') {
      const { prompt, model, engine, images, values } = await readJSON(req, 30e6);
      if (!prompt) throw new Error('Missing prompt.');
      // A page may hold its own key (a hosted copy with nothing saved server-side);
      // only our own pages are allowed to pass one.
      const creds = values && trustedOrigin(req) ? values : null;
      // Screenshots are only accepted from trusted pages.
      let pics = [];
      if (Array.isArray(images) && images.length) {
        if (!trustedOrigin(req)) return sendJSON(res, 403, { error: 'Screenshots can only be sent from your local Offerly page.' });
        if (images.length > 5) throw new Error('Up to 5 screenshots per job.');
        pics = images;
      }
      const out = await engines.run(prompt, engine, model, pics, creds);
      logResponse(out.engine + '/' + (out.model || 'default'), prompt, out.text);
      return sendJSON(res, 200, { text: out.text, engine: out.engine, model: out.model });
    }

    // Live openings: real postings, with the date and link the source published.
    // The model's shortlist is only used to decide whose careers feed to read.
    if (req.method === 'POST' && url === '/api/jobs') {
      const b = await readJSON(req, 1e5);
      const out = await jobfeeds.search({
        roles: Array.isArray(b.roles) ? b.roles.slice(0, 8) : [],
        companies: Array.isArray(b.companies) ? b.companies.slice(0, 20) : [],
        country: String(b.country || ''),
        workSetup: ['remote', 'hybrid', 'onsite'].includes(b.workSetup) ? b.workSetup : '',
        days: Number.isFinite(+b.days) ? Math.max(0, Math.min(90, +b.days)) : 7,
        limit: Math.min(80, Number(b.limit) || 60),
        skills: Array.isArray(b.skills) ? b.skills.slice(0, 25) : [],
        level: Number.isFinite(+b.level) ? Math.max(0, Math.min(6, +b.level)) : undefined,
      });
      console.log('  live jobs: ' + out.jobs.length + ' kept from ' + out.scanned + ' scanned');
      return sendJSON(res, 200, out);
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
      const b = await readJSON(req, 1e5);
      const cfg = mailFrom(b && b.mail);
      if (!cfg || !cfg.pass) throw new Error('Enter your email settings first.');
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
}

module.exports = { handle, PORT, HOSTED, engines, loadMailCfg, publicMailCfg };
