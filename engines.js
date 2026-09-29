// Offerly engine registry — one adapter per AI agent.
//
// Two kinds:
//   cli — spawns an agent CLI already installed and signed in on this machine
//         (Claude Code, Gemini CLI, OpenAI Codex, Cursor, Ollama). Billed to that
//         subscription, no API key needed.
//   api — calls a provider's HTTP API directly with a key from the environment.
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
const TIMEOUT_MS = Number(process.env.OFFERLY_TIMEOUT_MS) || (process.env.VERCEL ? 55000 : 240000);

// --- binary discovery -------------------------------------------------------
const EXTRA_DIRS = [
  path.join(process.env.APPDATA || '', 'npm'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs'),
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

// --- engine definitions -----------------------------------------------------
// models: first entry with value '' means "let the CLI use whatever it is set to".
// args(model, opts) -> argv after the binary. opts.workDir is set when screenshots
// were written to a temp folder the agent should be able to read.
// files: the agent can open the screenshot paths written into the prompt.
const ENGINES = [
  {
    id: 'claude',
    label: 'Claude Code',
    kind: 'cli',
    bins: ['claude'],
    find: findClaudeInVSCode,
    envBin: 'CLAUDE_BIN',
    note: 'Billed to your Claude Code subscription — no API key or credits.',
    install: 'Install the Claude Code VS Code extension or CLI and sign in.',
    files: true,
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
    bins: ['gemini'],
    envBin: 'GEMINI_BIN',
    note: 'Uses your Google account / Gemini CLI login.',
    install: 'npm i -g @google/gemini-cli   then run `gemini` once to sign in.',
    files: true,
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
    bins: ['codex'],
    envBin: 'CODEX_BIN',
    note: 'Uses your ChatGPT / Codex CLI login.',
    install: 'npm i -g @openai/codex   then run `codex` once to sign in.',
    files: true,
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
    bins: ['cursor-agent', 'cursor'],
    envBin: 'CURSOR_BIN',
    note: 'Uses your Cursor subscription.',
    install: 'Install Cursor and run `cursor-agent login` (or install the cursor-agent CLI).',
    files: true,
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
    bins: ['ollama'],
    envBin: 'OLLAMA_BIN',
    note: 'Runs fully offline on your own hardware. Quality depends on the model you pull.',
    install: 'Install Ollama, then e.g. `ollama pull llama3.1`.',
    files: false, // no file-reading tool, so screenshots are not supported
    models: [
      { value: 'llama3.1', label: 'llama3.1' },
      { value: 'qwen2.5', label: 'qwen2.5' },
      { value: 'mistral', label: 'mistral' },
    ],
    args: (model) => ['run', model || 'llama3.1'],
  },
  {
    id: 'custom',
    label: 'Other agent (custom command)',
    kind: 'cli',
    note: 'Any CLI that reads a prompt on stdin and prints the answer. Set OFFERLY_AGENT_CMD (and optionally OFFERLY_AGENT_ARGS).',
    install: 'OFFERLY_AGENT_CMD="C:\\path\\to\\agent.exe" OFFERLY_AGENT_ARGS="--print" node bridge.js',
    files: false,
    models: [{ value: '', label: 'Whatever the command defaults to' }],
    resolveBin: () => (process.env.OFFERLY_AGENT_CMD || null),
    args: () => (process.env.OFFERLY_AGENT_ARGS || '').split(' ').filter(Boolean),
  },
  {
    id: 'openai-api',
    label: 'OpenAI API key',
    kind: 'api',
    envKey: 'OPENAI_API_KEY',
    note: 'Pay-per-token on your OpenAI account.',
    install: 'OPENAI_API_KEY=sk-... node bridge.js',
    files: 'inline',
    models: [
      { value: 'gpt-5.1', label: 'GPT-5.1' },
      { value: 'gpt-5.1-mini', label: 'GPT-5.1 mini — cheaper' },
      { value: 'gpt-4.1', label: 'GPT-4.1' },
    ],
    call: (o) => chatCompletions({ ...o, baseUrl: 'https://api.openai.com/v1', key: process.env.OPENAI_API_KEY }),
  },
  {
    id: 'anthropic-api',
    label: 'Anthropic API key',
    kind: 'api',
    envKey: 'ANTHROPIC_API_KEY',
    note: 'Pay-per-token. Only needed if you do not have Claude Code installed.',
    install: 'ANTHROPIC_API_KEY=sk-ant-... node bridge.js',
    files: 'inline',
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
    envKey: 'GEMINI_API_KEY',
    note: 'Pay-per-token (free tier available) on Google AI Studio.',
    install: 'GEMINI_API_KEY=... node bridge.js',
    files: 'inline',
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
    envKey: 'OFFERLY_OPENAI_KEY',
    note: 'OpenRouter, Groq, Together, DeepSeek, LM Studio, vLLM — anything speaking /chat/completions. Set OFFERLY_OPENAI_BASE_URL, OFFERLY_OPENAI_KEY and OFFERLY_OPENAI_MODEL.',
    install: 'OFFERLY_OPENAI_BASE_URL="https://openrouter.ai/api/v1" OFFERLY_OPENAI_KEY=... OFFERLY_OPENAI_MODEL="..." node bridge.js',
    files: 'inline',
    models: [{ value: '', label: 'From OFFERLY_OPENAI_MODEL' }],
    call: (o) => chatCompletions({
      ...o,
      model: o.model || process.env.OFFERLY_OPENAI_MODEL,
      baseUrl: process.env.OFFERLY_OPENAI_BASE_URL || 'https://api.openai.com/v1',
      key: process.env.OFFERLY_OPENAI_KEY,
    }),
  },
];

const BY_ID = new Map(ENGINES.map(e => [e.id, e]));

// --- availability -----------------------------------------------------------
// Resolved once at startup; refresh() re-checks after you install something.
// A serverless deployment has no agent CLIs and nothing to spawn, so there only the
// API engines are offered — the page then falls back to a bridge on the user's machine.
const SERVERLESS = !!process.env.VERCEL;

function resolve(e) {
  if (e.kind === 'cli' && SERVERLESS) {
    e.available = false;
    e.bin = null;
    e.note = 'Runs on your own machine, not on this deployment. Start the Offerly bridge locally and reload.';
    return e;
  }
  if (e.kind === 'api') {
    e.available = !!process.env[e.envKey];
    e.bin = null;
    return e;
  }
  const fromEnv = e.envBin && process.env[e.envBin];
  e.bin = (fromEnv && fs.existsSync(fromEnv) ? fromEnv : null)
    || (e.resolveBin ? e.resolveBin() : null)
    || (e.find ? e.find() : null)
    || (e.bins ? which(e.bins) : null);
  e.available = !!e.bin;
  return e;
}
function refresh() { ENGINES.forEach(resolve); return ENGINES; }
refresh();

// What the web page needs to draw the ⚙ picker.
function listEngines() {
  return ENGINES.map(e => ({
    id: e.id, label: e.label, kind: e.kind, note: e.note, install: e.install,
    available: e.available, models: e.models,
    supportsImages: !!e.files,
  }));
}
function defaultEngine() {
  const wanted = process.env.OFFERLY_ENGINE;
  if (wanted && BY_ID.get(wanted)?.available) return wanted;
  return (ENGINES.find(e => e.available) || {}).id || null;
}
function getEngine(id) {
  const e = BY_ID.get(id) || BY_ID.get(defaultEngine());
  if (!e) throw new Error('No AI engine is available. Install Claude Code, Gemini CLI, Codex or Cursor, or set an API key — see the ⚙ Engine menu.');
  if (!e.available) {
    throw new Error(e.kind === 'api'
      ? `${e.label} needs ${e.envKey} in the environment. ${e.install}`
      : `${e.label} was not found on this machine. ${e.install}`);
  }
  return e;
}
// Only models we published for that engine, so nothing user-supplied reaches argv.
function pickModel(e, model) {
  const want = String(model || '').replace(/-\d{8}$/, ''); // dated id saved by an older build
  if (e.models.some(m => m.value === want)) return want;
  if (e.id === 'openai-compatible' || e.id === 'ollama') {
    return /^[\w.:\/-]{1,120}$/.test(model || '') ? model : e.models[0].value;
  }
  return e.models[0].value;
}

// --- running a CLI engine ---------------------------------------------------
// Node refuses to spawn .cmd/.bat directly, so those go through cmd.exe. Only our
// own flags and a whitelisted model id ever reach the command line.
function spawnAgent(bin, args, opts) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const line = [bin, ...args].map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`],
      { ...opts, windowsHide: true, windowsVerbatimArguments: true });
  }
  return spawn(bin, args, { ...opts, windowsHide: true });
}

function runCli(e, prompt, model, opts) {
  return new Promise((resolve_, reject) => {
    const override = process.env[`OFFERLY_${e.id.toUpperCase().replace(/-/g, '_')}_ARGS`];
    const args = override ? override.split(' ').filter(Boolean) : e.args(model, opts);
    const spawnOpts = {};
    if (opts.workDir) spawnOpts.cwd = opts.workDir;
    const child = spawnAgent(e.bin, args, spawnOpts);
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${e.label} timed out after ${Math.round(TIMEOUT_MS / 1000)}s.`));
    }, TIMEOUT_MS);
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
async function postJSON(url, headers, body, label) {
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (ex) {
    throw new Error(`Could not reach ${label} (${ex.cause?.code || ex.name || ex.message}).`);
  }
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!r.ok) throw new Error(`${label} returned HTTP ${r.status}: ${json?.error?.message || text.slice(0, 300)}`);
  return json;
}

