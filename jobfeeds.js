// Offerly live job feeds — real postings with a real date and a real link.
//
// The recruiter model is good at naming employers that hire a given profile, but it
// cannot know what is open today; anything it "remembers" is as old as its training
// data. So the model's output is treated as a shortlist of *companies*, and this
// module goes and finds what those companies (and the wider remote market) actually
// have open right now.
//
// Two kinds of source, both public and keyless:
//   boards — whole-market remote job feeds, queried by keyword
//   ats    — a named company's own careers feed (Greenhouse, Lever, Ashby), which is
//            the only reliable way to see onsite roles in markets the remote boards
//            do not cover
//
// Every posting returned here carries a publication date from the source and a link
// to that exact posting. Nothing is inferred and nothing is invented.
const places = require('./places');
const UA = 'Mozilla/5.0 (compatible; Offerly/1.2; +https://github.com/saadrazzaq/offerly)';
const REQ_TIMEOUT = 12000;
const PROBE_BUDGET = 110; // ATS requests per search, so a long shortlist cannot stall

// Feed responses are kept for a few minutes. Editing a tag and searching again is
// the normal way to use the page, and re-downloading every board for each edit is
// what got us rate-limited. Postings are still link-checked on every search.
const CACHE_MS = 5 * 60000;
const cache = new Map();
async function getJSON(url, timeout = REQ_TIMEOUT) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const get = () => fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  let r = await get();
  // One polite retry on a rate limit, rather than reporting the source as empty.
  if (r.status === 429) { await new Promise(res => setTimeout(res, 2000)); r = await get(); }
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  const data = await r.json();
  if (cache.size > 300) cache.clear();
  cache.set(url, { at: Date.now(), data });
  return data;
}

// --- normalising ------------------------------------------------------------
const REMOTE_RE = /\b(remote|anywhere|work from home|wfh|distributed)\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\b(on[- ]?site|in[- ]office)\b/i;

// Ashby and Lever state the arrangement outright; everything else has to be read
// off the location and title, which is why `workplace` can legitimately be ''.
function workplaceOf({ explicit, location, title, remoteFlag }) {
  const e = String(explicit || '').toLowerCase().replace(/[^a-z]/g, '');
  if (e === 'remote') return 'remote';
  if (e === 'hybrid') return 'hybrid';
  if (e === 'onsite' || e === 'inoffice') return 'onsite';
  const text = `${location || ''} ${title || ''}`;
  if (HYBRID_RE.test(text)) return 'hybrid';
  if (remoteFlag === true || REMOTE_RE.test(text)) return 'remote';
  if (ONSITE_RE.test(text)) return 'onsite';
  if (remoteFlag === false && location) return 'onsite';
  return '';
}

