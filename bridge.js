// RecruiterAI local bridge — routes the web page through your Claude Code license
// (uses the bundled `claude` binary headless, billed to your subscription — no API key/credits).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8787;
const HERE = __dirname;

// --- locate the Claude Code binary ----------------------------------------
function findClaude() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const ext = path.join(process.env.USERPROFILE || '', '.vscode', 'extensions');
  try {
    const dirs = fs.readdirSync(ext)
      .filter(d => d.startsWith('anthropic.claude-code-'))
      .sort().reverse(); // newest version first
    for (const d of dirs) {
      const p = path.join(ext, d, 'resources', 'native-binary', 'claude.exe');
      if (fs.existsSync(p)) return p;
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
function runClaude(prompt, model) {
  return new Promise((resolve, reject) => {
    const m = MODELS[model] || 'claude-sonnet-4-6';
    const args = ['-p', '--model', m, '--output-format', 'text'];
    const child = spawn(CLAUDE, args, { windowsHide: true });
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

// --- server ---------------------------------------------------------------
const server = http.createServer((req, res) => {
  // CORS — allow the page to call this bridge whether it's opened locally (file://,
  // http://localhost) or from a hosted HTTPS origin (e.g. the Vercel deployment).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  // Private Network Access: a public HTTPS page (Vercel) calling http://localhost is a
  // public→private request; Chrome/Edge require this header on the preflight or it's blocked.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    return fs.readFile(path.join(HERE, 'index.html'), (e, data) => {
      if (e) { res.writeHead(500); return res.end('index.html not found'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: !!CLAUDE, claude: CLAUDE || null }));
  }

  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', async () => {
      try {
        if (!CLAUDE) throw new Error('Claude Code binary not found on this machine.');
        const { prompt, model } = JSON.parse(body || '{}');
        if (!prompt) throw new Error('Missing prompt.');
        const text = await runClaude(prompt, model);
        try { fs.appendFileSync(path.join(HERE, 'offerly.log'),
          `\n\n===== ${new Date().toISOString()} model=${model} len=${text.length} prompt="${prompt.slice(0,70).replace(/\n/g,' ')}" =====\n${text}\n`); } catch (_) {}
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log('\n  Offerly bridge running');
  console.log('  → open  http://localhost:' + PORT + '/');
  console.log('  → using ' + (CLAUDE || 'NO CLAUDE BINARY FOUND'));
  console.log('  (billed to your Claude Code subscription — no API key needed)\n');
});
