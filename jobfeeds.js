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
        postedAt: x.publication_date, location: x.candidate_required_location,
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
        postedAt: x.pubDate, location: x.jobGeo,
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
        postedAt: x.epoch || x.date, location: x.location,
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
        postedAt: x.created_at, location: x.location,
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
      postedAt: x.createdAt,
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
      postedAt: x.publishedAt, location: x.location,
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
const STOP = new Set(['and', 'the', 'of', 'for', 'a', 'an', 'to', 'in', 'at', 'with', 'senior',
  'junior', 'lead', 'staff', 'principal', 'mid', 'level', 'i', 'ii', 'iii', 'jr', 'sr']);

function terms(roles) {
  const out = new Set();
  for (const r of roles || []) {
    for (const w of String(r).toLowerCase().split(/[^a-z0-9+#.]+/)) {
      if (w.length > 2 && !STOP.has(w)) out.add(w);
    }
  }
  return [...out];
}

// Words that appear in half the tech job titles ever written. On their own they say
// nothing: "Sales Engineer" should not match a search for "Backend Engineer".
const GENERIC = new Set(['software', 'engineer', 'engineering', 'developer', 'development',
  'manager', 'specialist', 'analyst', 'consultant', 'architect', 'technical', 'technology',
  'systems', 'system', 'application', 'applications', 'programmer', 'officer', 'associate']);

// A posting is relevant when its title carries a distinctive word from one of the
// target roles, or at least two of the generic ones. Titles are short, so this is
// strict enough to keep the list clean without needing the description.
function relevance(title, words) {
  const t = ' ' + String(title).toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ') + ' ';
  let distinct = 0, generic = 0;
  for (const w of words) {
    if (!t.includes(' ' + w) && !t.includes(w + ' ')) continue;
    if (GENERIC.has(w)) generic++; else distinct++;
  }
  if (distinct) return 1 + distinct;
  return generic >= 2 ? 1 : 0;
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
async function search({ roles = [], companies = [], country = '', workSetup = '', days = 7, limit = 60 } = {}) {
  const words = terms(roles);
  const queries = (roles || []).slice(0, 3).map(String);
  const sources = [];
  const all = [];

  const jobs = [];

  // Whole-market boards. A hybrid/onsite search still reads them, because a posting
  // may be tagged loosely, but they are skipped when nothing there could qualify.
  const boardTasks = BOARDS
    .filter(b => !(b.remoteOnly && (workSetup === 'onsite' || workSetup === 'hybrid')))
    .map(async b => {
      try {
        const got = b.fetch.length ? await b.fetch(queries[0] || '') : await b.fetch();
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
    if (relevance(p.title, words) <= 0) continue;
    if (!matchesCountry(p, country, workSetup)) continue;
    // An unknown arrangement is not a match. Feeds that omit it would otherwise pass
    // every filter, which is exactly how stale, irrelevant roles reached the list.
    if (workSetup && p.workplace !== workSetup) continue;
    const key = (p.company + '|' + p.title).toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    p.score = relevance(p.title, words);
    all.push(p);
  }

  all.sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
  const shown = await dropDeadLinks(all.slice(0, limit));
  return {
    jobs: shown, sources, checked: shortlist.length, scanned: jobs.length,
    dropped: Math.min(all.length, limit) - shown.length,
  };
}

module.exports = { search, BOARDS, ATS };