// A timestamp with no zone ("2026-09-21T12:55:11", as Remotive writes them) is UTC.
// Read as local time it drifts by the server's offset, which is enough to push a
// posting across a 24-hour window.
function iso(v) {
  if (v == null || v === '') return '';
  let d;
  if (typeof v === 'number') d = new Date(v > 1e12 ? v : v * 1000); // ms or seconds
  else {
    const s = String(v).trim();
    d = new Date(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? s + 'Z' : s);
  }
  return isNaN(d) ? '' : d.toISOString();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
// Greenhouse sends its HTML entity-encoded, so decode before stripping tags.
function plain(html) {
  return decodeEntities(decodeEntities(String(html || '')).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// `desc` is the posting's own wording, used to check the resume's skills against
// the job description. It is stripped before anything is sent to the page.
// `countries` are structured values some feeds give next to the free-text location
// (Lever's ISO code, Ashby's address), and are trusted over the text.
// `ref` is how to ask the source about this one posting again.
function posting(o) {
  return {
    title: String(o.title || '').replace(/\s+/g, ' ').trim(),
    company: String(o.company || '').trim(),
    url: String(o.url || '').trim(),
    postedAt: iso(o.postedAt),
    location: String(o.location || '').replace(/\s+/g, ' ').trim(),
    countries: (o.countries || []).filter(Boolean).map(String),
    workplace: o.workplace || '',
    source: o.source,
    sourceLabel: o.sourceLabel,
    desc: plain(o.desc).slice(0, 12000),
    ref: o.ref || null,
  };
}

// --- whole-market remote boards --------------------------------------------
const BOARDS = [
  {
    id: 'remotive', label: 'Remotive', remoteOnly: true,
    async fetch(q) {
      const j = await getJSON('https://remotive.com/api/remote-jobs?limit=60&search=' + encodeURIComponent(q));
      return (j.jobs || []).map(x => posting({
        title: x.title, company: x.company_name, url: x.url,
        postedAt: x.publication_date, location: x.candidate_required_location, desc: x.description,
        workplace: 'remote', source: 'remotive', sourceLabel: 'Remotive',
      }));
    },
  },
  {
    id: 'jobicy', label: 'Jobicy', remoteOnly: true,
    async fetch(q) {
      const j = await getJSON('https://jobicy.com/api/v2/remote-jobs?count=50&tag=' + encodeURIComponent(q));
      return (j.jobs || []).map(x => posting({
        title: x.jobTitle, company: x.companyName, url: x.url,
        postedAt: x.pubDate, location: x.jobGeo, desc: x.jobDescription || x.jobExcerpt,
        workplace: 'remote', source: 'jobicy', sourceLabel: 'Jobicy',
      }));
    },
  },
  {
    id: 'remoteok', label: 'RemoteOK', remoteOnly: true,
    async fetch() {
      const j = await getJSON('https://remoteok.com/api');
      // The first element is RemoteOK's licence notice, not a job.
      return (Array.isArray(j) ? j : []).filter(x => x && x.position).map(x => posting({
        title: x.position, company: x.company, url: x.url || ('https://remoteok.com/l/' + x.id),
        postedAt: x.epoch || x.date, location: x.location, desc: x.description,
        workplace: 'remote', source: 'remoteok', sourceLabel: 'RemoteOK',
      }));
    },
  },
  {
    id: 'arbeitnow', label: 'Arbeitnow', remoteOnly: false,
    async fetch() {
      const j = await getJSON('https://www.arbeitnow.com/api/job-board-api');
      return (j.data || []).map(x => posting({
        title: x.title, company: x.company_name,
        url: arbeitnowUrl(x),
        postedAt: x.created_at, location: x.location, desc: x.description,
        workplace: workplaceOf({ location: x.location, title: x.title, remoteFlag: x.remote }),
        source: 'arbeitnow', sourceLabel: 'Arbeitnow',
      }));
    },
  },
];

// Arbeitnow's `url` is the posting page for jobs it hosts, but an employer's own
// link for the rest — sometimes a bare homepage, which is no use to an applicant.
// The /view/<slug> page only exists for the ones it hosts (others answer 410).
function arbeitnowUrl(x) {
  const u = String(x.url || '');
  if (/arbeitnow\.com\//i.test(u)) return u;
  try {
    const parsed = new URL(u);
    if (parsed.pathname && parsed.pathname !== '/') return u; // deep link to the posting
  } catch (_) {}
  return ''; // no link we can stand behind — the posting is dropped
}

// --- a named company's own careers feed -------------------------------------
const ATS = [
  {
    id: 'greenhouse', label: 'Greenhouse',
    url: t => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=false`,
    // Tokens are guessed from the company name, so a guess can land on someone
    // else's board. Greenhouse says whose board it is, so check before trusting it.
    verify: (j, company) => {
      const said = (j.jobs || []).map(x => x.company_name).find(Boolean);
      return !said || nameMatches(said, company);
    },
    // Only `first_published` is the posting date. `updated_at` changes whenever the
    // employer touches the job, so a role opened two years ago and edited yesterday
    // passed a "past 24 hours" filter. No first_published, no date, no posting.
    // The list carries no description; it is fetched per posting once the cheap
    // filters have run (see describeGreenhouse).
    parse: (j, company, token) => (j.jobs || []).map(x => posting({
      title: x.title, company, url: x.absolute_url,
      postedAt: x.first_published,
      location: x.location && x.location.name,
      workplace: workplaceOf({ location: x.location && x.location.name, title: x.title }),
      source: 'greenhouse', sourceLabel: 'Greenhouse', ref: { token, id: x.id },
    })),
  },
  {
    id: 'lever', label: 'Lever',
    url: t => `https://api.lever.co/v0/postings/${t}?mode=json`,
    parse: (j, company) => (Array.isArray(j) ? j : []).map(x => {
      const c = x.categories || {};
      const locs = [...new Set([c.location, ...(c.allLocations || [])].filter(Boolean))];
      return posting({
        title: x.text, company, url: x.hostedUrl,
        postedAt: x.createdAt,
        desc: [x.descriptionPlain, ...(x.lists || []).map(l => (l.text || '') + ' ' + (l.content || '')), x.additionalPlain].join(' '),
        location: locs.join(' / '), countries: [x.country],
        workplace: workplaceOf({ explicit: x.workplaceType, location: c.location, title: x.text }),
        source: 'lever', sourceLabel: 'Lever',
      });
    }),
  },
  {
    id: 'ashby', label: 'Ashby',
    url: t => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    parse: (j, company) => (j.jobs || []).filter(x => x.isListed !== false).map(x => {
      const second = x.secondaryLocations || [];
      const countryOf = a => a && a.postalAddress && a.postalAddress.addressCountry;
      return posting({
        title: x.title, company, url: x.jobUrl || x.applyUrl,
        postedAt: x.publishedAt, desc: x.descriptionPlain,
        location: [x.location, ...second.map(s => s.location)].filter(Boolean).join(' / '),
        countries: [countryOf(x.address), ...second.map(s => countryOf(s.address))],
        workplace: workplaceOf({ explicit: x.workplaceType, location: x.location, title: x.title, remoteFlag: x.isRemote }),
        source: 'ashby', sourceLabel: 'Ashby',
      });
    }),
  },
];

// Companies do not publish their ATS token, so it has to be guessed from the name.
// Most are the name with punctuation stripped; a few use hyphens.
function tokensFor(company) {
  const base = String(company || '').toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|plc|group|technologies|technology|labs|software)\b/g, ' ')
    .replace(/&/g, ' and ').trim();
  const flat = base.replace(/[^a-z0-9]/g, '');
  const hyphen = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return [...new Set([flat, hyphen].filter(t => t.length >= 2 && t.length <= 40))];
}

// "Acme Corp" and "Acme" are the same employer; "Acme" and "Acme Bank" are not
// necessarily, but one containing the other is close enough to accept.
function nameMatches(a, b) {
  const n = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = n(a), y = n(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

async function probeCompany(company, budget) {
  for (const token of tokensFor(company)) {
    for (const ats of ATS) {
      if (budget.left <= 0) return [];
      budget.left--;
      try {
        const j = await getJSON(ats.url(token), 9000);
        if (ats.verify && !ats.verify(j, company)) continue;   // someone else's board
        const jobs = ats.parse(j, company, token).filter(p => p.url && p.title);
        if (jobs.length) return jobs;
      } catch (_) { /* 404 just means this company is not on that ATS */ }
    }
  }
  return [];
}

// Greenhouse's list has no description, so a posting that survives the cheap
// filters is asked for individually. That doubles as a liveness check: a posting the
// employer has pulled answers 404 here even while an aggregator still lists it.
async function describeGreenhouse(p) {
  try {
    const j = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${p.ref.token}/jobs/${p.ref.id}`, 9000);
    p.desc = plain(j.content).slice(0, 12000);
    return true;
  } catch (e) {
    return e.status === 404 ? false : null;       // null: could not tell
  }
}

// An employer's own careers feed, as opposed to a board's copy of the posting.
const DIRECT_SOURCES = new Set(['greenhouse', 'lever', 'ashby']);

// --- relevance --------------------------------------------------------------
// Matching used to pool every target role into one bag of words, so a single word
// was enough to let a posting in: "Data Engineer" in the list meant "Data Entry
// Clerk" matched on "data". Each role is now matched as a phrase, on its own.

// Written many ways, meaning the same job.
const SYNONYM = new Map(Object.entries({
  engineer: 'eng', engineers: 'eng', engineering: 'eng', developer: 'eng', developers: 'eng',
  dev: 'eng', programmer: 'eng', coder: 'eng',
  manager: 'mgr', head: 'mgr', director: 'mgr',
  analyst: 'analysis', analytics: 'analysis',
  designer: 'design',
  scientist: 'science',
  administrator: 'admin', admin: 'admin',
}));
// The head word of a title says what the job *is*. On its own it says nothing about
// which one: "Sales Engineer" must not answer a search for "Backend Engineer".
const HEADS = new Set(['eng', 'mgr', 'analysis', 'design', 'science', 'admin',
  'architect', 'consultant', 'specialist', 'lead', 'officer', 'associate', 'intern']);
// Modifiers too vague to distinguish one role from another.
const VAGUE = new Set(['software', 'technical', 'technology', 'application', 'applications',
  'system', 'systems', 'computer', 'digital', 'general', 'new', 'team']);

const LEVELS = [
  [0, /\b(intern|internship|trainee|graduate|apprentice|working student|werkstudent)\b/i],
  [1, /\b(junior|jr|entry[- ]level|associate)\b/i],
  [3, /\b(senior|sr|snr)\b/i],
  [4, /\b(staff|principal|lead|expert)\b/i],
  [5, /\b(manager|head of|engineering manager)\b/i],
  [6, /\b(director|vp|vice president|chief|cto|head of engineering)\b/i],
];
// 2 is the unmarked middle: a title with no level word is a mid-level role. The
// highest marker wins, so "Senior Data Engineering Manager" is a manager role and
// not a senior one — matching in listed order got that backwards.
function levelOf(text) {
  let best = null;
  for (const [n, re] of LEVELS) if (re.test(text)) best = best === null ? n : Math.max(best, n);
  return best === null ? 2 : best;
}

// Spellings that split or join the same word. A full stop that ends a sentence is
// not part of the word before it: "experience with AWS." has to find "aws".
function normalise(text) {
  return ' ' + String(text).toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\.+(?=\s|$)/g, ' ')
    .replace(/(^|\s)\.(?!net\b)/g, ' ')
    .replace(/\bfull[ -]?stack\b/g, 'fullstack')
    .replace(/\bfront[ -]?end\b/g, 'frontend')
    .replace(/\bback[ -]?end\b/g, 'backend')
    .replace(/\bdev[ -]?ops\b/g, 'devops')
    .replace(/\bmachine learning\b/g, 'ml')
    .replace(/\s+/g, ' ') + ' ';
}
function tokens(text) {
  return normalise(text).trim().split(' ').filter(Boolean).map(w => SYNONYM.get(w) || w);
}

// A target role becomes the words that identify it (what kind of work) and the head
// word (what the job is). "Senior Backend Engineer" -> key [backend], head eng.
function parseRole(role) {
  const all = tokens(role);
  const key = [], heads = [];
  for (const w of all) {
    if (HEADS.has(w)) { heads.push(w); continue; }
    if (w.length <= 2 || VAGUE.has(w)) continue;
    if (/^(senior|sr|snr|junior|jr|staff|principal|lead|mid|entry|level|intern|graduate|i|ii|iii)$/.test(w)) continue;
    key.push(w);
  }
  return { label: role, key: [...new Set(key)], heads: [...new Set(heads)], level: levelOf(role) };
}

// A posting matches a role when it carries every identifying word of that role, and
// the same kind of head word. Roles with no identifying word of their own (plain
// "Software Engineer") have to match the head and are confirmed against the skills.
function matchesRole(titleTokens, role) {
  const has = w => titleTokens.includes(w);
  const headOk = !role.heads.length || role.heads.some(has);
  if (!headOk) return 0;
  if (!role.key.length) return 1;               // generic role: head match only, weak
  if (!role.key.every(has)) return 0;
  return 2 + role.key.length;                   // every identifying word present
}

// --- skills -----------------------------------------------------------------
// A skill is looked for in every spelling a posting might use: "Node.js", "NodeJS",
// "Node"; "PostgreSQL", "Postgres"; "Kubernetes", "k8s".
const SKILL_ALIASES = {
  postgresql: ['postgres'], postgres: ['postgresql'], javascript: ['js', 'ecmascript'], typescript: ['ts'],
  kubernetes: ['k8s'], go: ['golang'], golang: ['go lang'], 'amazon web services': ['aws'], aws: ['amazon web services'],
  gcp: ['google cloud'], 'google cloud': ['gcp'], 'google cloud platform': ['gcp', 'google cloud'],
  azure: ['microsoft azure'], 'ci/cd': ['ci cd', 'cicd', 'continuous integration', 'continuous delivery'],
  ml: ['machine learning'], ai: ['artificial intelligence'], 'artificial intelligence': ['ai'],
  llm: ['llms', 'large language model', 'large language models'], nlp: ['natural language processing'],
  'react native': ['react-native'], 'c#': ['csharp', '.net'], '.net': ['dotnet', 'asp.net'],
  'tailwind': ['tailwindcss'], 'mongodb': ['mongo'], 'rest': ['restful', 'rest api', 'rest apis'],
  'microservices': ['microservice', 'micro services'], 'sql server': ['mssql'], 'power bi': ['powerbi'],
  'scikit-learn': ['sklearn', 'scikit learn'], 'ui/ux': ['ui', 'ux'], 'figma': ['figma'],
};
// Two letters are too common to search for, apart from these.
const SHORT_OK = new Set(['ml', 'ai', 'ui', 'ux', 'qa', 'bi', 'c#', 'c++', 'r&d', 'ts', 'js', 'k8s', 'go']);
// …and "go" only as "golang": in prose it is a verb.
const NEVER_ALONE = new Set(['go', 'ts', 'js']);

function skillForms(skill) {
  const raw = String(skill || '').toLowerCase().trim();
  const base = normalise(raw).trim();
  if (!base) return [];
  const forms = new Set([base, base.replace(/\./g, ''), base.replace(/\./g, ' ').replace(/\s+/g, ' ').trim()]);
  if (/\.js$/.test(base)) { forms.add(base.slice(0, -3)); forms.add(base.slice(0, -3) + 'js'); }
  else if (/^[a-z]+$/.test(base) && ['react', 'node', 'vue', 'next', 'nest', 'express', 'angular', 'nuxt'].includes(base)) {
    forms.add(base + 'js'); forms.add(base + '.js');
  }
  for (const a of SKILL_ALIASES[raw] || SKILL_ALIASES[base] || []) forms.add(normalise(a).trim());
  return [...forms].filter(f => f && (f.length > 2 || SHORT_OK.has(f)) && !NEVER_ALONE.has(f));
}

function makeSkillMatcher(skills) {
  const list = skills.map(s => ({ label: String(s).trim(), forms: skillForms(s) })).filter(s => s.label && s.forms.length);
  return text => {
    if (!text) return [];
    const t = normalise(text);
    return list.filter(s => s.forms.some(f => t.includes(' ' + f + ' '))).map(s => s.label);
  };
}

// Title and seniority. Returns 0 to reject; higher is a better match.
function roleScore(p, roles, candidateLevel) {
  const tt = tokens(p.title);
  let best = 0;
  for (const role of roles) {
    const m = matchesRole(tt, role);
    if (m > best) best = m;
  }
  if (!best) return 0;
  // Someone with seven years behind them does not want an internship, and is not
  // getting the VP role either.
  const lvl = levelOf(p.title);
  if (Number.isFinite(candidateLevel)) {
    if (lvl === 0 && candidateLevel >= 2) return 0;
    // One step either way. A senior engineer is shown staff and mid roles, not an
    // internship and not an engineering director.
    if (Math.abs(lvl - candidateLevel) > 1) return 0;
  }
  return best;
}

// --- link checking ----------------------------------------------------------
// A feed can list a posting the employer has already pulled, and a dead link is the
// most annoying thing this page could hand someone. A status code is not enough:
// most boards answer 200 with a "this job is no longer available" page.
//
// The phrases are matched on word boundaries. A plain substring test reads "Salary
// Undisclosed" as closed, which would throw away perfectly live postings.
const DEAD_PAGE = new RegExp([
  'no longer (?:available|accepting applications|open|active)',
  'this (?:job|position|posting|listing|opening|vacancy|role) (?:has )?(?:expired|been closed|been filled|is closed|is no longer)',
  '(?:job|position|posting|listing|vacancy) (?:has )?expired',
  'position (?:has been )?filled',
  'applications (?:are |have )?closed',
  'we (?:could ?n.t|cannot|can.t) find (?:that|this|the) (?:job|position|page)',
  'job not found',
  'page not found',
].map(x => '\\b(?:' + x + ')\\b').join('|'), 'i');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function hostOf(url) { try { return new URL(url).host; } catch { return url; } }

// What identifies this posting in its URL: a UUID, a long number, or failing both
// the final path segment. A closed posting is usually redirected somewhere that no
// longer carries it — Stripe's dead Greenhouse links land on its full list of open
// roles, which still has other jobs with the same title on it.
function postingId(url) {
  let u; try { u = new URL(url); } catch { return ''; }
  let s = u.pathname + u.search;
  try { s = decodeURIComponent(s); } catch (_) {}
  const uuid = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0].toLowerCase();
  const nums = s.match(/\d{5,}/g);
  if (nums) return nums.sort((a, b) => b.length - a.length)[0];
  const seg = (u.pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
  return seg.length >= 8 ? seg : '';
}

// Does this page actually show this job? Titles get reworded slightly between a
// feed and the page it points at, so most of the distinctive words having survived
// is the right test, not an exact string match.
function titleOnPage(title, text) {
  const words = String(title).toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .split(/\s+/)
    .map(w => w.replace(/\.+$/, ''))
    .filter(w => w.length > 3 && !['with', 'from', 'this', 'that', 'your', 'remote', 'senior', 'staff', 'hybrid'].includes(w));
  if (!words.length) return true;                 // nothing distinctive to look for
  const hay = text.toLowerCase();
  const hits = words.filter(w => hay.includes(w)).length;
  return hits / words.length >= 0.7;
}

// Where the link really goes and whether it is this posting:
//   exact   the page loaded, still carries the posting's ID after any redirect, shows
//           this job's title and does not say it is closed
//   listed  the site will not show its page to a server (a bot check: 403, 429, 503)
//           but the source's own live feed listed this exact posting moments ago,
//           at a URL on the source's own site carrying the posting's ID
//   dead    gone, redirected away from the posting, or the page shows something else
async function checkLink(p) {
  const url = p.url;
  const id = postingId(url);
  if (!id) return { state: 'dead', why: 'no posting id in link' };
  let r;
  try {
    r = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    });
  } catch (_) {
    return { state: 'listed', url, why: 'site did not answer in time' };
  }
  if (r.status === 404 || r.status === 410) return { state: 'dead', why: 'HTTP ' + r.status };
  const finalUrl = r.url || url;
  if (!r.ok) {
    // A bot wall. Say what we know rather than what we hoped.
    if ([401, 403, 429, 503].includes(r.status)) return { state: 'listed', url: finalUrl, why: 'HTTP ' + r.status };
    return { state: 'dead', why: 'HTTP ' + r.status };
  }
  if (!finalUrl.toLowerCase().includes(id)) return { state: 'dead', why: 'redirected away from the posting' };
  if (!/html/i.test(r.headers.get('content-type') || '')) return { state: 'dead', why: 'not a web page' };

  let body;
  try { body = (await r.text()).slice(0, 600000); } catch (_) { return { state: 'listed', url: finalUrl, why: 'page did not finish loading' }; }

  // The posting's own structured data, when the page has it, is the most direct
  // statement of whether the job is still open.
  for (const m of body.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const vt = (m[1].match(/"validThrough"\s*:\s*"([^"]+)"/) || [])[1];
    if (vt && Date.parse(vt) && Date.parse(vt) < Date.now() - 86400000) return { state: 'dead', why: 'validThrough ' + vt };
  }
  const pageTitle = decodeEntities((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const ld = [...body.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join(' ');
  const text = decodeEntities(body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
  if (DEAD_PAGE.test(pageTitle) || DEAD_PAGE.test(text.slice(0, 20000))) return { state: 'dead', why: 'page says closed' };
  const metas = [...body.matchAll(/<meta[^>]+content="([^"]*)"/gi)].map(m => m[1]).join(' ');
  if (!titleOnPage(p.title, [pageTitle, decodeEntities(metas), ld, text].join(' '))) {
    return { state: 'dead', why: 'page does not show this job' };
  }
  return { state: 'exact', url: finalUrl };
}

// These are small free services. Their links are checked one at a time per host,
// spaced out; different hosts go in parallel. Firing everything at once earned
// nothing but 429s, which made live postings look broken.
// Stops at `want` confirmed postings or at the deadline; anything not yet checked
// by then is left out rather than shown unchecked.
async function verifyLinks(list, want, deadline) {
  const byHost = new Map();
  for (const p of list) {
    const h = hostOf(p.url);
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(p);
  }
  let good = 0;
  await Promise.all([...byHost.values()].map(async group => {
    for (let i = 0; i < group.length; i++) {
      if (good >= want || Date.now() > deadline) return;
      const p = group[i];
      const v = await checkLink(p);
      p.linkState = v.state;
      p.linkNote = v.why || '';
      // Follow the redirect once here so the person is not bounced again later.
      if (v.url && v.url !== p.url) p.url = v.url;
      if (v.state !== 'dead') good++;
      if (i < group.length - 1) await sleep(350);
    }
  }));
  return list.filter(p => p.linkState === 'exact' || p.linkState === 'listed');
}

// --- public entry point -----------------------------------------------------
// Every filter here is a requirement, not a preference. A posting is shown only if
// it passes all of them:
//   days       published within this many days, by the source's own date (0 = any age)
//   country    open to someone in this country (see places.js)
//   workSetup  '', 'remote', 'hybrid' or 'onsite' — an unknown arrangement is not a match
//   roles      its title is one of these positions
//   level      its seniority is within one step of the candidate's
//   skills     its own description names at least one of them
//   link       the link was opened and is this posting, still open
// companies is the shortlist whose own careers feeds are read.
async function search({ roles = [], companies = [], country = '', workSetup = '',
                        days = 7, limit = 30, skills = [], level } = {}) {
  if (!String(country).trim()) throw new Error('Choose a target country.');
  const started = Date.now();
  const parsed = (roles || []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 12).map(parseRole)
    .filter(r => r.key.length || r.heads.length);
  if (!parsed.length) throw new Error('Add at least one position to search for.');
  const skillList = [...new Set((skills || []).map(s => String(s).trim()).filter(Boolean))].slice(0, 40);
  const matchSkills = makeSkillMatcher(skillList);
  const candidateLevel = Number.isFinite(+level) && level !== '' && level != null ? +level
    : Math.round(parsed.reduce((a, r) => a + r.level, 0) / parsed.length);
  const globalRemote = /^remote/i.test(country);
  const wantSetup = globalRemote ? 'remote' : workSetup;
  // Each target title is searched on its own: one merged query returns whatever the
  // board thinks those words mean together, which is rarely any of the roles.
  const queries = [...new Set(parsed.map(r => r.label))].slice(0, 5);
  const sources = [];
  const jobs = [];

  // Whole-market boards. Remote-only boards are skipped when nothing there could
  // qualify.
  const boardTasks = BOARDS
    .filter(b => !(b.remoteOnly && (wantSetup === 'onsite' || wantSetup === 'hybrid')))
    .map(async b => {
      const errors = [];
      let got;
      try {
        if (b.fetch.length) {
          // One board's queries go one after another: in parallel they trip its
          // rate limit and the whole source reads as empty.
          got = [];
          for (const q of queries) {
            got.push(...await b.fetch(q).catch(e => { errors.push(e.message); return []; }));
            if (q !== queries[queries.length - 1]) await sleep(400);
          }
        } else {
          got = await b.fetch();
        }
      } catch (e) { errors.push(e.message); got = []; }
      // A query that failed is reported, not dressed up as "found nothing".
      sources.push(errors.length && !got.length
        ? { id: b.id, label: b.label, ok: false, error: errors[0] }
        : { id: b.id, label: b.label, ok: true, count: got.length, partial: errors.length > 0 });
      jobs.push(...got);
    });

  // The shortlist's own careers feeds — the part that works outside the remote market.
  const budget = { left: PROBE_BUDGET };
  const shortlist = [...new Set(companies.map(c => String(c || '').trim()).filter(Boolean))].slice(0, 16);
  let atsHits = 0;
  const atsTasks = [];
  const queue = shortlist.slice();
  for (let i = 0; i < 5; i++) {
    atsTasks.push((async () => {
      while (queue.length) {
        const company = queue.shift();
        const got = await probeCompany(company, budget);
        if (got.length) { atsHits++; jobs.push(...got); }
      }
    })());
  }

  await Promise.all([...boardTasks, ...atsTasks]);
  sources.push({ id: 'ats', label: 'Company careers feeds', ok: true, count: atsHits,
    note: `${atsHits} of ${shortlist.length} shortlisted companies publish a public feed` });

  // The cheap filters first: date, position, seniority, place, arrangement.
  const rejected = { date: 0, position: 0, country: 0, setup: 0, skills: 0, link: 0, duplicate: 0 };
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
  const future = Date.now() + 86400000;
  const seen = new Set();
  const pool = [];
  for (const p of jobs) {
    if (!p.url || !p.title || !p.company) { rejected.link++; continue; }
    const t = Date.parse(p.postedAt);
    // No date means we cannot vouch for it; a date in the future is a feed error.
    if (!t || t > future || (cutoff && t < cutoff)) { rejected.date++; continue; }
    const score = roleScore(p, parsed, candidateLevel);
    if (!score) { rejected.position++; continue; }
    if (wantSetup && p.workplace !== wantSetup) { rejected.setup++; continue; }
    const place = places.resolve(p.location, p.countries);
    const inPlace = globalRemote
      ? places.openWorldwide(place)
      : places.placeMatches(place, country, p.workplace === 'remote');
    if (!inPlace) { rejected.country++; continue; }
    const key = (p.company + '|' + p.title).toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) { rejected.duplicate++; continue; }
    seen.add(key);
    p.score = score;
    p.direct = DIRECT_SOURCES.has(p.source);
    pool.push(p);
  }

  // Then the expensive ones. Greenhouse postings are fetched one by one for their
  // description, which also proves the employer has not pulled them.
  const gh = pool.filter(p => p.source === 'greenhouse' && p.ref).slice(0, 40);
  const ghQueue = gh.slice();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (ghQueue.length) {
      const p = ghQueue.shift();
      const ok = await describeGreenhouse(p);
      if (ok === false) p.gone = true;
    }
  }));
  const ghChecked = new Set(gh);

  const all = [];
  for (const p of pool) {
    if (p.gone || (p.source === 'greenhouse' && !ghChecked.has(p))) { rejected.link++; continue; }
    const matched = matchSkills(p.title + ' ' + p.desc);
    // Skills are required whenever there are any: a title match alone let a Go role
    // through to a Java developer. A posting with no description to check is not
    // shown, because nothing backs it up.
    if (skillList.length && !matched.length) { rejected.skills++; continue; }
    p.matchedSkills = matched;
    p.score += Math.min(matched.length, 6);
    all.push(p);
  }

  // Freshest first. Within the same day, a posting on the employer's own careers
  // feed beats an aggregator's copy — it is the source, and its link outlives the
  // aggregator's — and then the better match wins.
  all.sort((a, b) => {
    const d = Date.parse(b.postedAt) - Date.parse(a.postedAt);
    if (Math.abs(d) > 43200000) return d;
    return (Number(b.direct) - Number(a.direct)) || (b.score - a.score) || d;
  });
  const want = Math.min(Number(limit) || 30, 40);
  const candidates = all.slice(0, want + 15);
  const verified = await verifyLinks(candidates, want, started + 45000);
  rejected.link += candidates.filter(p => p.linkState === 'dead').length;
  const shown = verified.slice(0, want).map(({ desc, ref, gone, countries, ...rest }) => rest);
  return {
    jobs: shown, sources, checked: shortlist.length, scanned: jobs.length,
    matched: all.length, rejected,
    filters: { country, workSetup: wantSetup, days, roles: parsed.map(r => r.label), skills: skillList, level: candidateLevel },
  };
}

module.exports = { search, BOARDS, ATS, _test: { skillForms, makeSkillMatcher, postingId, checkLink, normalise, roleScore, parseRole, iso } };
