/* Offerly — the ATS score.
 *
 * A fixed set of checks, the same ones ATS parsers and recruiters' screening tools
 * apply, each worth a set number of points. Nothing here is a model's opinion: the
 * same resume always gets the same score, a change moves it by a known amount, and
 * every lost point comes with the fix that wins it back. That is what lets the score
 * be recomputed as you edit, and lets "Fix my resume" show what it improved.
 *
 * score({ text, rawText, blocks, meta, tags }) ->
 *   { score, grade, categories: [{ id, label, max, got, checks: [...] }], fixes: [...] }
 *   text     the resume in reading order
 *   rawText  the text as the file's own text layer orders it (what a parser reads)
 *   blocks   the resume's paragraphs, from resumeformat.js: { id, text, heading, bullet, row }
 *   meta     { kind: 'pdf'|'docx'|'txt', pages, columns, fonts }
 *   tags     { roles, skills } the search runs on
 * A check is { id, label, max, got, status: 'pass'|'warn'|'fail', detail, fix,
 * fixable: 'auto'|'ai'|'you', blocks: [ids] } — `fixable` says who can fix it:
 * Offerly on its own, the AI rewrite, or only you (a number only you know).
 */
(function (root) {
  'use strict';

  // --- word lists ------------------------------------------------------------
  const ACTION = new Set(('accelerated achieved acquired adapted added addressed administered advised analysed analyzed '
    + 'architected assembled assessed audited authored automated balanced benchmarked boosted briefed brought budgeted '
    + 'built calculated captured centralized centralised chaired changed coached collaborated combined completed composed '
    + 'computed conceived condensed conducted configured consolidated constructed consulted contracted contributed controlled '
    + 'converted coordinated corrected counselled created cultivated cut debugged decided decreased defined delegated '
    + 'delivered demonstrated deployed designed detected determined developed devised diagnosed digitized directed discovered '
    + 'documented doubled drafted drove earned edited educated eliminated enabled encouraged engineered enhanced established '
    + 'estimated evaluated examined exceeded executed expanded expedited explored extended extracted fixed forecasted formalized '
    + 'formed founded gathered generated grew guided halved handled headed hired identified illustrated implemented improved '
    + 'increased influenced initiated inspected installed instituted instructed integrated interviewed introduced invented '
    + 'investigated joined launched led lifted lowered maintained managed mapped marketed mastered maximized measured mentored '
    + 'merged migrated minimized mobilized modelled modeled modernized modernised monitored motivated moved negotiated '
    + 'onboarded opened operated optimized optimised orchestrated organized organised overhauled oversaw owned partnered '
    + 'performed piloted pioneered planned prepared presented prevented prioritized processed produced programmed promoted '
    + 'proposed prototyped proved provided published purchased raised ran rebuilt recommended reconciled recruited redesigned '
    + 'reduced refactored refined registered regulated rehauled released remodelled renegotiated reorganized repaired replaced '
    + 'reported represented researched resolved restored restructured retained revamped reviewed revised rolled saved scaled '
    + 'scheduled scoped screened secured selected served set shaped shipped shortened simplified sold solved sourced sped '
    + 'standardized standardised started steered strengthened structured studied submitted succeeded supervised surpassed '
    + 'surveyed synthesized systematized tackled targeted taught tested tightened tracked trained transformed translated '
    + 'tripled troubleshot tuned turned uncovered unified upgraded used validated verified won wrote').split(' '));
  const WEAK_OPENER = /^(?:was\s+|were\s+)?(?:responsible\s+for|worked\s+on|working\s+on|helped|helping|assisted|assisting|involved\s+in|participated\s+in|duties\s+included|tasked\s+with|in\s+charge\s+of|did|made|handled|dealt\s+with|took\s+part)\b/i;
  const CLICHES = ['results-oriented', 'results oriented', 'results-driven', 'results driven', 'team player', 'team-driven',
    'hard-working', 'hardworking', 'hard working', 'go-getter', 'self-motivated', 'self-starter', 'self starter',
    'detail-oriented', 'detail oriented', 'dynamic individual', 'dynamic professional', 'synergy', 'think outside the box',
    'proven track record', 'excellent communication skills', 'strong communication skills', 'committed to excellence',
    'committed to quality excellence', 'passionate about', 'go-to person', 'rockstar', 'ninja', 'guru', 'best of breed',
    'value-add', 'strategic thinker', 'highly motivated', 'motivated individual', 'dedicated professional', 'track record of success'];
  // Words and turns of phrase that read as machine-written; a recruiter who has read a
  // hundred AI resumes this month notices them at once.
  const AI_TELLS = ['spearheaded', 'spearheading', 'leveraged', 'leveraging', 'leverages', 'utilized', 'utilizing', 'utilize',
    'utilised', 'orchestrated', 'orchestrating', 'seamless', 'seamlessly', 'robust', 'cutting-edge', 'state-of-the-art',
    'delve', 'delved', 'pivotal', 'fostered', 'fostering', 'showcasing', 'showcased', 'harnessed', 'harnessing', 'bolstered',
    'endeavor', 'endeavour', 'tapestry', 'realm', 'paradigm', 'synergies', 'holistic', 'meticulous', 'meticulously',
    'transformative', 'empowered', 'empowering', 'elevated', 'elevating', 'unlocked', 'unlocking', 'navigated complex',
    'in today\'s', 'fast-paced', 'a testament to', 'underscoring', 'underscored', 'ever-evolving', 'game-changer', 'game-changing',
    'world-class', 'best-in-class', 'drove impactful', 'impactful'];
  const PASSIVE = /\b(?:was|were|been|being)\s+(?:\w+ed|built|made|done|given|taken|shown|written|run|led|chosen|sent|kept|held)\b/i;
  const FIRST_PERSON = /(?:^|[^A-Za-z'])(?:I|I'm|I've|I'd|me|my|myself|mine)(?=$|[^A-Za-z'])/;
  const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
  const DATE = `(?:${MONTH}\\s+\\d{4}|\\d{1,2}\\/\\d{4}|(?:19|20)\\d{2})`;
  const RANGE_RE = new RegExp(`${DATE}\\s*(?:–|—|-|to|until)\\s*(?:${DATE}|present|current|now|today)`, 'gi');
  const SECTIONS = {
    experience: /\b(experience|employment|work history|career history|professional background|work experience)\b/i,
    education: /\b(education|academic|qualifications?|degrees?)\b/i,
    skills: /\b(skills|competencies|expertise|technologies|tech stack|toolkit|tools)\b/i,
    summary: /\b(summary|profile|objective|about me|about)\b/i,
    certifications: /\b(certifications?|licen[cs]es?|courses|training)\b/i,
    projects: /\b(projects?|portfolio)\b/i,
  };

  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const words = s => String(s || '').trim().split(/\s+/).filter(Boolean);
  const hasWord = (text, w) => new RegExp('(^|[^A-Za-z0-9+#.])' + esc(w) + '(?![A-Za-z0-9+#])', 'i').test(text);
  const found = (text, list) => list.filter(w => hasWord(text, w));
  const quote = list => list.slice(0, 4).map(x => '"' + x + '"').join(', ') + (list.length > 4 ? ` and ${list.length - 4} more` : '');

  // Paragraphs from plain text, for a resume whose layout could not be rebuilt.
  function blocksFromText(text) {
    return String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean).map((t, i) => {
      const bullet = /^[•●▪■◦○‣➢➤►▸✓✔❖➔\-–*·]\s+/.test(t);
      const clean = t.replace(/^[•●▪■◦○‣➢➤►▸✓✔❖➔\-–*·]\s+/, '');
      const n = words(clean).length;
      const heading = !bullet && n <= 5 && (clean === clean.toUpperCase() && /[A-Z]/.test(clean) || Object.values(SECTIONS).some(re => re.test(clean) && n <= 3));
      return { id: i, text: clean, heading, bullet, row: false, editable: !heading && n >= 4 };
    });
  }

  // Which section each paragraph belongs to, from the headings above it. Text before
  // the first heading is the header and, when it is a paragraph, the summary.
  function sectionsOf(blocks) {
    let cur = 'header';
    const seen = {};
    for (const b of blocks) {
      if (b.heading) {
        const hit = Object.entries(SECTIONS).find(([, re]) => re.test(b.text));
        // Before the first section heading, an unrecognised "heading" is the name or
        // title at the top: still the header.
        cur = hit ? hit[0] : cur === 'header' ? 'header' : 'other';
        if (hit) seen[cur] = true;
        b.section = cur;
        continue;
      }
      b.section = cur;
    }
    return seen;
  }

  function dateStyles(text) {
    const styles = new Set();
    for (const m of String(text).matchAll(new RegExp(MONTH + '\\s+\\d{4}', 'gi'))) {
      const w = m[0].split(/\s+/)[0].replace(/\.$/, '').toLowerCase();
      styles.add(w.length === 3 ? 'abbr' : w === 'sept' ? 'sept' : ['may'].includes(w) ? 'either' : 'full');
    }
    styles.delete('either');
    return styles;
  }

  function score({ text = '', rawText = '', blocks = null, meta = {}, tags = {} } = {}) {
    const B = (blocks && blocks.length ? blocks : blocksFromText(text)).map(b => ({ ...b }));
    const all = B.map(b => b.text).join('\n');
    const T = text || all;
    const seen = sectionsOf(B);
    const body = B.filter(b => !b.heading);
    const exp = body.filter(b => b.section === 'experience');
    const bullets = exp.filter(b => b.bullet || (!b.row && words(b.text).length >= 6));
    const editableIn = list => list.filter(b => b.editable !== false && !b.row && !b.heading);
    const cats = [];
    const add = (cat, c) => {
      c.got = Math.max(0, Math.min(c.max, Math.round(c.got * 10) / 10));
      c.status = c.got >= c.max ? 'pass' : c.got >= c.max * 0.5 ? 'warn' : 'fail';
      cat.checks.push(c);
    };
    const cat = (id, label) => { const c = { id, label, checks: [] }; cats.push(c); return c; };

    // Parsing and format — can a parser read it at all, and in the right order?
    const parse = cat('parse', 'Parsing & format');
    add(parse, T.replace(/\s/g, '').length >= 300
      ? { id: 'text', label: 'Readable text', max: 6, got: 6, detail: 'The file has real, selectable text.' }
      : { id: 'text', label: 'Readable text', max: 6, got: 0, detail: 'This file has almost no selectable text — it is probably an image or a scan, and an ATS reads it as blank.', fix: 'Export it from Word or Google Docs as a text PDF, or upload the DOCX.', fixable: 'you' });
    const raw = rawText || T;
    const em = raw.search(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const late = em > 0 && em / Math.max(1, raw.length) > 0.5;
    add(parse, late
      ? { id: 'order', label: 'Contact details read first', max: 4, got: 0, detail: 'In the file’s own text layer your name and contact details come after the body — they sit in a header graphic or text box, which parsers read last or drop.', fix: 'Fix my resume rebuilds the page with them first, in the same design.', fixable: 'auto' }
      : { id: 'order', label: 'Contact details read first', max: 4, got: 4, detail: 'Name and contact details are read before the body.' });
    add(parse, meta.columns
      ? { id: 'columns', label: 'Single column', max: 4, got: 1, detail: 'A two-column layout. Many ATS (Taleo, older Workday) read across both columns line by line and mix them up.', fix: 'A single-column version is the safest for online applications; keep this one for sending by email.', fixable: 'you' }
      : { id: 'columns', label: 'Single column', max: 4, got: 4, detail: 'One column, read top to bottom.' });
    const odd = (raw.match(/[-�]|\(cid:\d+\)/g) || []).length;
    add(parse, odd
      ? { id: 'chars', label: 'Clean characters', max: 2, got: 0, detail: `${odd} symbol${odd === 1 ? '' : 's'} (usually bullets or icons) come out as unreadable characters.`, fix: 'Fix my resume replaces them with standard bullets.', fixable: 'auto' }
      : { id: 'chars', label: 'Clean characters', max: 2, got: 2, detail: 'No unreadable symbols.' });
    const pages = meta.pages || Math.max(1, Math.round(words(T).length / 500));
    add(parse, { id: 'length', label: 'Length', max: 2, got: pages <= 2 ? 2 : pages === 3 ? 1 : 0,
      detail: pages <= 2 ? `${pages} page${pages === 1 ? '' : 's'}.` : `${pages} pages — recruiters and many ATS screens favour one or two.`,
      fix: pages > 2 ? 'Cut older roles to one line each and trim the skills list.' : '', fixable: 'you' });
    add(parse, { id: 'file', label: 'File type', max: 2, got: meta.kind === 'txt' ? 1 : 2,
      detail: meta.kind === 'txt' ? 'Plain text is readable but looks unfinished to a recruiter.' : 'PDF or Word, which every ATS accepts.',
      fix: meta.kind === 'txt' ? 'Send a PDF or DOCX.' : '', fixable: 'you' });

    // Sections and structure.
    const sec = cat('sections', 'Sections & structure');
    const need = (id, label, max, has, fix) => add(sec, has ? { id, label, max, got: max, detail: `A clear "${label.replace(/ section$/, '')}" section.` }
      : { id, label, max, got: 0, detail: `No section an ATS would recognise as ${label.toLowerCase()}.`, fix, fixable: 'you' });
    need('experience', 'Experience section', 4, !!seen.experience || exp.length > 0, 'Add a heading such as "Professional Experience" above your jobs.');
    need('education', 'Education section', 3, !!seen.education, 'Add an "Education" section, even one line.');
    need('skills', 'Skills section', 3, !!seen.skills, 'Add a "Skills" section listing your tools and technologies.');
    const firstPara = B.find(b => !b.heading && b.section === 'header' && words(b.text).length >= 25);
    need('summary', 'Summary', 2, !!seen.summary || !!firstPara, 'Open with a two- or three-line summary naming your title, years and main skills.');
    const ranges = (T.match(RANGE_RE) || []).length;
    add(sec, { id: 'dates', label: 'Dates on every job', max: 3, got: ranges >= 1 ? 3 : 0,
      detail: ranges ? `${ranges} date range${ranges === 1 ? '' : 's'} found.` : 'No date ranges found — an ATS cannot work out your experience.',
      fix: ranges ? '' : 'Give each job a range such as "Jun 2020 – Present".', fixable: 'you' });

    // Contact.
    const con = cat('contact', 'Contact details');
    const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(T);
    const phone = /(?:\+|\(\+?)?\d[\d\s().-]{7,}\d/.test(T.replace(RANGE_RE, ''));
    const li = /linkedin\.com\/(?:in|pub)\//i.test(T);
    const loc = /\b(pakistan|saudi arabia|ksa|riyadh|jeddah|dammam|united arab emirates|uae|dubai|abu dhabi|qatar|doha|india|united kingdom|uk|london|united states|usa|canada|germany|karachi|lahore|islamabad|bangalore|bengaluru|remote)\b/i.test(T)
      || /\b[A-Z][a-z]+,\s*[A-Z]{2}\b/.test(T);
    add(con, { id: 'email', label: 'Email', max: 3, got: email ? 3 : 0, detail: email ? 'Email address found.' : 'No email address.', fix: email ? '' : 'Add your email at the top.', fixable: 'you' });
    add(con, { id: 'phone', label: 'Phone', max: 3, got: phone ? 3 : 0, detail: phone ? 'Phone number found.' : 'No phone number.', fix: phone ? '' : 'Add a phone number with country code.', fixable: 'you' });
    add(con, { id: 'linkedin', label: 'LinkedIn', max: 2, got: li ? 2 : 0, detail: li ? 'LinkedIn profile linked.' : 'No LinkedIn profile.', fix: li ? '' : 'Add your linkedin.com/in/… address.', fixable: 'you' });
    add(con, { id: 'location', label: 'Location', max: 2, got: loc ? 2 : 0, detail: loc ? 'Location given.' : 'No city or country — many ATS filter by location.', fix: loc ? '' : 'Add your city and country (and "Open to relocation" if you are).', fixable: 'you' });

    // Keywords: the positions and skills the job search runs on, since they are what
    // an employer's ATS will be searching this resume for.
    const kw = cat('keywords', 'Keywords for your target roles');
    const roles = (tags.roles || []).filter(Boolean), skills = [...new Set((tags.skills || []).filter(Boolean))];
    const LEVEL = /^(senior|sr|junior|jr|lead|principal|staff|head|chief|mid|i|ii|iii)$/i;
    const head = T.slice(0, Math.max(400, Math.round(T.length * 0.25)));
    const core = r => words(r).filter(w => !LEVEL.test(w));
    const inHead = roles.find(r => core(r).length && core(r).every(w => hasWord(head, w)));
    const anywhere = roles.find(r => core(r).length && core(r).every(w => hasWord(T, w)));
    add(kw, !roles.length ? { id: 'title', label: 'Target title', max: 6, got: 6, detail: 'No target positions set.' }
      : inHead ? { id: 'title', label: 'Target title', max: 6, got: 6, detail: `"${inHead}" appears near the top, where ATS and recruiters look first.` }
      : anywhere ? { id: 'title', label: 'Target title', max: 6, got: 3, detail: `"${anywhere}" appears, but not in your headline or summary.`, fix: `Name "${roles[0]}" in your headline or first sentence.`, fixable: 'ai' }
      : { id: 'title', label: 'Target title', max: 6, got: 0, detail: `None of your target positions (${quote(roles)}) appears in the resume.`, fix: `Use the title "${roles[0]}" in your headline or summary, if it describes what you do.`, fixable: 'ai' });
    const have = skills.filter(s => hasWord(T, s)), missing = skills.filter(s => !hasWord(T, s));
    const cov = skills.length ? have.length / skills.length : 1;
    add(kw, { id: 'coverage', label: 'Skills coverage', max: 10, got: skills.length ? 10 * cov : 10,
      detail: skills.length ? `${have.length} of your ${skills.length} search skills appear in the resume.` + (missing.length ? ` Missing: ${quote(missing)}.` : '') : 'No search skills set.',
      fix: missing.length ? `Mention ${quote(missing)} where you have really used them — in a job bullet, not only the skills list.` : '', fixable: 'you', missing });
    const inExp = have.filter(s => exp.some(b => hasWord(b.text, s)));
    const ctx = have.length ? inExp.length / have.length : 1;
    add(kw, { id: 'context', label: 'Skills shown in your work', max: 4, got: 4 * Math.min(1, ctx / 0.5),
      detail: have.length ? `${inExp.length} of ${have.length} skills are shown in a job, not only listed.` : 'No skills to check.',
      // Only the candidate knows which job used which tool, so this is never rewritten for them.
      fix: ctx < 0.5 ? `Name ${quote(have.filter(s => !inExp.includes(s)))} in the bullets of the jobs where you really used them — only you know which.` : '', fixable: 'you' });

    // Impact.
    const imp = cat('impact', 'Impact & achievements');
    const metric = s => /\d/.test(String(s).replace(RANGE_RE, ' ').replace(/\b(?:19|20)\d{2}\b/g, ' ')) || /\b(?:doubled|tripled|halved)\b/i.test(s);
    const withNum = bullets.filter(b => metric(b.text)), noNum = bullets.filter(b => !metric(b.text));
    const q = bullets.length ? withNum.length / bullets.length : 0;
    add(imp, { id: 'numbers', label: 'Results with numbers', max: 8, got: !bullets.length ? 0 : q >= 0.5 ? 8 : q >= 0.35 ? 6 : q >= 0.2 ? 4 : q > 0 ? 2 : 0,
      detail: bullets.length ? `${withNum.length} of ${bullets.length} job bullets show a result with a number.` : 'No job bullets found.',
      fix: q < 0.5 ? 'Add a number wherever you have a true one: team size, users, % faster, time or money saved, defects cut. Only you know these — the rewrite never invents them.' : '',
      fixable: 'you', blocks: noNum.map(b => b.id) });
    const weak = bullets.filter(b => WEAK_OPENER.test(b.text));
    const strong = bullets.filter(b => ACTION.has((words(b.text)[0] || '').toLowerCase().replace(/[^a-z]/g, '')) && !WEAK_OPENER.test(b.text));
    const sv = bullets.length ? strong.length / bullets.length : 0;
    add(imp, { id: 'verbs', label: 'Strong opening verbs', max: 6, got: !bullets.length ? 0 : Math.max(0, 6 * Math.min(1, sv / 0.8) - weak.length),
      detail: bullets.length ? `${strong.length} of ${bullets.length} bullets open with a strong verb` + (weak.length ? `; ${weak.length} open weakly (${quote(weak.map(b => words(b.text).slice(0, 3).join(' ')))}).` : '.') : 'No bullets found.',
      fix: weak.length || sv < 0.8 ? 'Open each bullet with what you did: Led, Built, Cut, Automated, Shipped.' : '', fixable: 'ai',
      blocks: bullets.filter(b => !strong.includes(b)).map(b => b.id) });
    const long = bullets.filter(b => words(b.text).length > 32), short = bullets.filter(b => words(b.text).length < 5);
    add(imp, { id: 'bulletlen', label: 'Bullet length', max: 3, got: 3 - Math.min(3, long.length + short.length * 0.5),
      detail: long.length || short.length ? `${long.length} bullet${long.length === 1 ? ' runs' : 's run'} past two lines${short.length ? `, ${short.length} ${short.length === 1 ? 'is' : 'are'} too short to say anything` : ''}.` : 'Bullets are one or two lines.',
      fix: long.length ? 'Keep each bullet to one or two lines: the action, the tool, the result.' : '', fixable: 'ai', blocks: long.map(b => b.id) });
    const roleCount = Math.max(1, (exp.map(b => b.text).join('\n').match(RANGE_RE) || []).length || B.filter(b => b.row && b.section === 'experience').length);
    const per = bullets.length / roleCount;
    add(imp, { id: 'perrole', label: 'Bullets per job', max: 3, got: per >= 3 && per <= 8 ? 3 : per >= 2 ? 2 : per > 0 ? 1 : 0,
      detail: `About ${Math.round(per * 10) / 10} bullets per job.`, fix: per < 3 ? 'Give each recent job three to six bullets.' : per > 8 ? 'Keep the strongest six bullets per job.' : '', fixable: 'you' });

    // Language.
    const lang = cat('language', 'Language & style');
    const ed = editableIn(body);
    const pron = ed.filter(b => FIRST_PERSON.test(b.text));
    add(lang, { id: 'pronouns', label: 'No "I" or "my"', max: 4, got: pron.length ? Math.max(0, 4 - pron.length) : 4,
      detail: pron.length ? `${pron.length} paragraph${pron.length === 1 ? '' : 's'} use first person ("I", "my").` : 'Written without "I" and "my", as resumes are.',
      fix: pron.length ? 'Drop "I" and "my": start with the verb.' : '', fixable: 'ai', blocks: pron.map(b => b.id) });
    const cl = ed.map(b => ({ b, hits: found(b.text, CLICHES) })).filter(x => x.hits.length);
    const clAll = [...new Set(cl.flatMap(x => x.hits))];
    add(lang, { id: 'cliches', label: 'No clichés', max: 4, got: Math.max(0, 4 - clAll.length),
      detail: clAll.length ? `Clichés recruiters skip: ${quote(clAll)}.` : 'No stock phrases.',
      fix: clAll.length ? 'Replace them with what you actually did or delivered.' : '', fixable: 'ai', blocks: cl.map(x => x.b.id) });
    const ai = ed.map(b => ({ b, hits: found(b.text, AI_TELLS) })).filter(x => x.hits.length);
    const aiAll = [...new Set(ai.flatMap(x => x.hits))];
    add(lang, { id: 'aitells', label: 'Sounds like a person', max: 3, got: Math.max(0, 3 - aiAll.length),
      detail: aiAll.length ? `Words that read as machine-written: ${quote(aiAll)}.` : 'Plain, human wording.',
      fix: aiAll.length ? 'Use plain verbs: led, used, built, ran.' : '', fixable: 'ai', blocks: ai.map(x => x.b.id) });
    const pas = ed.filter(b => PASSIVE.test(b.text));
    add(lang, { id: 'passive', label: 'Active voice', max: 2, got: Math.max(0, 2 - pas.length * 0.5),
      detail: pas.length ? `${pas.length} passive phrase${pas.length === 1 ? '' : 's'} ("was responsible", "were tested").` : 'Active voice throughout.',
      fix: pas.length ? 'Say who did it: "Tested…", not "Was tested…".' : '', fixable: 'ai', blocks: pas.map(b => b.id) });
    const ds = dateStyles(T);
    add(lang, { id: 'datestyle', label: 'Consistent dates', max: 2, got: ds.size <= 1 ? 2 : 0,
      detail: ds.size <= 1 ? 'Dates are written one way.' : 'Dates are written several ways (e.g. "June", "Oct", "Sept") — it reads as careless and can trip date parsing.',
      fix: ds.size > 1 ? 'Fix my resume writes every month the same way ("Jun 2020 – Present").' : '', fixable: 'auto' });

    for (const c of cats) { c.max = c.checks.reduce((a, x) => a + x.max, 0); c.got = Math.round(c.checks.reduce((a, x) => a + x.got, 0) * 10) / 10; }
    const total = Math.round(cats.reduce((a, c) => a + c.got, 0));
    const fixes = cats.flatMap(c => c.checks.filter(x => x.got < x.max && x.fix).map(x => ({ ...x, category: c.id, gain: Math.round((x.max - x.got) * 10) / 10 })))
      .sort((a, b) => b.gain - a.gain);
    return {
      score: total,
      grade: total >= 85 ? 'Excellent' : total >= 70 ? 'Good' : total >= 55 ? 'Fair' : 'Needs work',
      categories: cats, fixes,
    };
  }

  // Dates written one way: every month as its three-letter name ("Sept" and "June"
  // become "Sep" and "Jun") and ranges with an en dash. Only the months in date
  // ranges are touched.
  function normaliseDates(text) {
    const short = { january: 'Jan', february: 'Feb', march: 'Mar', april: 'Apr', may: 'May', june: 'Jun', july: 'Jul', august: 'Aug', september: 'Sep', sept: 'Sep', october: 'Oct', november: 'Nov', december: 'Dec' };
    return String(text).replace(new RegExp(`(${MONTH})(\\s+\\d{4})`, 'gi'), (m, mon, yr) => {
      const k = mon.replace(/\.$/, '').toLowerCase();
      const s = short[k] || (k.length >= 3 ? k[0].toUpperCase() + k.slice(1, 3) : mon);
      return s + yr;
    }).replace(new RegExp(`(${DATE})\\s*(?:-|–|—)\\s*(${DATE}|present|current|now)`, 'gi'), '$1 – $2');
  }

  const api = { score, normaliseDates, AI_TELLS, CLICHES, blocksFromText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ATSScore = api;
})(typeof window !== 'undefined' ? window : this);
