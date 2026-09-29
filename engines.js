// Offerly engine registry — one adapter per AI agent.
//
// Two kinds:
//   cli — spawns an agent CLI installed and signed in on this machine (Claude Code,
//         Gemini CLI, OpenAI Codex, Cursor, Ollama). Billed to that subscription.
//   api — calls a provider's HTTP API with a key you supply.
//
// Every engine declares the `fields` it needs (an API key, a base URL, a binary
// path, a command). The web page renders them, you press Connect, and they are
// saved to offerly.engines.json next to this file — the same arrangement as the
// SMTP login in offerly.mail.json. Environment variables still work and are used
// when nothing has been saved, which is how a serverless deployment is configured.
//
// Every CLI engine takes its prompt on **stdin**: Offerly's prompts carry a whole
// resume and job post, and the Windows command line tops out around 8k characters.
// If your CLI version needs different flags, override them without touching this
// file:  OFFERLY_GEMINI_ARGS="-m gemini-2.5-pro" node bridge.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Serverless functions are killed at the platform's maxDuration (60s on Vercel's
// Hobby plan, up to 300s on Pro — raise both together in vercel.json).
const SERVERLESS = !!process.env.VERCEL;
const TIMEOUT_MS = Number(process.env.OFFERLY_TIMEOUT_MS) || (SERVERLESS ? 55000 : 240000);
const TEST_TIMEOUT_MS = Math.min(TIMEOUT_MS, 90000);
const CFG_FILE = path.join(__dirname, 'offerly.engines.json'); // gitignored — holds your API keys

// --- binary discovery -------------------------------------------------------
const EXTRA_DIRS = [
  path.join(process.env.APPDATA || '', 'npm'),
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.bun', 'bin'),
  path.join(os.homedir(), '.cargo', 'bin'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'cursor', 'resources', 'app', 'bin'),
  '/usr/local/bin', '/opt/homebrew/bin',
].filter(Boolean);

function which(names) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toLowerCase())
    : [''];
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...EXTRA_DIRS].filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext);
        try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
      }
    }
  }
  return null;
}