async function chatCompletions({ baseUrl, key, model, prompt, images, label = 'the API' }) {
  if (!key) throw new Error(`No API key set for ${label}.`);
  if (!model) throw new Error('No model set. Set OFFERLY_OPENAI_MODEL to the model you want to use.');
  const content = [{ type: 'text', text: prompt }];
  for (const im of images || []) {
    content.push({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.data}` } });
  }
  const j = await postJSON(`${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    { authorization: `Bearer ${key}` },
    { model, messages: [{ role: 'user', content }] }, label);
  const out = j?.choices?.[0]?.message?.content;
  if (!out || !String(out).trim()) throw new Error(`${label} returned an empty reply.`);
  return String(out).trim();
}

async function anthropicMessages({ model, prompt, images }) {
  const content = [{ type: 'text', text: prompt }];
  for (const im of images || []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } });
  }
  const j = await postJSON('https://api.anthropic.com/v1/messages',
    { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: 16000, messages: [{ role: 'user', content }] }, 'the Anthropic API');
  const out = (j?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!out.trim()) throw new Error('The Anthropic API returned an empty reply.');
  return out.trim();
}

async function geminiGenerate({ model, prompt, images }) {
  const parts = [{ text: prompt }];
  for (const im of images || []) parts.push({ inline_data: { mime_type: im.mediaType, data: im.data } });
  const j = await postJSON(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { 'x-goog-api-key': process.env.GEMINI_API_KEY },
    { contents: [{ parts }] }, 'the Gemini API');
  const out = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!out.trim()) throw new Error('The Gemini API returned an empty reply.');
  return out.trim();
}

