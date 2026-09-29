// Offerly local bridge — serves the two pages and runs every prompt through an AI
// agent installed on this machine (Claude Code, Gemini CLI, OpenAI Codex, Cursor,
// Ollama) or an API key. The routes themselves live in app.js, which the Vercel
// deployment in api/ reuses unchanged.
const http = require('http');
const { handle, PORT, engines, loadMailCfg, publicMailCfg } = require('./app');

http.createServer(handle).listen(PORT, '127.0.0.1', () => {
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
  console.log('  → email        ' + (publicMailCfg(loadMailCfg()).configured ? 'ready (' + loadMailCfg().user + ')' : 'not set up yet') + '\n');
});