// Claude Code ships inside the VS Code extension, which is not on PATH.
function findClaudeInVSCode() {
  const ext = path.join(process.env.USERPROFILE || os.homedir(), '.vscode', 'extensions');
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

// A field named `bin` is understood everywhere: it overrides binary discovery.
const BIN_FIELD = (env, hint) => ({
  key: 'bin', label: 'Path to the binary (optional)', type: 'text', env,
  placeholder: hint, help: 'Leave blank to detect it automatically.',
});
const KEY_FIELD = (env, placeholder) => ({
  key: 'apiKey', label: 'API key', type: 'password', env, required: true, secret: true, placeholder,
});

// --- engine definitions -----------------------------------------------------
// models: an entry with value '' means "let the CLI use whatever it is set to".
// args(model, opts, cfg) -> argv after the binary. opts.workDir is set when
// screenshots were written to a temp folder the agent should be able to read.
// files: true = the agent opens the screenshot paths written into the prompt,
//        'inline' = images ride along in the request body, false = unsupported.
const ENGINES = [
  {
    id: 'claude',
    label: 'Claude Code',
    kind: 'cli',
    provider: 'claude', providerLabel: 'Claude · Anthropic', auth: 'sso',
    authLabel: 'Sign in with Claude', authNote: 'Runs on your Claude Pro or Max plan through Claude Code.',
    bins: ['claude'],
    find: findClaudeInVSCode,
    note: 'Billed to your Claude Code subscription — no API key or credits.',
    install: 'Install the Claude Code VS Code extension or CLI and sign in, then press Connect.',
    login: { args: ['auth', 'login'], label: 'Sign in with Claude',
      hint: 'Claude Code opens its own browser sign-in. Use the account your Claude Pro or Max plan is on.' },
    // `claude auth status` prints JSON and costs nothing, so the page can show who
    // is signed in without spending a request on the model.
    authStatus: {
      args: ['auth', 'status'],
      parse: out => {
        const j = JSON.parse(out);
        return { loggedIn: !!j.loggedIn, account: j.email || '', plan: j.subscriptionType || '' };
      },
    },
    files: true,
    fields: [BIN_FIELD('CLAUDE_BIN', 'C:\\path\\to\\claude.exe')],
    models: [
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — balanced (recommended)' },
      { value: 'claude-opus-4-8', label: 'Claude Opus 4.8 — deepest analysis' },
      { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fastest' },
    ],
    args: (model, opts) => {
      const a = ['-p', '--output-format', 'text'];
      if (model) a.push('--model', model);
      if (opts.workDir) a.push('--allowedTools', 'Read', '--add-dir', opts.workDir);
      return a;
    },
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    kind: 'cli',
    provider: 'google', providerLabel: 'Gemini · Google', auth: 'sso',
    authLabel: 'Sign in with Google', authNote: 'Runs on your Google account through Gemini CLI.',
    bins: ['gemini'],
    note: 'Uses your Google account / Gemini CLI login.',
    install: 'npm i -g @google/gemini-cli   then run `gemini` once to sign in.',
    login: { args: [], label: 'Sign in with Google',
      hint: 'Gemini CLI opens a Google sign-in in your browser on first run.' },
    files: true,
    fields: [BIN_FIELD('GEMINI_BIN', 'gemini')],
    models: [
      { value: '', label: 'Default — whatever Gemini CLI is set to' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro — deepest analysis' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — fastest' },
    ],
    args: (model) => (model ? ['-m', model] : []),
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    kind: 'cli',
    provider: 'openai', providerLabel: 'ChatGPT · OpenAI', auth: 'sso',
    authLabel: 'Sign in with ChatGPT', authNote: 'Runs on your ChatGPT Plus or Pro plan through Codex CLI.',
    bins: ['codex'],
    note: 'Uses your ChatGPT / Codex CLI login.',
    install: 'npm i -g @openai/codex   then run `codex` once to sign in.',
    login: { args: ['login'], label: 'Sign in with ChatGPT',
      hint: 'Codex CLI opens the ChatGPT sign-in in your browser. Use the account your Plus or Pro plan is on.' },
    files: true,
    fields: [BIN_FIELD('CODEX_BIN', 'codex')],
    models: [
      { value: '', label: 'Default — whatever Codex CLI is set to' },
      { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
      { value: 'gpt-5.1', label: 'GPT-5.1' },
    ],
    // `exec -` runs one non-interactive turn with the prompt read from stdin.
    args: (model, opts) => {
      const a = ['exec', '--skip-git-repo-check'];
      if (model) a.push('--model', model);
      if (opts.workDir) a.push('--cd', opts.workDir);
      a.push('-');
      return a;
    },
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    kind: 'cli',
    provider: 'cursor', providerLabel: 'Cursor', auth: 'sso',
    authLabel: 'Sign in with Cursor', authNote: 'Runs on your Cursor subscription.',
    bins: ['cursor-agent', 'cursor'],
    note: 'Uses your Cursor subscription.',
    install: 'Install Cursor and run `cursor-agent login`.',
    login: { args: ['login'], label: 'Sign in with Cursor',
      hint: 'Cursor opens its own sign-in in your browser.' },
    files: true,
    fields: [BIN_FIELD('CURSOR_BIN', 'cursor-agent')],
    models: [
      { value: '', label: 'Default — whatever Cursor is set to' },
      { value: 'sonnet-4.5', label: 'Claude Sonnet 4.5' },
      { value: 'gpt-5', label: 'GPT-5' },
    ],
    args: (model) => {
      const a = ['-p', '--output-format', 'text'];
      if (model) a.push('-m', model);
      return a;
    },
  },
  {
    id: 'ollama',
    label: 'Ollama (local model)',
    kind: 'cli',
    provider: 'ollama', providerLabel: 'Ollama · on this machine', auth: 'none',
    authLabel: 'Local model', authNote: 'No account and no key: the model runs on your own hardware.',
    bins: ['ollama'],
    note: 'Runs fully offline on your own hardware. Quality depends on the model you pull.',
    install: 'Install Ollama, then e.g. `ollama pull llama3.1`.',
    files: false, // no file-reading tool, so screenshots are not supported
    fields: [
      BIN_FIELD('OLLAMA_BIN', 'ollama'),
      { key: 'model', label: 'Model name (optional)', type: 'text', env: 'OLLAMA_MODEL',
        placeholder: 'llama3.1', help: 'Any model you have pulled. Appears at the top of the model list.' },
    ],
    models: [
      { value: 'llama3.1', label: 'llama3.1' },
      { value: 'qwen2.5', label: 'qwen2.5' },
      { value: 'mistral', label: 'mistral' },
    ],
    args: (model, opts, cfg) => ['run', model || cfg.model || 'llama3.1'],
  },
  {
    id: 'custom',
    label: 'Other agent (custom command)',
    kind: 'cli',
    provider: 'other', providerLabel: 'Something else', auth: 'none',
    authLabel: 'Custom command', authNote: 'Any CLI that reads a prompt on stdin.',
    note: 'Any CLI that reads a prompt on stdin and prints the answer.',
    install: 'Enter the command below and press Connect.',
    files: false,
    fields: [
      { key: 'cmd', label: 'Command', type: 'text', env: 'OFFERLY_AGENT_CMD', required: true,
        placeholder: 'C:\\path\\to\\agent.exe' },
      { key: 'args', label: 'Arguments (optional)', type: 'text', env: 'OFFERLY_AGENT_ARGS',
        placeholder: '--print', help: 'Space separated. The prompt is sent on stdin.' },
    ],
    models: [{ value: '', label: 'Whatever the command defaults to' }],
    resolveBin: (cfg) => {
      if (!cfg.cmd) return null;
      return fs.existsSync(cfg.cmd) ? cfg.cmd : which([cfg.cmd]);
    },
    args: (model, opts, cfg) => String(cfg.args || '').split(' ').filter(Boolean),
  },
  {
    id: 'openai-api',
    label: 'OpenAI API key',
    kind: 'api',
    provider: 'openai', providerLabel: 'ChatGPT · OpenAI', auth: 'key',
    authLabel: 'Use an API key', authNote: 'Pay-per-token on your OpenAI account, billed separately from ChatGPT.',
    note: 'Pay-per-token on your OpenAI account.',
    install: 'Create a key at platform.openai.com/api-keys, paste it below and press Connect.',
    files: 'inline',
    fields: [KEY_FIELD('OPENAI_API_KEY', 'sk-…')],
    models: [
      { value: 'gpt-5.1', label: 'GPT-5.1' },
      { value: 'gpt-5.1-mini', label: 'GPT-5.1 mini — cheaper' },
      { value: 'gpt-4.1', label: 'GPT-4.1' },
    ],
    call: (o) => chatCompletions({ ...o, baseUrl: 'https://api.openai.com/v1', key: o.cfg.apiKey }),
  },
  {
    id: 'anthropic-api',
    label: 'Anthropic API key',
    kind: 'api',
    provider: 'claude', providerLabel: 'Claude · Anthropic', auth: 'key',
    authLabel: 'Use an API key', authNote: 'Pay-per-token on the Anthropic API, billed separately from Claude Pro.',
    note: 'Pay-per-token. Only needed if you do not have Claude Code installed.',
    install: 'Create a key at console.anthropic.com, paste it below and press Connect.',
    files: 'inline',
    fields: [KEY_FIELD('ANTHROPIC_API_KEY', 'sk-ant-…')],
    models: [
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
    call: anthropicMessages,
  },
  {
    id: 'gemini-api',
    label: 'Google Gemini API key',
    kind: 'api',
    provider: 'google', providerLabel: 'Gemini · Google', auth: 'key',
    authLabel: 'Use an API key', authNote: 'Pay-per-token on Google AI Studio, with a free tier.',
    note: 'Pay-per-token, with a free tier, on Google AI Studio.',
    install: 'Create a key at aistudio.google.com/apikey, paste it below and press Connect.',
    files: 'inline',
    fields: [KEY_FIELD('GEMINI_API_KEY', 'AIza…')],
    models: [
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
    call: geminiGenerate,
  },
  {
    id: 'openai-compatible',
    label: 'Other API (OpenAI-compatible)',
    kind: 'api',
    provider: 'other', providerLabel: 'Something else', auth: 'key',
    authLabel: 'Use an API key', authNote: 'OpenRouter, Groq, Together, DeepSeek, LM Studio, vLLM.',
    note: 'OpenRouter, Groq, Together, DeepSeek, Mistral, LM Studio, vLLM — anything speaking /chat/completions.',
    install: 'Enter the endpoint, key and model below, then press Connect.',
    files: 'inline',
    fields: [
      { key: 'baseUrl', label: 'Base URL', type: 'text', env: 'OFFERLY_OPENAI_BASE_URL', required: true,
        placeholder: 'https://openrouter.ai/api/v1', help: 'Ends in /v1 — Offerly appends /chat/completions.' },
      KEY_FIELD('OFFERLY_OPENAI_KEY', 'sk-…'),
      { key: 'model', label: 'Model', type: 'text', env: 'OFFERLY_OPENAI_MODEL', required: true,
        placeholder: 'anthropic/claude-sonnet-4.5' },
    ],
    models: [{ value: '', label: 'The model entered above' }],
    call: (o) => chatCompletions({ ...o, model: o.model || o.cfg.model, baseUrl: o.cfg.baseUrl, key: o.cfg.apiKey }),
  },
];

const BY_ID = new Map(ENGINES.map(e => [e.id, e]));

// --- stored configuration ---------------------------------------------------
// Precedence: values sent with the request (a hosted page holding its own key)
// > what you saved through the UI > the environment.
let SAVED = readSaved();
function readSaved() {
  // A deployed image could carry a developer's own offerly.engines.json. Never use
  // it: on a serverless backend the only trusted source is the environment.
  if (SERVERLESS) return {};
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return {}; }
}
function cfgOf(e, override) {
  const saved = SAVED[e.id] || {};
  const out = {};
  for (const f of e.fields || []) {
    out[f.key] = String(
      (override && override[f.key]) || saved[f.key] || (f.env && process.env[f.env]) || ''
    ).trim();
  }
  return out;
}
function sourceOf(e, key) {
  const f = (e.fields || []).find(x => x.key === key);
  if (SAVED[e.id] && SAVED[e.id][key]) return 'saved';
  if (f && f.env && process.env[f.env]) return 'env';
  return '';
}
function writeSaved(all) {
  // A serverless container's disk is ephemeral: a write would appear to work and
  // then vanish on the next cold start, so refuse instead of pretending.
  if (SERVERLESS) throw new Error('This hosted deployment cannot store keys — its disk is wiped between requests. Either set them as environment variables in your hosting project, or untick “Save this key on my computer” to keep the key in this browser.');
  try {
    fs.writeFileSync(CFG_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch (ex) {
    throw new Error(SERVERLESS
      ? 'This hosted deployment has no writable disk, so keys cannot be stored on the server. Either set them as environment variables in your hosting project, or tick “keep this key in my browser only”.'
      : 'Could not write ' + CFG_FILE + ' (' + ex.code + ').');
  }
  SAVED = all;
  refresh();
}
function saveConfig(id, values) {
  const e = BY_ID.get(id);
  if (!e) throw new Error('Unknown engine: ' + id);
  const next = { ...(SAVED[id] || {}) };
  for (const f of e.fields || []) {
    if (!(f.key in values)) continue;
    const v = String(values[f.key] ?? '').trim();
    // A blank secret means "keep what is stored" — the page never receives it back.
    if (!v && f.secret) continue;
    if (v) next[f.key] = v; else delete next[f.key];
  }
  writeSaved({ ...SAVED, [id]: next });
  return describe(e);
}
function forgetConfig(id) {
  const e = BY_ID.get(id);
  if (!e) throw new Error('Unknown engine: ' + id);
  const all = { ...SAVED };
  delete all[id];
  writeSaved(all);
  return describe(e);
}

// --- availability -----------------------------------------------------------
// "a, b and c" rather than "a and b and c".
function listJoin(a) {
  return a.length < 3 ? a.join(' and ') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}
function missingFields(e, cfg) {
  return (e.fields || []).filter(f => f.required && !cfg[f.key]).map(f => f.label);
}
function resolve(e) {
  const cfg = cfgOf(e);
  e.missing = missingFields(e, cfg);
  e.blocked = '';
  if (e.kind === 'api') {
    e.bin = null;
    e.available = e.missing.length === 0;
    return e;
  }
  // A serverless deployment has no agent CLIs and nothing to spawn, so there only
  // the API engines are offered; the page falls back to a bridge on your machine.
  if (SERVERLESS) {
    e.bin = null;
    e.available = false;
    e.blocked = 'Runs on your own machine, not on this deployment. Start the Offerly bridge locally and reload.';
    return e;
  }
  e.bin = (cfg.bin && (fs.existsSync(cfg.bin) ? cfg.bin : which([cfg.bin])))
    || (e.resolveBin ? e.resolveBin(cfg) : null)
    || (e.find ? e.find() : null)
    || (e.bins ? which(e.bins) : null);
  e.available = !!e.bin && e.missing.length === 0;
  return e;
}
function refresh() { ENGINES.forEach(resolve); return ENGINES; }
refresh();

// What the web page needs to draw the ⚙ picker. Secrets never leave the server:
// a password field reports only whether one is set, and where it came from.
function describe(e) {
  const cfg = cfgOf(e);
  let models = e.models;
  if (e.id === 'openai-compatible' && cfg.model) models = [{ value: cfg.model, label: cfg.model }];
  if (e.id === 'ollama' && cfg.model && !e.models.some(m => m.value === cfg.model)) {
    models = [{ value: cfg.model, label: cfg.model + ' (yours)' }, ...e.models];
  }
  return {
    id: e.id, label: e.label, kind: e.kind, note: e.note, install: e.install,
    available: e.available, blocked: e.blocked || '', missing: e.missing || [],
    detected: e.kind === 'cli' ? !!e.bin : undefined,
    supportsImages: !!e.files,
    // Only meaningful once the binary is present: signing in needs something to run.
    login: e.login && e.bin && !SERVERLESS ? { label: e.login.label, hint: e.login.hint } : null,
    canCheckAuth: !!(e.authStatus && e.bin && !SERVERLESS),
    provider: e.provider, providerLabel: e.providerLabel,
    auth: e.auth, authLabel: e.authLabel, authNote: e.authNote,
    models,
    fields: (e.fields || []).map(f => ({
      key: f.key, label: f.label, type: f.type, placeholder: f.placeholder || '',
      help: f.help || '', required: !!f.required, secret: !!f.secret,
      env: f.env || '', source: sourceOf(e, f.key),
      value: f.secret ? '' : cfg[f.key],
      set: !!cfg[f.key],
    })),
  };
}
function listEngines() { return ENGINES.map(describe); }

function defaultEngine() {
  const wanted = process.env.OFFERLY_ENGINE;
  if (wanted && BY_ID.get(wanted)?.available) return wanted;
  return (ENGINES.find(e => e.available) || {}).id || null;
}
function getEngine(id, override) {
  const e = BY_ID.get(id) || BY_ID.get(defaultEngine());
  if (!e) throw new Error('No AI engine is set up yet. Open ⚙ Engine, pick one and press Connect.');
  // A request may carry its own credentials, which can make an engine usable even
  // though nothing is stored for it on this server.
  const cfg = cfgOf(e, override);
  const missing = missingFields(e, cfg);
  if (missing.length) throw new Error(`${e.label} needs ${listJoin(missing)}. Open ⚙ Engine, fill that in and press Connect.`);
  if (e.kind === 'api') return { e, cfg };
  if (e.blocked) throw new Error(`${e.label}: ${e.blocked}`);
  const bin = (cfg.bin && (fs.existsSync(cfg.bin) ? cfg.bin : which([cfg.bin])))
    || (e.resolveBin ? e.resolveBin(cfg) : null) || e.bin;
  if (!bin) throw new Error(`${e.label} was not found on this machine. ${e.install}`);
  return { e, cfg, bin };
}
// Only models we published for that engine, so nothing user-supplied reaches argv.
function pickModel(e, model, cfg) {
  const want = String(model || '').replace(/-\d{8}$/, ''); // dated id saved by an older build
  // These two take their model from a text field, so that wins over the dropdown.
  if (e.id === 'openai-compatible') return cfg.model || want;
  if (e.id === 'ollama') return /^[\w.:\/-]{1,120}$/.test(want) ? want : (cfg.model || e.models[0].value);
  if (e.models.some(m => m.value === want)) return want;
  return e.models[0].value;
}

// An agent CLI that is installed but signed out fails with its own wording, and the
// raw text is no help to someone looking at a web page. Recognising it lets the page
// offer the sign-in rather than just reporting that something went wrong.
const AUTH_RE = /\b(not (?:logged|signed) in|please (?:log|sign) ?in|log ?in required|authenticat\w*(?: (?:failed|required|error))?|unauthori[sz]ed|invalid api key|expired (?:token|credential|session)|no credentials|run `?\w+ login)\b|\b401\b/i;
function classifyFailure(message) {
  const m = String(message || '');
  if (AUTH_RE.test(m)) return 'auth';
  if (/\b(enoent|not found on this machine|could not start)\b/i.test(m)) return 'missing';
  return 'other';
}

// Starting a sign-in means opening a terminal the person can interact with: these
// flows print a URL and wait. Nothing from the request reaches the command line —
// the binary comes from what is already configured, the arguments from the registry
// above — so a page cannot use this to run something of its own choosing.
function startLogin(id) {
  if (SERVERLESS) throw new Error('Signing in to an agent CLI only works on a local Offerly bridge, not on a hosted deployment.');
  const e = BY_ID.get(id);
  if (!e) throw new Error('Unknown engine: ' + id);
  if (!e.login) throw new Error(`${e.label} has no sign-in of its own.`);
  const cfg = cfgOf(e);
  const bin = (cfg.bin && (fs.existsSync(cfg.bin) ? cfg.bin : which([cfg.bin])))
    || (e.find ? e.find() : null) || (e.bins ? which(e.bins) : null);
  if (!bin) throw new Error(`${e.label} is not installed yet. ${e.install}`);

  const args = e.login.args;
  let child;
  if (process.platform === 'win32') {
    // `start` reads the first quoted token as the window title, so give it one.
    const inner = [bin, ...args].map(a => `"${a}"`).join(' ');
    const line = `start "Offerly sign-in" cmd /k ${inner}`;
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line],
      { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    const cmd = [bin, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    child = spawn('osascript', ['-e', `tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`,
      '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' });
  } else {
    const term = which(['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']);
    if (!term) throw new Error(`Could not find a terminal to open. Run this yourself:  ${[bin, ...args].join(' ')}`);
    child = spawn(term, ['-e', bin, ...args], { detached: true, stdio: 'ignore' });
  }
  child.unref();
  return { ok: true, label: e.login.label, hint: e.login.hint, command: [bin, ...args].join(' ') };
}

// Some CLIs can say who is signed in without doing any work. Only Claude Code's
// output format is verified here; for the rest the page falls back to classifying
// whatever Connect fails with.
function authStatus(id) {
  return new Promise(resolve => {
    const e = BY_ID.get(id);
    if (!e || !e.authStatus || SERVERLESS) return resolve(null);
    const cfg = cfgOf(e);
    const bin = (cfg.bin && (fs.existsSync(cfg.bin) ? cfg.bin : which([cfg.bin])))
      || (e.find ? e.find() : null) || (e.bins ? which(e.bins) : null);
    if (!bin) return resolve(null);
    const child = spawnAgent(bin, e.authStatus.args, {});
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 20000);
    child.stdout.on('data', d => out += d.toString('utf8'));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(e.authStatus.parse(out.trim())); } catch (_) { resolve(null); }
    });
    child.stdin.end();
  });
}

// --- running a CLI engine ---------------------------------------------------
// Node refuses to spawn .cmd/.bat directly, so those go through cmd.exe. Only our
// own flags and a whitelisted model id ever reach the command line.
function spawnAgent(bin, args, opts) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const line = [bin, ...args].map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ');
    // cmd.exe /s strips the outer quote pair, so the whole line needs one of its
    // own — otherwise a path containing a space is cut in half.
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`],
      { ...opts, windowsHide: true, windowsVerbatimArguments: true });
  }
  return spawn(bin, args, { ...opts, windowsHide: true });
}

function runCli(e, bin, cfg, prompt, model, opts) {
  return new Promise((resolve_, reject) => {
    const override = process.env[`OFFERLY_${e.id.toUpperCase().replace(/-/g, '_')}_ARGS`];
    const args = override ? override.split(' ').filter(Boolean) : e.args(model, opts, cfg);
    const limit = opts.timeout || TIMEOUT_MS;
    const spawnOpts = {};
    if (opts.workDir) spawnOpts.cwd = opts.workDir;
    const child = spawnAgent(bin, args, spawnOpts);
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${e.label} timed out after ${Math.round(limit / 1000)}s.`));
    }, limit);
    child.stdout.on('data', d => out += d.toString('utf8'));
    child.stderr.on('data', d => err += d.toString('utf8'));
    child.on('error', ex => {
      clearTimeout(timer);
      reject(new Error(`Could not start ${e.label} (${ex.code || ex.message}). ${e.install}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (out.trim()) return resolve_(out.trim());
      reject(new Error(err.trim() || `${e.label} exited with code ${code} and no output.`));
    });
    child.stdin.on('error', () => {}); // agent may close stdin early
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

// --- API engines ------------------------------------------------------------
async function postJSON(url, headers, body, label, timeout) {
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout || TIMEOUT_MS),
    });
  } catch (ex) {
    throw new Error(`Could not reach ${label} (${ex.cause?.code || ex.name || ex.message}).`);
  }
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!r.ok) {
    const detail = json?.error?.message || json?.message || text.slice(0, 300);
    if (r.status === 401 || r.status === 403) throw new Error(`${label} rejected that key (HTTP ${r.status}): ${detail}`);
    throw new Error(`${label} returned HTTP ${r.status}: ${detail}`);
  }
  return json;
}