// --- public entry point -----------------------------------------------------
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// Screenshots reach a CLI agent as files in a private temp folder whose paths are
// substituted into {{IMAGES}}; API engines get them inline and the placeholder is
// dropped. Either way the folder is deleted as soon as the call returns.
async function run(prompt, engineId, model, images) {
  const e = getEngine(engineId);
  const m = pickModel(e, model);
  const pics = Array.isArray(images) ? images : [];

  if (!pics.length) {
    const text = e.kind === 'api'
      ? await e.call({ model: m, prompt: prompt.replace(/\{\{IMAGES\}\}/g, ''), images: [], label: e.label })
      : await runCli(e, prompt.replace(/\{\{IMAGES\}\}/g, ''), m, {});
    return { text, engine: e.id, model: m };
  }

  if (!e.files) throw new Error(`${e.label} cannot read screenshots. Paste the job text instead, or pick a different engine in ⚙.`);
  for (const im of pics) {
    if (!IMG_EXT[im.mediaType]) throw new Error('Unsupported image type: ' + im.mediaType + '. Use PNG, JPG, WEBP or GIF.');
  }

  if (e.files === 'inline') {
    const text = await e.call({ model: m, prompt: prompt.replace(/\{\{IMAGES\}\}/g, '(attached above)'), images: pics, label: e.label });
    return { text, engine: e.id, model: m };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerly-'));
  try {
    const files = pics.map((img, i) => {
      const file = path.join(dir, `screenshot-${i + 1}.${IMG_EXT[img.mediaType]}`);
      fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
      return file;
    });
    const text = await runCli(e, prompt.replace(/\{\{IMAGES\}\}/g, files.join('\n')), m, { workDir: dir });
    return { text, engine: e.id, model: m };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run, listEngines, defaultEngine, refresh, getEngine };
