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
const UA = 'Mozilla/5.0 (compatible; Offerly/1.2; +https://github.com/saadrazzaq/offerly)';
const REQ_TIMEOUT = 12000;
const PROBE_BUDGET = 60; // ATS requests per search, so a long shortlist cannot stall

async function getJSON(url, timeout = REQ_TIMEOUT) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.json();
}

// --- normalising ------------------------------------------------------------
const REMOTE_RE = /\b(remote|anywhere|work from home|wfh|distributed)\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const ANYWHERE_RE = /\b(worldwide|anywhere|global|any location)\b/i;

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
  if (remoteFlag === false && location) return 'onsite';
  return '';
}

function iso(v) {
  if (v == null || v === '') return '';
  let d;
  if (typeof v === 'number') d = new Date(v > 1e12 ? v : v * 1000); // ms or seconds
  else d = new Date(v);
  return isNaN(d) ? '' : d.toISOString();
}

// `desc` is the posting's own wording, used to check the resume's skills against
// the job description. It is stripped before anything is sent to the page.
function posting(o) {
  return {
    title: String(o.title || '').trim(),
    company: String(o.company || '').trim(),
    url: String(o.url || '').trim(),
    postedAt: iso(o.postedAt),
    location: String(o.location || '').trim(),
    workplace: o.workplace || '',
    source: o.source,
    sourceLabel: o.sourceLabel,
    desc: String(o.desc || '').replace(/<[^>]+>/g, ' ').slice(0, 4000),
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
        postedAt: x.pubDate, location: x.jobGeo, desc: x.jobExcerpt || x.jobDescription,
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
    parse: (j, company) => (j.jobs || []).map(x => posting({
      title: x.title, company, url: x.absolute_url,
      postedAt: x.first_published || x.updated_at,
      location: x.location && x.location.name,
      workplace: workplaceOf({ location: x.location && x.location.name, title: x.title }),
      source: 'greenhouse', sourceLabel: 'Greenhouse',
    })),
  },
  {
    id: 'lever', label: 'Lever',
    url: t => `https://api.lever.co/v0/postings/${t}?mode=json`,
    parse: (j, company) => (Array.isArray(j) ? j : []).map(x => posting({
      title: x.text, company, url: x.hostedUrl,
      postedAt: x.createdAt, desc: x.descriptionPlain,
      location: x.categories && x.categories.location,
      workplace: workplaceOf({
        explicit: x.workplaceType,
        location: x.categories && x.categories.location, title: x.text,
      }),
      source: 'lever', sourceLabel: 'Lever',
    })),
  },
  {
    id: 'ashby', label: 'Ashby',
    url: t => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    parse: (j, company) => (j.jobs || []).filter(x => x.isListed !== false).map(x => posting({
      title: x.title, company, url: x.jobUrl || x.applyUrl,
      postedAt: x.publishedAt, location: x.location, desc: x.descriptionPlain,
      workplace: workplaceOf({ explicit: x.workplaceType, location: x.location, title: x.title, remoteFlag: x.isRemote }),
      source: 'ashby', sourceLabel: 'Ashby',
    })),
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

async function probeCompany(company, budget) {
  for (const token of tokensFor(company)) {
    for (const ats of ATS) {
      if (budget.left <= 0) return [];
      budget.left--;
      try {
        const j = await getJSON(ats.url(token), 9000);
        const jobs = ats.parse(j, company).filter(p => p.url && p.title);
        if (jobs.length) return jobs;
      } catch (_) { /* 404 just means this company is not on that ATS */ }
    }
  }
  return [];
}

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

// Spellings that split or join the same word.
function normalise(text) {
  return ' ' + String(text).toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
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

// Skills from the resume, looked for in the posting's own text. Used to rank, and to
// confirm the weak matches above rather than to let new ones in.
function skillHits(text, skills) {
  if (!text || !skills.length) return 0;
  const t = normalise(text);
  let n = 0;
  for (const sk of skills) {
    const w = normalise(sk).trim();
    if (w.length > 2 && t.includes(' ' + w + ' ')) n++;
  }
  return n;
}

// Returns 0 to reject. Higher is a better match.
function relevance(p, roles, skills, candidateLevel) {
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

  const hits = skillHits((p.title || '') + ' ' + (p.desc || ''), skills);
  if (best === 1 && !hits) return 0;            // vague title, nothing to back it up
  return best + Math.min(hits, 4);
}

// Feed locations are free text ("Dubai, UAE", "Lausanne, Vaud", "Remote - EMEA"), so
// a country has to be recognised from its name, its code or one of its main cities.
// Matching is on whole words: a plain substring test reports that "lausanne" is in
// the United States, because it contains "usa".
const GEO = {
  'united states': ['usa', 'us', 'u.s.', 'u.s.a.', 'united states', 'new york', 'nyc', 'san francisco', 'bay area', 'seattle', 'austin', 'boston', 'chicago', 'los angeles', 'denver', 'atlanta'],
  'united kingdom': ['uk', 'u.k.', 'united kingdom', 'england', 'scotland', 'wales', 'london', 'manchester', 'edinburgh', 'bristol', 'cambridge', 'leeds', 'glasgow'],
  'canada': ['canada', 'ca', 'toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', 'waterloo'],
  'germany': ['germany', 'deutschland', 'de', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'köln', 'stuttgart', 'düsseldorf', 'leipzig'],
  'netherlands': ['netherlands', 'holland', 'nl', 'amsterdam', 'rotterdam', 'utrecht', 'eindhoven', 'the hague'],
  'ireland': ['ireland', 'ie', 'dublin', 'cork', 'galway'],
  'france': ['france', 'fr', 'paris', 'lyon', 'toulouse', 'marseille', 'bordeaux', 'lille', 'nantes'],
  'switzerland': ['switzerland', 'ch', 'suisse', 'zurich', 'zürich', 'geneva', 'genève', 'lausanne', 'basel', 'bern', 'zug'],
  'sweden': ['sweden', 'se', 'stockholm', 'gothenburg', 'göteborg', 'malmö'],
  'spain': ['spain', 'es', 'españa', 'madrid', 'barcelona', 'valencia', 'seville', 'malaga', 'málaga'],
  'poland': ['poland', 'pl', 'polska', 'warsaw', 'warszawa', 'krakow', 'kraków', 'wroclaw', 'wrocław', 'gdansk', 'poznan'],
  'united arab emirates': ['uae', 'u.a.e.', 'united arab emirates', 'emirates', 'dubai', 'abu dhabi', 'sharjah', 'ajman', 'dxb'],
  'saudi arabia': ['saudi arabia', 'saudi', 'ksa', 'sa', 'riyadh', 'jeddah', 'dammam', 'khobar', 'neom', 'mecca', 'medina'],
  'qatar': ['qatar', 'qa', 'doha'],
  'pakistan': ['pakistan', 'pk', 'karachi', 'lahore', 'islamabad', 'rawalpindi', 'faisalabad', 'peshawar'],
  'india': ['india', 'in', 'bangalore', 'bengaluru', 'hyderabad', 'mumbai', 'delhi', 'ncr', 'gurgaon', 'gurugram', 'noida', 'pune', 'chennai', 'kolkata'],
  'singapore': ['singapore', 'sg'],
  'australia': ['australia', 'au', 'sydney', 'melbourne', 'brisbane', 'perth', 'canberra', 'adelaide'],
  'new zealand': ['new zealand', 'nz', 'auckland', 'wellington', 'christchurch'],
  'japan': ['japan', 'jp', 'tokyo', 'osaka', 'kyoto', 'yokohama'],
  'hong kong': ['hong kong', 'hk', 'hongkong'],
  'malaysia': ['malaysia', 'my', 'kuala lumpur', 'penang', 'johor'],
  'turkey': ['turkey', 'türkiye', 'turkiye', 'tr', 'istanbul', 'ankara', 'izmir'],
  'portugal': ['portugal', 'pt', 'lisbon', 'lisboa', 'porto', 'braga'],
  'italy': ['italy', 'italia', 'it', 'milan', 'milano', 'rome', 'roma', 'turin', 'torino', 'bologna', 'naples'],
  'norway': ['norway', 'no', 'oslo', 'bergen', 'trondheim'],
  'denmark': ['denmark', 'dk', 'copenhagen', 'københavn', 'aarhus'],
  'finland': ['finland', 'fi', 'helsinki', 'espoo', 'tampere'],
  'belgium': ['belgium', 'be', 'brussels', 'bruxelles', 'antwerp', 'ghent', 'leuven'],
  'austria': ['austria', 'at', 'österreich', 'vienna', 'wien', 'graz', 'linz', 'salzburg'],
  'czech republic': ['czech republic', 'czechia', 'cz', 'prague', 'praha', 'brno', 'ostrava'],
  'romania': ['romania', 'ro', 'bucharest', 'bucuresti', 'cluj', 'timisoara', 'iasi'],
  'estonia': ['estonia', 'ee', 'tallinn', 'tartu'],
  'israel': ['israel', 'il', 'tel aviv', 'jerusalem', 'haifa', 'herzliya'],
  'south africa': ['south africa', 'za', 'cape town', 'johannesburg', 'joburg', 'durban', 'pretoria'],
  'egypt': ['egypt', 'eg', 'cairo', 'alexandria', 'giza'],
  'nigeria': ['nigeria', 'ng', 'lagos', 'abuja', 'ibadan'],
  'kenya': ['kenya', 'ke', 'nairobi', 'mombasa'],
  'brazil': ['brazil', 'brasil', 'br', 'sao paulo', 'são paulo', 'rio de janeiro', 'belo horizonte', 'curitiba'],
  'mexico': ['mexico', 'méxico', 'mx', 'mexico city', 'guadalajara', 'monterrey'],
  'argentina': ['argentina', 'ar', 'buenos aires', 'cordoba', 'córdoba', 'rosario'],
};
const GEO_RE = new Map();
function geoMatcher(country) {
  const key = String(country || '').toLowerCase().replace(/\s*\(.*\)$/, '').trim();
  if (GEO_RE.has(key)) return GEO_RE.get(key);
  const aliases = GEO[key] || (key ? [key] : []);
  const re = aliases.length
    ? new RegExp('(^|[^a-z0-9])(' + aliases.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')([^a-z0-9]|$)', 'i')
    : null;
  GEO_RE.set(key, re);
  return re;
}

function matchesCountry(p, country, workSetup) {
  // "Remote (Global)" is not a place: it means the role itself must be remote.
  if (!country || /^remote/i.test(country)) return p.workplace === 'remote';
  const loc = p.location || '';
  // A posting with no stated location cannot be placed in the requested country.
  // Several feeds carry such entries; showing them is what made results look wrong.
  if (!loc.trim()) return workSetup === 'remote' && p.workplace === 'remote';
  if (ANYWHERE_RE.test(loc)) return true;          // open to any location, so also this one
  const re = geoMatcher(country);
  if (re && re.test(loc)) return true;
  // Someone who asked for remote work will take a remote role advertised elsewhere.
  return workSetup === 'remote' && p.workplace === 'remote';
}

// --- link checking ----------------------------------------------------------
// A feed can list a posting that the employer has already taken down, and a dead
// link is the single most annoying thing this page could hand someone. Only the
// postings actually about to be shown are checked, so the cost stays small.
// Anything that cannot be reached at all (a network error, a site blocking us) is
// kept: the failure is ours, not the link's.
async function linkAlive(url) {
  try {
    const r = await fetch(url, {
      method: 'GET', redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 404 || r.status === 410) return false;
    return true;
  } catch (_) {
    return true; // could not check — do not punish the posting for our own failure
  }
}

async function dropDeadLinks(list) {
  const results = await Promise.all(list.map(async p => (await linkAlive(p.url)) ? p : null));
  return results.filter(Boolean);
}

// --- public entry point -----------------------------------------------------
// roles      target job titles from the resume analysis
// companies  the shortlist the model produced, checked against their own careers feed
// days       only postings published within this many days (0 = any age)
// workSetup  '', 'remote', 'hybrid' or 'onsite'
async function search({ roles = [], companies = [], country = '', workSetup = '',
                        days = 7, limit = 60, skills = [], level } = {}) {
  const parsed = (roles || []).map(String).filter(Boolean).slice(0, 8).map(parseRole)
    .filter(r => r.key.length || r.heads.length);
  const skillList = (skills || []).map(String).filter(Boolean).slice(0, 25);
  const candidateLevel = Number.isFinite(+level) ? +level
    : (parsed.length ? Math.round(parsed.reduce((a, r) => a + r.level, 0) / parsed.length) : undefined);
  // Each target title is searched on its own: one merged query returns whatever the
  // board thinks those words mean together, which is rarely any of the roles.
  const queries = [...new Set(parsed.map(r => r.label))].slice(0, 3);
  const sources = [];
  const all = [];

  const jobs = [];

  // Whole-market boards. A hybrid/onsite search still reads them, because a posting
  // may be tagged loosely, but they are skipped when nothing there could qualify.
  const boardTasks = BOARDS
    .filter(b => !(b.remoteOnly && (workSetup === 'onsite' || workSetup === 'hybrid')))
    .map(async b => {
      try {
        let got;
        if (b.fetch.length) {
          const runs = await Promise.all((queries.length ? queries : ['']).map(q =>
            b.fetch(q).catch(() => [])));
          got = runs.flat();
        } else {
          got = await b.fetch();
        }
        sources.push({ id: b.id, label: b.label, ok: true, count: got.length });
        jobs.push(...got);
      } catch (e) {
        sources.push({ id: b.id, label: b.label, ok: false, error: e.message });
      }
    });

  // The shortlist's own careers feeds — the part that works outside the remote market.
  const budget = { left: PROBE_BUDGET };
  const shortlist = [...new Set(companies.map(c => String(c || '').trim()).filter(Boolean))].slice(0, 14);
  let atsHits = 0;
  const atsTasks = [];
  const queue = shortlist.slice();
  const WORKERS = 5;
  for (let i = 0; i < WORKERS; i++) {
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

  // Filter: fresh, relevant, right country, right arrangement.
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
  const seen = new Set();
  for (const p of jobs) {
    if (!p.url || !p.title || !p.company) continue;
    if (!p.postedAt) continue;                       // no date means we cannot vouch for it
    if (cutoff && Date.parse(p.postedAt) < cutoff) continue;
    const score = relevance(p, parsed, skillList, candidateLevel);
    if (score <= 0) continue;
    if (!matchesCountry(p, country, workSetup)) continue;
    // An unknown arrangement is not a match. Feeds that omit it would otherwise pass
    // every filter, which is exactly how stale, irrelevant roles reached the list.
    if (workSetup && p.workplace !== workSetup) continue;
    const key = (p.company + '|' + p.title).toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    p.score = score;
    all.push(p);
  }

  // Freshest first, but a clearly better match wins a tie on the same day.
  all.sort((a, b) => {
    const d = Date.parse(b.postedAt) - Date.parse(a.postedAt);
    if (Math.abs(d) > 43200000) return d;
    return (b.score - a.score) || d;
  });
  const shown = (await dropDeadLinks(all.slice(0, limit))).map(({ desc, ...rest }) => rest);
  return {
    jobs: shown, sources, checked: shortlist.length, scanned: jobs.length,
    dropped: Math.min(all.length, limit) - shown.length,
  };
}

module.exports = { search, BOARDS, ATS };