async function chatCompletions({ baseUrl, key, model, prompt, images, label = 'the API', timeout }) {
  if (!key) throw new Error(`No API key set for ${label}.`);
  if (!model) throw new Error(`No model set for ${label}. Open ⚙ Engine and enter one.`);
  const content = [{ type: 'text', text: prompt }];
  for (const im of images || []) {
    content.push({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.data}` } });
  }
  const j = await postJSON(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`,
    { authorization: `Bearer ${key}` },
    { model, messages: [{ role: 'user', content }] }, label, timeout);
  const out = j?.choices?.[0]?.message?.content;
  if (!out || !String(out).trim()) throw new Error(`${label} returned an empty reply.`);
  return String(out).trim();
}

async function anthropicMessages({ cfg, model, prompt, images, timeout }) {
  const content = [{ type: 'text', text: prompt }];
  for (const im of images || []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } });
  }
  const j = await postJSON('https://api.anthropic.com/v1/messages',
    { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: 16000, messages: [{ role: 'user', content }] }, 'the Anthropic API', timeout);
  const out = (j?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!out.trim()) throw new Error('The Anthropic API returned an empty reply.');
  return out.trim();
}

async function geminiGenerate({ cfg, model, prompt, images, timeout }) {
  const parts = [{ text: prompt }];
  for (const im of images || []) parts.push({ inline_data: { mime_type: im.mediaType, data: im.data } });
  const j = await postJSON(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { 'x-goog-api-key': cfg.apiKey },
    { contents: [{ parts }] }, 'the Gemini API', timeout);
  const out = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!out.trim()) throw new Error('The Gemini API returned an empty reply.');
  return out.trim();
}

