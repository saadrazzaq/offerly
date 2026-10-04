/* Offerly — keeps an uploaded resume's format while its text is improved.
 *
 * The uploaded file is turned into one HTML document that looks like it:
 *   - PDF:  rebuilt from pdf.js — each line's font, size, weight, colour, indent and
 *           alignment, bullets with hanging indents, right-aligned dates, rules under
 *           headings, two-column (sidebar) layouts and links. Wrapped lines become
 *           one paragraph, so rewritten text reflows instead of overflowing.
 *   - DOCX: rendered by docx-preview, which reads the Word styles, numbering and tab
 *           stops directly.
 *   - TXT:  laid out as a plain, clean page.
 * Every paragraph is a block (data-b). The AI rewrites block text only, and the new
 * text is poured back into the block's own runs, so a bold "Skills:" label or an
 * italic line keeps its styling. The same document is what gets printed to PDF,
 * with CSS page breaks that keep headings with what follows and never split a
 * bullet across pages.
 */
(function () {
  'use strict';

  const r1 = n => Math.round(n * 10) / 10;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function loadScript(src, test) {
    if (test()) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  // Styling shared by every rebuilt document. Screen shows it as a page; print (and
  // the PDF) uses the @page rule each builder adds.
  const BASE_CSS = `
    html{background:#e9ecf2}
    body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;color:#000}
    .b{margin:0;orphans:2;widows:2}
    .bl,.row,.rule,tr{break-inside:avoid}
    .hd,.row{break-after:avoid}
    .rule{break-before:avoid;break-after:avoid}
    .row{display:flex;align-items:baseline}
    .row>.sg{white-space:pre-wrap}
    .row>.sg+.sg{flex-shrink:0}
    .bul{display:inline-block;white-space:nowrap;text-indent:0}
    .cols{display:grid;align-items:start}
    a{color:inherit;text-decoration:none}
    [data-b]{white-space:pre-wrap}
    @media screen{
      .chg{background:rgba(255,214,0,.28);box-shadow:0 0 0 2px rgba(255,214,0,.28);border-radius:2px}
      [contenteditable]:focus,body:focus{outline:none}
    }
    @media print{.chg{background:none!important;box-shadow:none!important}}
  `;

  /* ------------------------------------------------------------------ PDF ---- */

  // Word's Symbol and Wingdings bullets arrive as private-use code points.
  const PUA = { '': '•', '': '▪', '': '➢', '': '❖', '': '✓', '': '◦', '': '■', '': '➔', '': '▸' };
  const BULLET_RE = /^[•●▪■◦○‣➢➤►▸✓✔❖➔\-–—*·]$/;
  const fixChars = s => s.replace(/[-]/g, c => PUA[c] || '•');

  // The font the PDF itself carries, as pdf.js converted it for display, so the page is
  // set in the resume's own font even where that font is not installed (DejaVu Sans,
  // Lato, a LaTeX font). Embedded fonts usually hold only the characters the resume
  // used; a new character falls back to the next font in the list, the installed
  // family of the same name when there is one.
  function bytesToBase64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fontKey(u8) {
    let h = 2166136261 >>> 0;
    const n = Math.min(u8.length, 8192);
    for (let i = 0; i < n; i++) h = Math.imul(h ^ u8[i], 16777619) >>> 0;
    return h.toString(36) + '_' + u8.length;
  }
  function embedFont(fo, faces, base, weight, italic) {
    if (!fo || fo.missingFile || !fo.data || !fo.data.length || !faces) return '';
    const k = fontKey(fo.data) + '_' + weight + (italic ? 'i' : '');
    if (!faces.has(k)) {
      let data = fo.data;
      try { data = fixCharacterMap(fo.data, fo.toUnicode, fo.toFontChar) || fo.data; } catch (_) { data = fo.data; }
      faces.set(k, {
        family: 'rf' + (faces.size + 1) + '_' + String(base || 'font').replace(/[^A-Za-z0-9]/g, '').slice(0, 24),
        css: `url(data:${fo.mimetype || 'font/opentype'};base64,${bytesToBase64(data)})`, weight, italic,
      });
    }
    return faces.get(k).family;
  }

  // pdf.js rebuilds an embedded font's character map from the PDF's own. Where the PDF
  // set "ff", "fi" or "ffi" as one ligature glyph, it can hand the plain letter "f"
  // to that ligature, so "Software" came out "Soffitware". The map is rebuilt here
  // from the PDF's character data: every single character to its own glyph, and a
  // ligature glyph only to the private codes pdf.js gave it, never to a letter.
  function fixCharacterMap(font, toUnicode, toFontChar) {
    const map = toUnicode && toUnicode._map;
    if (!map || !Array.isArray(toFontChar)) return null;
    const entries = Object.entries(map).filter(([, u]) => typeof u === 'string' && u.length);
    if (!entries.some(([, u]) => [...u].length > 1)) return null;          // no ligatures: nothing to fix
    const dv = new DataView(font.buffer, font.byteOffset, font.byteLength);
    const numTables = dv.getUint16(4);
    const tables = [];
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      tables.push({ tag: String.fromCharCode(font[o], font[o + 1], font[o + 2], font[o + 3]), offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) });
    }
    const cmapT = tables.find(t => t.tag === 'cmap');
    if (!cmapT) return null;
    // The glyph the current map gives a code (format 4 or 12 subtable).
    const base = cmapT.offset, n = dv.getUint16(base + 2);
    const subs = [];
    for (let i = 0; i < n; i++) subs.push({ pid: dv.getUint16(base + 4 + i * 8), eid: dv.getUint16(base + 6 + i * 8), off: base + dv.getUint32(base + 8 + i * 8) });
    const lookups = subs.map(s => {
      const fmt = dv.getUint16(s.off);
      if (fmt === 4) {
        const segX2 = dv.getUint16(s.off + 6), seg = segX2 / 2, ends = s.off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        return c => {
          for (let i = 0; i < seg; i++) {
            if (c > dv.getUint16(ends + i * 2)) continue;
            const st = dv.getUint16(starts + i * 2);
            if (c < st) return 0;
            const ro = dv.getUint16(ranges + i * 2), delta = dv.getInt16(deltas + i * 2);
            if (!ro) return (c + delta) & 0xffff;
            const g = dv.getUint16(ranges + i * 2 + ro + (c - st) * 2);
            return g ? (g + delta) & 0xffff : 0;
          }
          return 0;
        };
      }
      if (fmt === 12) {
        const groups = dv.getUint32(s.off + 12);
        return c => {
          for (let i = 0; i < groups; i++) {
            const g = s.off + 16 + i * 12, a = dv.getUint32(g), b = dv.getUint32(g + 4);
            if (c >= a && c <= b) return dv.getUint32(g + 8) + (c - a);
          }
          return 0;
        };
      }
      return () => 0;
    });
    const glyphOf = c => { for (const f of lookups) { const g = f(c); if (g) return g; } return 0; };
    const out = new Map();
    for (const [code, u] of entries) {
      const fc = toFontChar[+code];
      if (typeof fc !== 'number') continue;
      const g = glyphOf(fc);
      if (!g) continue;
      if (fc < 0xffff) out.set(fc, g);                                   // the private code pdf.js draws with
      const cps = [...u];
      if (cps.length === 1) { const cp = cps[0].codePointAt(0); if (cp < 0xffff) out.set(cp, g); }
    }
    if (!out.size) return null;
    // A format 4 subtable: one segment per run of codes whose glyphs follow on.
    const codes = [...out.keys()].sort((a, b) => a - b);
    const segs = [];
    for (const c of codes) {
      const g = out.get(c), last = segs[segs.length - 1];
      if (last && c === last.end + 1 && g - c === last.delta) last.end = c;
      else segs.push({ start: c, end: c, delta: g - c });
    }
    segs.push({ start: 0xffff, end: 0xffff, delta: 1 });
    const sc = segs.length, sub = new DataView(new ArrayBuffer(16 + sc * 8));
    const sr = 2 * Math.pow(2, Math.floor(Math.log2(sc)));
    sub.setUint16(0, 4); sub.setUint16(2, 16 + sc * 8); sub.setUint16(4, 0);
    sub.setUint16(6, sc * 2); sub.setUint16(8, sr); sub.setUint16(10, Math.log2(sr / 2)); sub.setUint16(12, sc * 2 - sr);
    segs.forEach((s, i) => {
      sub.setUint16(14 + i * 2, s.end);
      sub.setUint16(16 + sc * 2 + i * 2, s.start);
      sub.setInt16(16 + sc * 4 + i * 2, ((s.delta % 65536) + 65536) % 65536 > 32767 ? (((s.delta % 65536) + 65536) % 65536) - 65536 : ((s.delta % 65536) + 65536) % 65536);
      sub.setUint16(16 + sc * 6 + i * 2, 0);
    });
    const cmap = new Uint8Array(12 + sub.byteLength);
    const cv = new DataView(cmap.buffer);
    cv.setUint16(0, 0); cv.setUint16(2, 1); cv.setUint16(4, 3); cv.setUint16(6, 1); cv.setUint32(8, 12);
    cmap.set(new Uint8Array(sub.buffer), 12);
    // The font again, with the new map in place of the old one and every table's
    // checksum and offset recomputed.
    const bodies = tables.map(t => ({ tag: t.tag, data: t.tag === 'cmap' ? cmap : font.subarray(t.offset, t.offset + t.length) }));
    const headerLen = 12 + numTables * 16;
    let total = headerLen;
    for (const b of bodies) total += (b.data.length + 3) & ~3;
    const res = new Uint8Array(total), rv = new DataView(res.buffer);
    res.set(font.subarray(0, 12), 0);
    const sum = (u8, off, len) => { let s = 0; for (let i = 0; i < len; i += 4) s = (s + ((u8[off + i] << 24) | ((u8[off + i + 1] || 0) << 16) | ((u8[off + i + 2] || 0) << 8) | (u8[off + i + 3] || 0))) >>> 0; return s; };
    let at = headerLen, headAt = -1;
    bodies.forEach((b, i) => {
      res.set(b.data, at);
      if (b.tag === 'head') { headAt = at; rv.setUint32(at + 8, 0); }
      const o = 12 + i * 16;
      for (let k = 0; k < 4; k++) res[o + k] = b.tag.charCodeAt(k);
      rv.setUint32(o + 4, sum(res, at, (b.data.length + 3) & ~3));
      rv.setUint32(o + 8, at);
      rv.setUint32(o + 12, b.data.length);
      at += (b.data.length + 3) & ~3;
    });
    if (headAt >= 0) rv.setUint32(headAt + 8, (0xB1B0AFBA - sum(res, 0, res.length)) >>> 0);
    return res;
  }
  function fontFaceCSS(faces) {
    return [...faces.values()].map(f => `@font-face{font-family:"${f.family}";src:${f.css};font-weight:${f.weight};font-style:${f.italic ? 'italic' : 'normal'}}`).join('\n');
  }

  function fontInfo(page, tc, fontName, faces) {
    let fo = null;
    try { if (page.commonObjs.has(fontName)) fo = page.commonObjs.get(fontName); } catch (_) {}
    const raw = (fo && fo.name) || '';
    const generic = ((tc.styles[fontName] || {}).fontFamily || 'sans-serif').replace(/['"]/g, '');
    const n = raw.replace(/^[A-Z]{6}\+/, '');
    const [baseRaw, ...rest] = n.split(/[-,]/);
    const styleWord = rest.join(' ');
    let base = (baseRaw || '').replace(/(PSMT|PS|MT)$/, '').replace(/[^A-Za-z0-9 ]/g, '');
    const spaced = base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2');
    const all = n + ' ' + styleWord;
    let weight = 400;
    if (/black|heavy/i.test(all) || (fo && fo.black)) weight = 900;
    else if (/extrabold|ultrabold/i.test(all)) weight = 800;
    else if (/bold/i.test(all) || (fo && fo.bold)) weight = /semi|demi/i.test(all) ? 600 : 700;
    else if (/semi|demi/i.test(all)) weight = 600;
    else if (/medium/i.test(all)) weight = 500;
    else if (/light/i.test(all)) weight = 300;
    const italic = /italic|oblique/i.test(all) || !!(fo && fo.italic);
    const fams = [];
    const own = embedFont(fo, faces, base, weight, italic);
    if (own) fams.push(own);
    if (/light/i.test(styleWord) && weight <= 300) fams.push(spaced + ' Light');
    if (spaced) fams.push(spaced);
    if (base && base !== spaced) fams.push(base);
    if (/arial|helvetica/i.test(base)) fams.push('Arial', 'Helvetica');
    if (/times/i.test(base)) fams.push('Times New Roman', 'Times');
    const family = [...new Set(fams)].map(f => `"${f}"`).concat(generic).join(', ');
    return { family, weight, italic };
  }

  const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

  // Text colour and the colour behind it, read off the rendered page: the most common
  // colour in the box is the background, the pixels farthest from it are the ink.
  function sampleColors(img, S, x, top, w, h) {
    const W = img.width, H = img.height, d = img.data;
    const x0 = Math.max(0, Math.floor(x * S)), x1 = Math.min(W - 1, Math.ceil((x + w) * S));
    const y0 = Math.max(0, Math.floor(top * S)), y1 = Math.min(H - 1, Math.ceil((top + h) * S));
    if (x1 <= x0 || y1 <= y0) return { color: '#000000', bg: null };
    const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 3000)));
    const hist = new Map(), px = [];
    for (let y = y0; y <= y1; y += step) for (let xx = x0; xx <= x1; xx += step) {
      const i = (y * W + xx) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      px.push(r, g, b);
      const k = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    let bk = 0, bc = -1;
    for (const [k, c] of hist) if (c > bc) { bc = c; bk = k; }
    const br = ((bk >> 8) & 15) * 16 + 8, bg = ((bk >> 4) & 15) * 16 + 8, bb = (bk & 15) * 16 + 8;
    let maxD = 0;
    const dist = [];
    for (let i = 0; i < px.length; i += 3) {
      const dd = Math.abs(px[i] - br) + Math.abs(px[i + 1] - bg) + Math.abs(px[i + 2] - bb);
      dist.push(dd); if (dd > maxD) maxD = dd;
    }
    let sr = 0, sg = 0, sb = 0, n = 0;
    if (maxD >= 60) {
      for (let i = 0, j = 0; i < px.length; i += 3, j++) if (dist[j] >= maxD * 0.7) { sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; n++; }
    }
    const color = n ? hex(sr / n, sg / n, sb / n) : '#000000';
    const white = (765 - br - bg - bb) < 45;
    return { color, bg: white ? null : hex(br, bg, bb) };
  }

  // Thin horizontal lines drawn on the page (rules under headings, dividers).
  function findRules(img, S) {
    const W = img.width, H = img.height, d = img.data, minRun = W * 0.1;
    const rows = [];
    for (let y = 0; y < H; y++) {
      let start = -1;
      for (let x = 0; x <= W; x++) {
        let ink = false;
        if (x < W) { const i = (y * W + x) * 4; ink = (765 - d[i] - d[i + 1] - d[i + 2]) > 45 && d[i + 3] > 0; }
        if (ink && start < 0) start = x;
        else if (!ink && start >= 0) {
          if (x - start >= minRun) {
            const i = (y * W + ((start + x) >> 1)) * 4;
            rows.push({ y, x1: start, x2: x, c: hex(d[i], d[i + 1], d[i + 2]), ink: 765 - d[i] - d[i + 1] - d[i + 2] });
          }
          start = -1;
        }
      }
    }
    const rules = [];
    for (const r of rows) {
      const g = rules.find(q => q.y2 === r.y - 1 && Math.abs(q.x1 - r.x1) < 3 * S && Math.abs(q.x2 - r.x2) < 3 * S);
      if (g) { g.y2 = r.y; g.n++; if (r.ink > g.ink) { g.ink = r.ink; g.c = r.c; } }
      else rules.push({ y1: r.y, y2: r.y, x1: r.x1, x2: r.x2, c: r.c, ink: r.ink, n: 1 });
    }
    return rules
      .map(q => ({ y: q.y1 / S, h: (q.y2 - q.y1 + 1) / S, x1: q.x1 / S, x2: q.x2 / S, color: q.c }))
      .filter(q => q.h <= 5); // thicker bands are filled boxes, not rules
  }

  // Solid areas of one colour: header banners, sidebars, shaded bars behind headings.
  // Found on a one-point grid of the rendered page; text sitting on an area takes the
  // area's colour first, so its letters do not cut holes in it.
  function findBoxes(img, S, items) {
    const W = img.width, d = img.data;
    const gw = Math.floor(img.width / S), gh = Math.floor(img.height / S);
    const q = new Int32Array(gw * gh).fill(-1);
    const key = (r, g, b) => (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = ((y * S + (S >> 1)) * W + (x * S + (S >> 1))) * 4;
      if (765 - d[i] - d[i + 1] - d[i + 2] < 60) continue;          // paper
      q[y * gw + x] = key(d[i], d[i + 1], d[i + 2]);
    }
    for (const it of items) {
      if (!it.bg) continue;
      const k = key(parseInt(it.bg.slice(1, 3), 16), parseInt(it.bg.slice(3, 5), 16), parseInt(it.bg.slice(5, 7), 16));
      const x0 = Math.max(0, Math.floor(it.x - 1)), x1 = Math.min(gw - 1, Math.ceil(it.x + it.w + 1));
      const y0 = Math.max(0, Math.floor(it.y - it.size)), y1 = Math.min(gh - 1, Math.ceil(it.y + it.size * 0.3));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) q[y * gw + x] = k;
    }
    const near = (a, b) => a === b || (Math.abs((a >> 8) - (b >> 8)) <= 1 && Math.abs(((a >> 4) & 15) - ((b >> 4) & 15)) <= 1 && Math.abs((a & 15) - (b & 15)) <= 1);
    const seen = new Uint8Array(gw * gh), boxes = [];
    for (let s = 0; s < q.length; s++) {
      if (q[s] < 0 || seen[s]) continue;
      const k = q[s];
      let x1 = gw, y1 = gh, x2 = -1, y2 = -1, n = 0;
      const stack = [s]; seen[s] = 1;
      while (stack.length) {
        const c = stack.pop(), cx = c % gw, cy = (c - cx) / gw;
        n++;
        if (cx < x1) x1 = cx; if (cx > x2) x2 = cx; if (cy < y1) y1 = cy; if (cy > y2) y2 = cy;
        for (const nb of [c - 1, c + 1, c - gw, c + gw]) {
          if (nb < 0 || nb >= q.length || seen[nb] || q[nb] < 0) continue;
          if ((nb === c - 1 && cx === 0) || (nb === c + 1 && cx === gw - 1)) continue;
          if (!near(q[nb], k)) continue;
          seen[nb] = 1; stack.push(nb);
        }
      }
      const bw = x2 - x1 + 1, bh = y2 - y1 + 1;
      if (n >= 1200 && bh >= 12 && bw >= 40 && n / (bw * bh) >= 0.6) {
        boxes.push({ x1, y1, x2: x2 + 1, y2: y2 + 1, color: hex(((k >> 8) & 15) * 16 + 8, ((k >> 4) & 15) * 16 + 8, (k & 15) * 16 + 8) });
      }
    }
    return boxes;
  }
  const inBox = (b, x1, y1, x2, y2, pad = 1) => x1 >= b.x1 - pad && x2 <= b.x2 + pad && y1 >= b.y1 - pad && y2 <= b.y2 + pad;

  // The graphics at the top of the first page — a banner with its decoration, a
  // photo, a logo — kept exactly as drawn, as one picture behind the text, with the
  // text itself taken out of it (the live text is laid back over it).
  function headerPicture(pg, boxes, items) {
    const top = boxes.filter(b => b.y1 < 60 && b.y2 - b.y1 < pg.H * 0.5);
    if (!top.length) return null;
    let bottom = Math.max(...top.map(b => b.y2));
    for (const b of boxes) if (b.y1 < bottom && b.y2 - b.y1 < pg.H * 0.5) bottom = Math.max(bottom, b.y2);
    const { img, S } = pg;
    const c = document.createElement('canvas');
    c.width = img.width; c.height = Math.ceil(bottom * S);
    const ctx = c.getContext('2d');
    ctx.putImageData(img, 0, 0, 0, 0, img.width, c.height);
    // Each piece of text is painted over with the exact colour just beside it (a
    // rounded colour would leave a faint box around every line).
    const d = img.data, at = (x, y) => {
      const px = Math.max(0, Math.min(img.width - 1, Math.round(x * S))), py = Math.max(0, Math.min(img.height - 1, Math.round(y * S)));
      const i = (py * img.width + px) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    };
    for (const it of items) {
      if (it.y - it.size > bottom) continue;
      const ys = it.y - it.size * 0.4;
      const around = [at(it.x - 2.5, ys), at(it.x + it.w + 2.5, ys), at(it.x + it.w / 2, it.y - it.size * 1.05), at(it.x + it.w / 2, it.y + it.size * 0.35)];
      // The most common of the four: whatever the text sits on.
      const pick = around.map(c => c.join(',')).sort((a, b) => around.filter(c => c.join(',') === b).length - around.filter(c => c.join(',') === a).length)[0];
      ctx.fillStyle = `rgb(${pick})`;
      ctx.fillRect((it.x - 1) * S, (it.y - it.size * 0.95) * S, (it.w + 2) * S, it.size * 1.3 * S);
    }
    const url = c.toDataURL('image/png');
    c.width = c.height = 0;
    return { url, width: pg.W, height: bottom };
  }

  async function pdfItems(pdf, faces) {
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const S = 2, cvp = page.getViewport({ scale: S });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(cvp.width); canvas.height = Math.ceil(cvp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: cvp }).promise;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const tc = await page.getTextContent();
      let links = [];
      try {
        links = (await page.getAnnotations()).filter(a => a.subtype === 'Link' && a.url && /^(https?:|mailto:)/i.test(a.url)).map(a => {
          const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
          return { url: a.url, x1: Math.min(x1, x2), x2: Math.max(x1, x2), y1: Math.min(y1, y2), y2: Math.max(y1, y2) };
        });
      } catch (_) {}
      const fonts = {};
      const items = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const t = pdfjsLib.Util.transform(vp.transform, it.transform);
        if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue; // rotated text
        const size = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || it.height;
        if (size < 2) continue;
        const x = t[4], y = t[5], w = it.width;
        const f = fonts[it.fontName] || (fonts[it.fontName] = fontInfo(page, tc, it.fontName, faces));
        const col = sampleColors(img, S, x, y - size * 0.8, Math.max(w, size * 0.3), size);
        const cx = x + w / 2, cy = y - size * 0.3;
        const link = links.find(l => cx >= l.x1 && cx <= l.x2 && cy >= l.y1 - 2 && cy <= l.y2 + 2);
        items.push({ str: fixChars(it.str), x, y, w, size, font: f, color: col.color, bg: col.bg, url: link ? link.url : '' });
      }
      // A banner's rows are long runs of colour too; only lines outside solid areas
      // are rules.
      const boxes = findBoxes(img, S, items);
      const rules = findRules(img, S).filter(r => !boxes.some(b => inBox(b, r.x1, r.y, r.x2, r.y + r.h, 2)));
      pages.push({ W: vp.width, H: vp.height, items, rules, boxes, img, S });
      canvas.width = canvas.height = 0;
    }
    return pages;
  }

  const styleKey = it => `${it.font.family}|${it.font.weight}|${it.font.italic}|${r1(it.size)}|${it.color}|${it.url}|${it.underline ? 1 : 0}`;

  // Items on one baseline become a line; big gaps split it into segments (a title on
  // the left and its dates on the right, for example).
  function buildLines(items) {
    const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const ln = lines.length ? lines[lines.length - 1] : null;
      if (ln && Math.abs(it.y - ln.y) <= 0.45 * Math.max(it.size, ln.size)) { ln.items.push(it); ln.size = Math.max(ln.size, it.size); }
      else lines.push({ y: it.y, size: it.size, items: [it] });
    }
    for (const ln of lines) {
      ln.items.sort((a, b) => a.x - b.x);
      const segs = [];
      for (const it of ln.items) {
        const sg = segs[segs.length - 1];
        const gap = sg ? it.x - sg.x1 : 0;
        if (sg && gap < Math.max(2.2 * it.size, 18)) {
          const lr = sg.runs[sg.runs.length - 1];
          const needSpace = gap > it.size * 0.12 && !/\s$/.test(lr.text) && !/^\s/.test(it.str);
          const text = (needSpace ? ' ' : '') + it.str;
          if (styleKey(lr.it) === styleKey(it)) lr.text += text;
          else { if (needSpace) lr.text += ' '; sg.runs.push({ it, text: it.str }); }
          sg.x1 = Math.max(sg.x1, it.x + it.w);
        } else segs.push({ x: it.x, x1: it.x + it.w, runs: [{ it, text: it.str }] });
      }
      ln.segs = segs;
      ln.x0 = segs[0].x; ln.x1 = segs[segs.length - 1].x1;
      ln.text = segs.map(s => s.runs.map(r => r.text).join('')).join(' ');
      // A bullet drawn as its own glyph, or as the first character of the line.
      const f = segs[0].runs[0];
      const m = f.text.match(/^\s*([•●▪■◦○‣➢➤►▸✓✔❖➔\-–—*·])(\s+|$)/);
      if (m && (segs[0].runs.length > 1 || f.text.length > m[0].length || segs.length > 1)) {
        ln.bullet = { ch: m[1], x: f.it.x, it: f.it };
        f.text = f.text.slice(m[0].length);
        if (!f.text) {
          segs[0].runs.shift();
          if (!segs[0].runs.length) { segs.shift(); if (segs[0]) segs[0].x = segs[0].runs[0].it.x; }
        }
        if (!segs.length) { ln.bullet = null; continue; }
        const nx = segs[0].runs[0].it;
        ln.textX = f.text ? f.it.x + f.it.size * 0.9 : nx.x;
        if (!f.text && segs[0].x !== nx.x) segs[0].x = nx.x;
        ln.x0 = ln.textX;
      } else if (m && BULLET_RE.test(f.text.trim()) && segs.length === 1 && segs[0].runs.length === 1) {
        // A lone bullet on its own line is decoration; drop it.
        ln.drop = true;
      }
      if (!ln.textX) ln.textX = ln.x0;
    }
    return lines.filter(l => !l.drop && l.segs.length);
  }

  // Bullets drawn as shapes (Chrome, many templates) are not text: look for a small
  // mark just left of where the line's text starts.
  function shapeBullets(lines, pg) {
    const { img, S, items } = pg, W = img.width, d = img.data;
    for (const ln of lines) {
      if (ln.bullet) continue;
      const sz = ln.size;
      const xa = Math.max(0, (ln.x0 - 2.4 * sz) * S) | 0, xb = Math.max(0, (ln.x0 - 0.12 * sz) * S) | 0;
      const ya = Math.max(0, (ln.y - 0.8 * sz) * S) | 0, yb = Math.min(img.height - 1, (ln.y + 0.1 * sz) * S) | 0;
      if (xb <= xa || yb <= ya) continue;
      let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1, n = 0, sr = 0, sg = 0, sb = 0;
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        const i = (y * W + x) * 4;
        if (765 - d[i] - d[i + 1] - d[i + 2] > 120) {
          n++; sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
          if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        }
      }
      if (!n) continue;
      const bw = (bx1 - bx0 + 1) / S, bh = (by1 - by0 + 1) / S;
      if (bw > 0.6 * sz || bh > 0.6 * sz || bw < 0.1 * sz || bh < 0.1 * sz || bw > 2.2 * bh || bh > 2.2 * bw) continue;
      const L = bx0 / S, T = by0 / S;
      if (items.some(it => it.x < L + bw && it.x + it.w > L && it.y - it.size * 0.8 < T + bh && it.y > T)) continue;
      const fill = n / ((bx1 - bx0 + 1) * (by1 - by0 + 1));
      const ch = fill > 0.9 ? '▪' : fill < 0.5 ? '◦' : '•';
      const f = ln.segs[0].runs[0].it;
      ln.bullet = { ch, x: L - 0.1 * sz, it: { ...f, color: hex(sr / n, sg / n, sb / n) } };
      ln.textX = ln.x0;
    }
  }

  // A thin line right under text is that text's underline, not a rule.
  function takeUnderlines(lines, rules) {
    return rules.filter(r => {
      for (const ln of lines) {
        if (r.y < ln.y - 0.05 * ln.size || r.y > ln.y + 0.4 * ln.size) continue;
        const its = ln.items.filter(it => it.x < r.x2 && it.x + it.w > r.x1);
        if (!its.length) continue;
        const a = Math.min(...its.map(i => i.x)), b = Math.max(...its.map(i => i.x + i.w));
        if (r.x1 >= a - 3 && r.x2 <= b + 3) {
          its.forEach(i => { i.underline = true; });
          return false;
        }
      }
      return true;
    });
  }

  // A sidebar layout has a vertical band no text crosses, with text on both sides of
  // it at the same heights.
  function findGutter(page) {
    const W = Math.ceil(page.W), its = page.items;
    if (its.length < 12) return null;
    const cross = new Int32Array(W + 1);
    for (const it of its) for (let x = Math.max(0, Math.floor(it.x)); x <= Math.min(W, Math.ceil(it.x + it.w)); x++) cross[x]++;
    for (let allow = 0; allow <= 3; allow++) {
      let best = null, s = -1;
      for (let x = Math.floor(W * 0.15); x <= Math.ceil(W * 0.85); x++) {
        if (cross[x] <= allow) { if (s < 0) s = x; }
        else if (s >= 0) { if (!best || x - s > best.b - best.a) best = { a: s, b: x }; s = -1; }
      }
      if (!best || best.b - best.a < 12) continue;
      const L = its.filter(i => i.x + i.w <= best.a), R = its.filter(i => i.x >= best.b);
      const chars = a => a.reduce((n, i) => n + i.str.length, 0), total = chars(its);
      if (chars(L) < total * 0.12 || chars(R) < total * 0.12) continue;
      const span = a => [Math.min(...a.map(i => i.y)), Math.max(...a.map(i => i.y))];
      const [la, lb] = span(L), [ra, rb] = span(R);
      const overlap = Math.min(lb, rb) - Math.max(la, ra);
      if (overlap < 0.4 * Math.min(lb - la, rb - ra)) continue;
      const Llines = new Set(L.map(i => Math.round(i.y))).size, Rlines = new Set(R.map(i => Math.round(i.y))).size;
      if (Llines < 3 || Rlines < 3) continue;
      return best;
    }
    return null;
  }

  const isPageNumber = (ln, H) => (ln.y > H * 0.93 || ln.y < H * 0.05) && /^(page\s*)?\d{1,3}(\s*(of|\/)\s*\d{1,3})?$/i.test(ln.text.trim());

  // Lines that wrapped become one paragraph, so rewritten text reflows.
  function buildParagraphs(lines, rl, rr, bodySize) {
    const width = rr - rl, center = (rl + rr) / 2;
    // The tightest spacing seen for each size is the spacing of wrapped lines; a
    // bigger gap means a new paragraph.
    const minGap = {};
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1], b = lines[i], g = b.y - a.y;
      if (Math.abs(a.size - b.size) < 0.6 && g > a.size * 0.8) { const k = r1(a.size); minGap[k] = Math.min(minGap[k] || 1e9, g); }
    }
    // A line only wrapped if the next line's first word would not have fitted.
    const wrapped = (last, ln) => {
      const first = ln.text.trim().split(/\s+/)[0] || '';
      const perChar = (ln.x1 - ln.x0) / Math.max(1, ln.text.length);
      return last.x1 + perChar * (first.length + 1) > rr - 1;
    };
    const align = ln => {
      if (ln.segs.length > 1 || ln.bullet) return 'left';
      const mid = (ln.x0 + ln.x1) / 2;
      // Centred means clearly shorter than the text width with even space either side:
      // a nearly full line's midpoint is near the centre too.
      if (Math.abs(mid - center) < Math.max(5, width * 0.02) && ln.x0 - rl > 12 && ln.x1 - ln.x0 < width * 0.85) return 'center';
      if (Math.abs(ln.x1 - rr) < 3 && ln.x0 > center) return 'right';
      return 'left';
    };
    const out = [];
    for (const ln of lines) {
      ln.align = align(ln);
      const P = out[out.length - 1];
      const last = P && P.lines[P.lines.length - 1];
      const firstRun = ln.segs[0].runs[0].it;
      const merge = P && P.kind === 'p' && ln.segs.length === 1 && !ln.bullet && ln.align === 'left' && P.align === 'left' &&
        Math.abs(ln.size - last.size) < 0.6 &&
        ln.y - last.y > last.size * 0.85 && ln.y - last.y < last.size * 1.75 &&
        ln.y - last.y <= (minGap[r1(last.size)] || 1e9) * 1.08 + 0.3 &&
        Math.abs(ln.x0 - P.textX) < 2.5 &&
        // A line starting in lower case continues the one before it, however early
        // that one broke (a long next word wraps a line well before the margin).
        (wrapped(last, ln) || /^[a-z(]/.test(ln.text.trim())) &&
        styleKey(firstRun).split('|')[1] === styleKey(last.segs[0].runs[last.segs[0].runs.length - 1].it).split('|')[1];
      if (merge) { P.lines.push(ln); continue; }
      out.push({ kind: ln.segs.length > 1 ? 'row' : 'p', lines: [ln], bullet: ln.bullet || null, x0: ln.bullet ? ln.bullet.x : ln.x0, textX: ln.textX, align: ln.align, y: ln.y });
    }
    for (const P of out) {
      const ln = P.lines[0];
      P.size = ln.size;
      if (P.lines.length > 1) {
        const gaps = []; for (let i = 1; i < P.lines.length; i++) gaps.push(P.lines[i].y - P.lines[i - 1].y);
        P.lh = Math.max(1, Math.min(1.8, gaps.reduce((a, b) => a + b, 0) / gaps.length / P.size));
      } else P.lh = 1.2;
      const words = ln.text.trim().split(/\s+/).length;
      const runs = ln.segs[0].runs;
      const bold = runs.every(r => r.it.font.weight >= 600);
      const caps = /[A-Z]/.test(ln.text) && ln.text === ln.text.toUpperCase();
      P.heading = P.kind === 'p' && P.lines.length === 1 && !P.bullet && words <= 6 && (bold || caps || P.size > bodySize + 0.8);
    }
    return out;
  }

  function runHTML(run, baseSize) {
    const it = run.it, f = it.font;
    let st = `font-family:${esc(f.family)};`;
    if (f.weight !== 400) st += `font-weight:${f.weight};`;
    if (f.italic) st += 'font-style:italic;';
    if (Math.abs(it.size - baseSize) > 0.25) st += `font-size:${r1(it.size)}pt;`;
    if (it.color !== '#000000') st += `color:${it.color};`;
    if (it.underline) st += 'text-decoration:underline;';
    const inner = `<span class="r" style="${st}">${esc(run.text)}</span>`;
    return it.url ? `<a href="${esc(it.url)}">${inner}</a>` : inner;
  }

  // Where a block's box starts and ends, from its baselines, so the gaps between
  // blocks match the original page.
  const blockTop = P => P.lines[0].y - P.size * 0.8 - (P.lh - 1) * P.size / 2;
  const blockBottom = P => { const l = P.lines[P.lines.length - 1]; return l.y + P.size * 0.25 + (P.lh - 1) * P.size / 2; };

  // `boxes` are the page's solid areas; a block sitting in one gets the area's colour
  // across the area's full width, and the gaps between blocks in the same area are
  // filled in, so a shaded bar or panel stays one piece. The first block may start
  // above `startY` (a negative margin), where the page's text starts higher than its
  // later pages' margin.
  function regionHTML(els, rl, rr, startY, ids, boxes = [], gapFor = null) {
    let html = '', prev = startY;
    // A block that opened a page in the original may land mid-page now; it gets the
    // gap such a block has elsewhere in the resume instead of "none".
    if (gapFor && els[0] && els[0].kind !== 'rule') prev = blockTop(els[0]) - gapFor(els[0]);
    const boxOf = E => E.kind === 'rule' ? null : boxes.find(b => inBox(b, E.lines[0].x0 - 1, blockTop(E), E.lines[0].x1, E.lines[0].y, 3)) || null;
    const where = els.map(boxOf);
    els.forEach((E, ei) => {
      if (E.kind === 'rule') {
        const mt = Math.max(0, E.y - prev);
        const ml = Math.max(0, E.x1 - rl), w = Math.min(rr - rl - ml, E.x2 - E.x1);
        html += `<div class="rule" style="margin-top:${r1(mt)}pt;margin-left:${r1(ml)}pt;width:${r1(w)}pt;border-top:${r1(E.h)}pt solid ${E.color}"></div>`;
        prev = E.y + E.h;
        return;
      }
      const P = E, top = blockTop(P);
      let mt = ei === 0 ? top - prev : Math.max(0, top - prev);
      const first = P.lines[0].segs[0].runs[0].it;
      const bg = P.lines.every(l => l.segs.every(s => s.runs.every(r => r.it.bg === first.bg))) ? first.bg : null;
      const box = where[ei], sameAsPrev = box && ei > 0 && where[ei - 1] === box, sameAsNext = box && where[ei + 1] === box;
      let boxStyle = '', padLeft = null;
      if (box) {
        // In a solid area: its colour, its width, and no gap in it.
        const padTop = sameAsPrev ? Math.max(0, top - prev) : Math.max(0, top - box.y1);
        if (!sameAsPrev) mt = Math.max(0, box.y1 - prev); else mt = 0;
        const padBottom = sameAsNext ? 0 : Math.max(0, box.y2 - blockBottom(P));
        boxStyle = `background:${box.color};box-sizing:border-box;margin-left:${r1(Math.max(0, box.x1 - rl))}pt;width:${r1(box.x2 - Math.max(box.x1, rl))}pt;padding-top:${r1(padTop)}pt;padding-bottom:${r1(padBottom)}pt;`;
        padLeft = Math.max(0, P.textX - Math.max(box.x1, rl));
      }
      let st = `margin-top:${r1(mt)}pt;font-size:${r1(P.size)}pt;line-height:${P.lh.toFixed(2)};` + boxStyle;
      if (bg && !box) st += `background:${bg};`;
      const cls = ['b'];
      if (P.heading) cls.push('hd');
      const id = ids.n++;
      if (P.kind === 'row') {
        cls.push('row');
        const segs = P.lines[0].segs;
        const left = box ? Math.max(box.x1, rl) : rl, right = box ? Math.min(box.x2, rr) : rr;
        let inner = '', px = left;
        segs.forEach((sg, i) => {
          let ss = '';
          if (i === 0) ss = `padding-left:${r1(Math.max(0, sg.x - left))}pt;`;
          else if (i === segs.length - 1 && Math.abs(sg.x1 - right) < Math.max(6, P.size)) ss = `margin-left:auto;padding-left:8pt;${box ? `padding-right:${r1(Math.max(0, box.x2 - sg.x1))}pt;` : ''}`;
          else ss = `margin-left:${r1(Math.max(6, sg.x - px))}pt;`;
          if (sg.runs[0]) sg.runs[0].text = sg.runs[0].text.replace(/^\s+/, '');
          inner += `<span class="sg" style="${ss}">${sg.runs.map(r => runHTML(r, P.size)).join('')}</span>`;
          px = sg.x1;
        });
        html += `<div class="${cls.join(' ')}" data-b="${id}" style="${st}">${inner}</div>`;
      } else {
        const runs = [];
        P.lines.forEach((ln, i) => {
          ln.segs[0].runs.forEach((r, j) => {
            let text = r.text;
            if (i > 0 && j === 0) {
              const prevRun = runs[runs.length - 1];
              if (prevRun && /-$/.test(prevRun.text) && /^[a-z]/.test(text)) { /* hyphenated word: join */ }
              else text = ' ' + text.replace(/^\s+/, '');
            }
            const lr = runs[runs.length - 1];
            if (lr && styleKey(lr.it) === styleKey(r.it)) lr.text += text; else runs.push({ it: r.it, text });
          });
        });
        if (runs[0]) runs[0].text = runs[0].text.replace(/^\s+/, '');
        if (P.align !== 'left') st += `text-align:${P.align};`;
        else st += `padding-left:${r1(padLeft !== null ? padLeft : Math.max(0, P.textX - rl))}pt;`;
        let bul = '';
        if (P.bullet) {
          cls.push('bl');
          const hang = Math.max(4, P.textX - P.bullet.x);
          const b = P.bullet.it;
          bul = `<span class="bul" data-fixed style="width:${r1(hang)}pt;margin-left:-${r1(hang)}pt;font-family:${esc(b.font.family)};font-size:${r1(b.size)}pt;color:${b.color}">${esc(P.bullet.ch)}</span>`;
        }
        html += `<p class="${cls.join(' ')}" data-b="${id}" style="${st}">${bul}${runs.map(r => runHTML(r, P.size)).join('')}</p>`;
      }
      prev = box && !sameAsNext ? Math.max(blockBottom(P), box.y2) : blockBottom(P);
    });
    return html;
  }

  function withRules(paras, rules) {
    return [...paras, ...rules.map(r => ({ kind: 'rule', ...r }))].sort((a, b) => (a.kind === 'rule' ? a.y : blockTop(a)) - (b.kind === 'rule' ? b.y : blockTop(b)));
  }

  async function fromPDF(buf) {
    // fontExtraProperties keeps each font's data after it is loaded (pdf.js drops it
    // otherwise), which is what lets the rebuilt page use the resume's own fonts.
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)), fontExtraProperties: true }).promise;
    const faces = new Map();
    const pages = await pdfItems(pdf, faces);
    const all = pages.flatMap(p => p.items);
    if (all.length < 5) throw new Error('This PDF has no selectable text (it may be a scan), so its layout cannot be rebuilt.');
    const W = pages[0].W, H = pages[0].H;
    // Body size: the size most characters are set in.
    const bySize = {};
    for (const it of all) bySize[r1(it.size)] = (bySize[r1(it.size)] || 0) + it.str.length;
    const bodySize = +Object.entries(bySize).sort((a, b) => b[1] - a[1])[0][0];

    const L = Math.max(12, Math.min(...all.map(i => i.x)));
    const R = Math.max(12, W - Math.max(...all.map(i => i.x + i.w)));
    const textTop = pg => Math.min(...pg.items.map(i => i.y - i.size * 0.85));
    // The page's margins become padding repeated on every page (so graphics can reach
    // the paper's edge); the first page may start higher than the rest, which its
    // first block's negative margin takes care of.
    const T1 = Math.max(6, textTop(pages[0]));
    const Tn = Math.max(18, Math.min(72, pages.length > 1 && pages[1].items.length ? textTop(pages[1]) : T1));
    const B = Math.max(24, Math.min(72, Tn));
    const rl = L, rr = W - R;

    // The first page's header graphics, kept as drawn; the text on them is laid back
    // over the picture, so nothing there takes a colour of its own.
    const hp = headerPicture(pages[0], pages[0].boxes, pages[0].items);
    if (hp) for (const it of pages[0].items) if (it.y - it.size < hp.height) it.bg = null;

    const ids = { n: 0 };
    let body = '';
    // The usual gap above each kind of block (a job's title row, a heading, a
    // paragraph), measured where blocks follow one another on the same page.
    const gaps = { row: [], hd: [], p: [] };
    const kindOf = P => P.kind === 'row' ? 'row' : P.heading ? 'hd' : 'p';
    const gapFor = P => { const g = gaps[kindOf(P)].slice().sort((a, b) => a - b); return g.length ? g[g.length >> 1] : P.size * 0.5; };
    pages.forEach((pg, pi) => {
      // Solid areas the text sits on, other than the header picture and full-height
      // sidebars (a column's colour is not a block's).
      const boxes = pg.boxes.filter(b => !(pi === 0 && hp && b.y1 < hp.height) && b.y2 - b.y1 < pg.H * 0.5);
      // Columns are separated before lines are built: a sidebar line and a main-column
      // line on the same baseline are two lines, not one.
      const g = findGutter(pg);
      const groups = g
        ? [['L', pg.items.filter(i => i.x + i.w <= g.a + 0.5)], ['R', pg.items.filter(i => i.x >= g.b - 0.5)],
          ['F', pg.items.filter(i => i.x < g.b - 0.5 && i.x + i.w > g.a + 0.5)]]
        : [['F', pg.items]];
      const lines = [];
      for (const [c, its] of groups) {
        const ls = buildLines(its).filter(l => !isPageNumber(l, pg.H));
        shapeBullets(ls, pg);
        ls.forEach(l => { l.col = c; lines.push(l); });
      }
      if (!lines.length) return;
      const rules = takeUnderlines(lines, pg.rules.filter(r => r.x2 > rl - 4 && r.x1 < rr + 4 && !(pi === 0 && hp && r.y < hp.height)));
      pg.img = null;
      const pageTop = Math.min(...lines.map(l => l.y - l.size * 0.85), ...rules.map(r => r.y));
      const startY = pi === 0 ? Tn : pageTop;
      if (!g) {
        const paras = buildParagraphs(lines, rl, rr, bodySize);
        const els = withRules(paras, rules);
        // Gaps are learnt as the pages go; the later pages' first block uses them.
        for (let i = 1; i < els.length; i++) if (els[i].kind !== 'rule' && els[i - 1].kind !== 'rule') gaps[kindOf(els[i])].push(Math.max(0, blockTop(els[i]) - blockBottom(els[i - 1])));
        body += regionHTML(els, rl, rr, startY, ids, boxes, pi > 0 ? gapFor : null);
        return;
      }
      // Lines that cross the gutter span the page; the rest belong to a column.
      const full = lines.filter(l => l.col === 'F'), colLines = lines.filter(l => l.col !== 'F');
      // The columns start where both sides have text; anything above that (a name
      // that happens to end before the gutter, say) belongs to the page header.
      const topOf = c => Math.min(...colLines.filter(l => l.col === c).map(l => l.y - l.size * 0.85));
      const colTop = Math.max(topOf('L'), topOf('R')) - 2;
      for (let i = colLines.length - 1; i >= 0; i--) if (colLines[i].y - colLines[i].size * 0.85 < colTop) { full.push(colLines[i]); colLines.splice(i, 1); }
      const colBottom = Math.max(...colLines.map(l => l.y));
      const top = full.filter(l => l.y < colTop).sort((a, b) => a.y - b.y), bottom = full.filter(l => l.y > colBottom);
      const inside = full.filter(l => l.y >= colTop && l.y <= colBottom);
      // A rare full-width line inside the column zone goes to the column it starts in.
      for (const ln of inside) colLines.push({ ...ln, col: ln.x0 < g.a ? 'L' : 'R' });
      const ruleCol = r => (r.x2 <= g.a + 4 ? 'L' : r.x1 >= g.b - 4 ? 'R' : 'F');
      let prev = startY;
      if (top.length) {
        const rTop = rules.filter(r => ruleCol(r) === 'F' && r.y < colTop);
        const paras = buildParagraphs(top, rl, rr, bodySize);
        body += regionHTML(withRules(paras, rTop), rl, rr, startY, ids, boxes);
        const lastTop = Math.max(...paras.map(blockBottom), ...rTop.map(r => r.y + r.h));
        prev = lastTop;
      }
      const lw = g.a - rl, rw = rr - g.b, gap = g.b - g.a;
      const col = (c, cl, cr) => {
        const ls = colLines.filter(l => l.col === c).sort((a, b) => a.y - b.y);
        const paras = buildParagraphs(ls, cl, cr, bodySize);
        return regionHTML(withRules(paras, rules.filter(r => ruleCol(r) === c)), cl, cr, prev, ids, boxes);
      };
      body += `<div class="cols" style="grid-template-columns:${r1(lw)}pt ${r1(rw)}pt;column-gap:${r1(gap)}pt"><div>${col('L', rl, g.a)}</div><div>${col('R', g.b, rr)}</div></div>`;
      if (bottom.length) {
        const rBot = rules.filter(r => ruleCol(r) === 'F' && r.y > colBottom);
        const paras = buildParagraphs(bottom, rl, rr, bodySize);
        body += regionHTML(withRules(paras, rBot), rl, rr, colBottom + 4, ids, boxes);
      }
    });

    const picture = hp ? `<img class="hdrpic" data-fixed alt="" src="${hp.url}" style="width:${r1(W)}pt;height:${r1(hp.height)}pt">` : '';
    const css = `${fontFaceCSS(faces)}
      ${BASE_CSS}
      @page{size:${r1(W)}pt ${r1(H)}pt;margin:0}
      html,body{margin:0}
      .pg{position:relative;z-index:0;box-sizing:border-box;width:${r1(W)}pt;font-size:${bodySize}pt;
        padding:${r1(Tn)}pt ${r1(R)}pt ${r1(B)}pt ${r1(L)}pt;-webkit-box-decoration-break:clone;box-decoration-break:clone}
      .hdrpic{position:absolute;left:0;top:0;z-index:-1;pointer-events:none;user-select:none}
      @media screen{.pg{min-height:${r1(H)}pt;margin:16px auto;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.25)}}
      @media print{html{background:none}}`;
    return { kind: 'pdf', html: docHTML(css, `<div class="pg">${picture}${body}</div>`), meta: { pages: pages.length, fonts: faces.size, header: !!hp, columns: pages.some(p => !!findGutter(p)) } };
  }

  /* ----------------------------------------------------------------- DOCX ---- */

  async function fromDOCX(buf) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', () => !!window.JSZip);
    await loadScript('https://cdn.jsdelivr.net/npm/docx-preview@0.3.5/dist/docx-preview.min.js', () => !!(window.docx && window.docx.renderAsync));
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;visibility:hidden';
    document.body.appendChild(host);
    try {
      await window.docx.renderAsync(buf, host, host, {
        className: 'docx', inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false,
        breakPages: true, ignoreLastRenderedPageBreak: true, experimental: true, trimXmlDeclaration: true,
        useBase64URL: true, renderHeaders: true, renderFooters: false, renderFootnotes: false, renderEndnotes: false,
      });
      await new Promise(r => setTimeout(r, 700));
      const sec = host.querySelector('section.docx');
      if (!sec) throw new Error('This Word file has no pages to show.');
      const pt = v => { const n = parseFloat(v) || 0; return /px$/.test(v) ? n * 0.75 : n; };
      const W = pt(sec.style.width) || 612, H = pt(sec.style.minHeight) || 792;
      const m = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map(k => pt(sec.style[k]) || 54);
      // Every paragraph, list item and table cell paragraph is a block.
      let n = 0;
      host.querySelectorAll('section.docx p').forEach(p => {
        if (!p.textContent.trim()) return;
        p.setAttribute('data-b', n++);
        p.classList.add('b');
        const words = p.textContent.trim().split(/\s+/).length;
        const heading = /heading|title/i.test(p.className) || (words <= 6 && [...p.querySelectorAll('span')].filter(s => s.textContent.trim()).every(s => {
          const w = getComputedStyle(s).fontWeight; return w === 'bold' || +w >= 600;
        }));
        if (heading) p.classList.add('hd');
        if (p.querySelector('.docx-tab-stop')) p.classList.add('row');
        const before = getComputedStyle(p, '::before').content;
        if (/list|bullet/i.test(p.className) || (before && before !== 'none' && before !== 'normal')) p.classList.add('bl');
      });
      host.querySelectorAll('.docx-tab-stop').forEach(t => t.setAttribute('data-fixed', ''));
      const styles = [...host.querySelectorAll('style')].map(s => s.outerHTML).join('\n');
      host.querySelectorAll('style').forEach(s => s.remove());
      const css = `${BASE_CSS}
        .row{display:block}
        @page{size:${r1(W)}pt ${r1(H)}pt;margin:${m.map(r1).join('pt ')}pt}
        @media print{
          html{background:none}
          .docx-wrapper{background:none!important;padding:0!important;display:block!important}
          .docx-wrapper>section.docx{width:auto!important;min-height:0!important;padding:0!important;margin:0!important;box-shadow:none!important}
          .docx-wrapper>section.docx+section.docx{break-before:page}
        }`;
      return { kind: 'docx', html: docHTML(css, host.innerHTML, styles), meta: { pages: Math.max(1, host.querySelectorAll('section.docx').length), columns: !!host.querySelector('section.docx table td + td p') } };
    } finally { host.remove(); }
  }

  /* ------------------------------------------------------------------ TXT ---- */

  function fromText(text) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    let body = '', n = 0;
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) { body += '<div style="height:6pt"></div>'; continue; }
      const caps = /[A-Z]/.test(t) && t === t.toUpperCase() && t.length < 40;
      const bm = t.match(/^([•●▪\-–*])\s+(.*)$/);
      if (caps) body += `<p class="b hd" data-b="${n++}" style="font-weight:700;font-size:11.5pt;margin-top:8pt;border-bottom:.8pt solid #555;padding-bottom:1pt">${esc(t)}</p>`;
      else if (bm) body += `<p class="b bl" data-b="${n++}" style="padding-left:14pt"><span class="bul" data-fixed style="width:11pt;margin-left:-11pt">•</span><span class="r">${esc(bm[2])}</span></p>`;
      else body += `<p class="b" data-b="${n++}"><span class="r">${esc(t)}</span></p>`;
    }
    const css = `${BASE_CSS}
      @page{size:612pt 792pt;margin:54pt}
      body{font-family:Calibri,Arial,sans-serif;font-size:10.5pt;line-height:1.3}
      @media screen{body{box-sizing:border-box;width:612pt;min-height:792pt;margin:16px auto;background:#fff;padding:54pt;box-shadow:0 2px 14px rgba(0,0,0,.25)}}
      @media print{html{background:none}}`;
    return { kind: 'txt', html: docHTML(css, body), meta: { pages: Math.max(1, Math.round(String(text).split(/\s+/).length / 500)), columns: false } };
  }

  function docHTML(css, body, extraHead = '') {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Resume</title>${extraHead}<style>${css}</style></head><body>${body}</body></html>`;
  }

  /* ------------------------------------------------------------ editing ---- */

  const norm = s => s.replace(/\s+/g, ' ');

  // The text nodes a block's words live in, minus bullets and tab stops.
  function textNodes(el) {
    const out = [], w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement.closest('[data-fixed]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    while (w.nextNode()) out.push(w.currentNode);
    return out;
  }

  function blockText(el) {
    if (el.classList.contains('row') && el.querySelector('.sg')) return [...el.querySelectorAll('.sg')].map(s => norm(s.textContent).trim()).join(' | ');
    return norm(textNodes(el).map(t => t.nodeValue).join('')).trim();
  }

  function blocks(doc) {
    return [...doc.querySelectorAll('[data-b]')].map(el => {
      const text = blockText(el);
      const words = text.split(/\s+/).filter(Boolean).length;
      const contact = /@|https?:|www\.|linkedin|\+?\d[\d\s().-]{7,}\d/i.test(text) && words <= 14;
      const dated = /\b(19|20)\d{2}\b/.test(text) && words <= 8;
      const editable = !el.classList.contains('row') && !el.classList.contains('hd') && !contact && !dated && words >= 4;
      return { id: +el.getAttribute('data-b'), text, editable, heading: el.classList.contains('hd'), bullet: el.classList.contains('bl') };
    });
  }

  // New text goes back into the block's own runs: runs whose text still opens (or
  // closes) the new text keep it and their styling; everything in between goes into
  // the first run that changed.
  function setBlockText(el, text) {
    const nodes = textNodes(el).filter(n => n.nodeValue.length);
    const N = norm(text).trim();
    if (!nodes.length) { el.appendChild(el.ownerDocument.createTextNode(N)); return; }
    const vals = nodes.map(n => norm(n.nodeValue));
    vals[0] = vals[0].replace(/^\s+/, '');
    let i = 0, pos = 0;
    while (i < nodes.length - 1 && vals[i].trim() && N.startsWith(vals[i], pos)) { pos += vals[i].length; i++; }
    let j = nodes.length - 1, end = N.length;
    while (j > i && vals[j].trim() && N.slice(0, end).endsWith(vals[j]) && end - vals[j].length >= pos) { end -= vals[j].length; j--; }
    for (let k = 0; k < nodes.length; k++) {
      if (k < i || k > j) nodes[k].nodeValue = vals[k];
      else if (k === i) nodes[k].nodeValue = N.slice(pos, end);
      else nodes[k].nodeValue = '';
    }
  }

  function apply(doc, edits) {
    const changed = [];
    for (const e of edits || []) {
      const el = doc.querySelector(`[data-b="${Number(e.id)}"]`);
      if (!el || typeof e.text !== 'string' || !e.text.trim()) continue;
      if (el.classList.contains('row') || el.classList.contains('hd')) continue;
      if (norm(e.text).trim() === blockText(el)) continue;
      setBlockText(el, e.text);
      el.classList.add('chg');
      changed.push(Number(e.id));
    }
    return changed;
  }

  // The document as it should be printed: no highlights, no editing state.
  function exportHTML(doc) {
    const d = doc.documentElement.cloneNode(true);
    d.style.removeProperty('zoom'); // preview-only fit to width
    if (!d.getAttribute('style')) d.removeAttribute('style');
    d.querySelectorAll('.chg').forEach(e => e.classList.remove('chg'));
    d.querySelectorAll('[contenteditable]').forEach(e => e.removeAttribute('contenteditable'));
    d.querySelectorAll('script').forEach(e => e.remove());
    const b = d.querySelector('body'); if (b) { b.removeAttribute('contenteditable'); b.removeAttribute('spellcheck'); }
    return '<!doctype html>' + d.outerHTML;
  }

  function plainText(doc) {
    return [...doc.querySelectorAll('[data-b]')].map(el => (el.classList.contains('bl') ? '• ' : '') + blockText(el).replace(/ \| /g, '  ')).join('\n');
  }

  async function build(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') return fromPDF(file.buf);
    if (ext === 'docx') return fromDOCX(file.buf);
    return fromText(file.text || new TextDecoder().decode(file.buf));
  }

  window.ResumeFormat = { build, fromText, blocks, apply, exportHTML, plainText, setBlockText };
})();
