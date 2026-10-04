// Turns the resume page built in the browser into a PDF with the browser engine
// already on this machine (Edge or Chrome, headless). That is what gives the PDF
// real, selectable text in the resume's own fonts, the page size and margins the
// page's @page rule asks for, and page breaks that respect break-inside/-after —
// none of which a canvas snapshot or a hand-drawn jsPDF can do.
//
// A serverless deployment has no browser to launch, so there the page falls back
// to the browser's own print dialog.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const CANDIDATES = [
  process.env.OFFERLY_BROWSER,
  ...(process.platform === 'win32' ? [
    path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ]),
].filter(Boolean);

function findBrowser() {
  for (const p of CANDIDATES) { try { if (fs.statSync(p).isFile()) return p; } catch (_) {} }
  return null;
}

// The page sends markup it built from the resume. Nothing in it needs to run or
// load anything, so scripts, frames and remote resources are removed, and a
// Content-Security-Policy blocks whatever slips through — including file:// reads,
// since the HTML is opened from a temp file.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;
function sanitize(html) {
  let h = String(html)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(iframe|object|embed|frame|frameset|base|link|meta)\b[^>]*>/gi, '')
    .replace(/<\/(iframe|object|embed|frame|frameset)\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  if (/<head[^>]*>/i.test(h)) h = h.replace(/<head[^>]*>/i, m => m + '<meta charset="utf-8">' + CSP);
  else h = '<!doctype html><html><head><meta charset="utf-8">' + CSP + '</head><body>' + h + '</body></html>';
  return h;
}

// The launcher process can exit before the renderer has finished writing, so the
// file is waited for rather than assumed.
function waitForFile(file, ms) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    let last = -1;
    const tick = () => {
      let size = -1;
      try { size = fs.statSync(file).size; } catch (_) {}
      if (size > 0 && size === last) return resolve();
      last = size;
      if (Date.now() > until) return reject(new Error('The browser did not produce a PDF.'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function htmlToPdf(html) {
  const bin = findBrowser();
  if (!bin) {
    const e = new Error('No Edge or Chrome found on this machine to make the PDF. Set OFFERLY_BROWSER to its path.');
    e.status = 501;
    throw e;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerly-pdf-'));
  const src = path.join(dir, 'resume.html'), out = path.join(dir, 'resume.pdf');
  try {
    fs.writeFileSync(src, sanitize(html), 'utf8');
    await new Promise((resolve, reject) => {
      execFile(bin, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--no-pdf-header-footer', '--run-all-compositor-stages-before-draw',
        '--user-data-dir=' + path.join(dir, 'profile'),
        '--print-to-pdf=' + out,
        pathToFileURL(src).href,
      ], { timeout: 60000, windowsHide: true }, err => (err && !fs.existsSync(out) ? reject(err) : resolve()));
    });
    await waitForFile(out, 20000);
    return fs.readFileSync(out);
  } finally {
    // The browser can hold its profile open for a moment after exiting.
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }, 5000);
  }
}

module.exports = { htmlToPdf, findBrowser };