// --- public entry point -----------------------------------------------------
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// Screenshots reach a CLI agent as files in a private temp folder whose paths are
// substituted into {{IMAGES}}; API engines get them inline and the placeholder is
// dropped. Either way the folder is deleted as soon as the call returns.
async function run(prompt, engineId, model, images, override, opts = {}) {
  const { e, cfg, bin } = getEngine(engineId, override);
  const m = pickModel(e, model, cfg);
  const pics = Array.isArray(images) ? images : [];
  const timeout = opts.timeout;
  const done = text => ({ text, engine: e.id, model: m });

  if (!pics.length) {
    const p = prompt.replace(/\{\{IMAGES\}\}/g, '');
    return done(e.kind === 'api'
      ? await e.call({ cfg, model: m, prompt: p, images: [], label: e.label, timeout })
      : await runCli(e, bin, cfg, p, m, { timeout }));
  }

  if (!e.files) throw new Error(`${e.label} cannot read screenshots. Paste the job text instead, or pick a different engine in ⚙.`);
  for (const im of pics) {
    if (!IMG_EXT[im.mediaType]) throw new Error('Unsupported image type: ' + im.mediaType + '. Use PNG, JPG, WEBP or GIF.');
  }

  if (e.files === 'inline') {
    return done(await e.call({ cfg, model: m, prompt: prompt.replace(/\{\{IMAGES\}\}/g, '(attached above)'), images: pics, label: e.label, timeout }));
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerly-'));
  try {
    const files = pics.map((img, i) => {
      const file = path.join(dir, `screenshot-${i + 1}.${IMG_EXT[img.mediaType]}`);
      fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
      return file;
    });
    return done(await runCli(e, bin, cfg, prompt.replace(/\{\{IMAGES\}\}/g, files.join('\n')), m, { workDir: dir, timeout }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The Connect button: one cheap round trip that proves the engine really answers.
// Credentials are checked as given, so a bad key fails here rather than mid-analysis.
async function test(engineId, model, override) {
  const started = Date.now();
  const out = await run('Reply with exactly this word and nothing else: OFFERLY', engineId, model, [], override,
    { timeout: TEST_TIMEOUT_MS });
  return {
    ok: true, engine: out.engine, model: out.model,
    reply: out.text.replace(/\s+/g, ' ').trim().slice(0, 120),
    ms: Date.now() - started,
  };
}

module.exports = {
  run, test, listEngines, describe, defaultEngine, refresh, getEngine,
  saveConfig, forgetConfig, startLogin, authStatus, classifyFailure, BY_ID, CFG_FILE, SERVERLESS,
};
