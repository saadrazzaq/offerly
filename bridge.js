// Offerly local bridge — serves the two pages and runs every prompt through an AI
// agent installed on this machine (Claude Code, Gemini CLI, OpenAI Codex, Cursor,
// Ollama) or an API key. The routes themselves live in app.js, which the Vercel
// deployment in api/ reuses unchanged.
const http = require('http');
const { handle, PORT, LAN, lanUrls, engines, loadMailCfg, publicMailCfg } = require('./app');

const server = http.createServer(handle);
// A second copy cannot take the port, and the first one keeps answering with
// whatever code it started with — which is how a restart could appear to change
// nothing. Say so instead of dying with a stack trace.
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n  Offerly is already running on port ' + PORT + ' — this copy did not start.');
    console.error('  Close the other Offerly window (or end the node.exe process using port ' + PORT + ')');
    console.error('  and start this one again, so the page talks to the current version.\n');
    process.exit(1);
  }
  throw err;
});
// Only this computer can connect, unless phone access is on (OFFERLY_LAN=1), which
// also lets devices on your Wi-Fi in — each one only after pairing with the key.
server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  const ready = engines.listEngines().filter(e => e.available);
  const def = engines.defaultEngine();
  console.log('\n  Offerly bridge running');
  console.log('  → job finder   http://localhost:' + PORT + '/');
  console.log('  → bulk apply   http://localhost:' + PORT + '/apply');
  if (ready.length) {
    console.log('  → agents       ' + ready.map(e => (e.id === def ? '* ' : '') + e.label).join(', '));
    console.log('                 (* = default — change it in ⚙ Engine, or set OFFERLY_ENGINE)');
  } else {
    console.log('  → agents       NONE CONNECTED. Open ⚙ Engine in the page, pick a provider and');
    console.log('                 paste its API key — or set OPENAI_API_KEY / ANTHROPIC_API_KEY /');
    console.log('                 GEMINI_API_KEY here before starting.');
  }
  console.log('  → email        ' + (publicMailCfg(loadMailCfg()).configured ? 'ready (' + loadMailCfg().user + ')' : 'not set up yet'));
  if (LAN) {
    console.log('  → phone        scan the QR code at http://localhost:' + PORT + '/phone');
    lanUrls().forEach(u => console.log('                 ' + u));
    console.log('                 (same Wi-Fi only; the link holds a secret key, keep it to yourself)');
  }
  console.log('');
});
