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
const SEEDS = require('./seeds');
const websearch = require('./websearch');
const UA = 'Mozilla/5.0 (compatible; Offerly/1.2; +https://github.com/saadrazzaq/offerly)';
const REQ_TIMEOUT = 12000;
const PROBE_BUDGET = 260; // board lookups per search, so a long shortlist cannot stall

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

// The same, for feeds that are not JSON (RSS).
async function getText(url, timeout = REQ_TIMEOUT) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, text/xml, */*' }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  const data = await r.text();
  cache.set(url, { at: Date.now(), data });
  return data;
}
const rssField = (item, k) => decodeEntities(((item.match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`)) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '')).trim();

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
    let s = String(v).trim();
    // "2026-09-29 12:53:30 UTC" (Recruitee) is not a format Date is required to read.
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(?:UTC|GMT|Z)?$/i);
    if (m) s = `${m[1]}T${m[2]}Z`;
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
    // The source's own statement that the posting is open until this moment.
    expires: iso(o.expires),
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
    // Remote roles with the countries each is open to spelled out; an empty list is
    // worldwide. Asked for the target country, it returns the roles open to it.
    id: 'himalayas', label: 'Himalayas', remoteOnly: true,
    async fetch(q, ctx = {}) {
      const where = ctx.worldwide ? '&worldwide=true' : ctx.iso ? '&country=' + encodeURIComponent(ctx.iso) : '';
      const j = await getJSON('https://himalayas.app/jobs/api/search?q=' + encodeURIComponent(q) + where);
      return (j.jobs || []).map(x => {
        const only = (x.locationRestrictions || []).filter(Boolean);
        return posting({
          title: x.title, company: x.companyName, url: x.applicationLink || x.guid,
          postedAt: x.pubDate, expires: x.expiryDate,
          location: only.length ? only.join(' / ') : 'Worldwide', countries: only,
          desc: x.description || x.excerpt, workplace: 'remote', source: 'himalayas', sourceLabel: 'Himalayas',
        });
      });
    },
  },
  {
    // Workable's own job search, across every employer that hires through Workable —
    // common with Gulf employers. These are the employers' own postings (published
    // state, their stated arrangement), found without having to know the employer.
    id: 'workablesearch', label: 'Workable (all employers)', remoteOnly: false, direct: true,
    async fetch(q, ctx = {}) {
      const out = [];
      let token = '';
      for (let page = 0; page < 2; page++) {
        const where = ctx.countryName ? '&location=' + encodeURIComponent(ctx.countryName) : '';
        const j = await getJSON('https://jobs.workable.com/api/v1/jobs?query=' + encodeURIComponent(q) + where + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
        for (const x of j.jobs || []) {
          if (x.state && x.state !== 'published') continue;
          const w = { on_site: 'onsite', hybrid: 'hybrid', remote: 'remote' }[String(x.workplace || '').toLowerCase()] || '';
          const l = x.location || {};
          const p = posting({
            title: x.title, company: x.company && x.company.title, url: x.url,
            postedAt: x.created, desc: [x.description, x.requirementsSection].join(' '),
            location: (x.locations || []).filter(s => !/^telecommute$/i.test(s)).join(' / ') || [l.city, l.countryName].filter(Boolean).join(', '),
            countries: [l.countryName], workplace: w, source: 'workable', sourceLabel: 'Workable',
          });
          p.workplaceStated = !!w;
          out.push(p);
        }
        token = j.nextPageToken;
        if (!token || (j.jobs || []).length < 20) break;
      }
      return out;
    },
  },
  {
    // Its category feeds, read whole; a title is "Company: Role" and the region says
    // who may apply ("Anywhere in the World", "USA Only").
    id: 'weworkremotely', label: 'We Work Remotely', remoteOnly: true,
    async fetch() {
      const cats = ['remote-programming-jobs', 'remote-full-stack-programming-jobs', 'remote-back-end-programming-jobs',
        'remote-front-end-programming-jobs', 'remote-devops-sysadmin-jobs', 'remote-design-jobs', 'remote-product-jobs',
        'remote-customer-support-jobs', 'remote-sales-and-marketing-jobs', 'remote-management-and-finance-jobs', 'all-other-remote-jobs'];
      const out = [];
      await Promise.all(cats.map(async c => {
        const xml = await getText(`https://weworkremotely.com/categories/${c}.rss`).catch(() => '');
        for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
          const whole = rssField(m[1], 'title');
          const i = whole.indexOf(':');
          out.push(posting({
            title: i > 0 ? whole.slice(i + 1) : whole, company: i > 0 ? whole.slice(0, i) : '',
            url: rssField(m[1], 'link'), postedAt: rssField(m[1], 'pubDate'),
            location: rssField(m[1], 'region'), desc: rssField(m[1], 'description'),
            workplace: 'remote', source: 'weworkremotely', sourceLabel: 'We Work Remotely',
          }));
        }
      }));
      return out;
    },
  },
  {
    id: 'workingnomads', label: 'Working Nomads', remoteOnly: true,
    async fetch() {
      const j = await getJSON('https://www.workingnomads.com/api/exposed_jobs/');
      return (Array.isArray(j) ? j : []).map(x => posting({
        title: x.title, company: x.company_name || x.company, url: x.url,
        postedAt: x.pub_date, location: x.location, desc: x.description,
        workplace: 'remote', source: 'workingnomads', sourceLabel: 'Working Nomads',
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
// Each employer publishes its openings through one applicant-tracking system. These
// all have a public, keyless feed of the employer's open postings — the same feed its
// own careers page is built from — so a posting found here is open by the employer's
// own account, at the address the employer gives it.
//   name(j)    the employer's name as the feed states it, to check whose board it is
//   parse      the feed's postings; `ref` is how to ask about one posting again
//   detail     (optional) one posting's full record: description, arrangement, and
//              whether it is still published — asked only for postings that survive
//              the cheap filters
const ATS = [
  {
    id: 'greenhouse', label: 'Greenhouse',
    url: t => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=false`,
    name: j => (j.jobs || []).map(x => x.company_name).find(Boolean),
    // Only `first_published` is the posting date. `updated_at` changes whenever the
    // employer touches the job, so a role opened two years ago and edited yesterday
    // passed a "past 24 hours" filter. No first_published, no date, no posting.
    parse: (j, company, token) => (j.jobs || []).map(x => posting({
      title: x.title, company, url: x.absolute_url,
      postedAt: x.first_published,
      location: x.location && x.location.name,
      workplace: workplaceOf({ location: x.location && x.location.name, title: x.title }),
      source: 'greenhouse', sourceLabel: 'Greenhouse', ref: { token, id: x.id },
    })),
    // The list carries no description. A posting the employer has pulled answers 404.
    async detail(p) {
      const j = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${p.ref.token}/jobs/${p.ref.id}`, 9000);
      p.desc = plain(j.content).slice(0, 12000);
      return true;
    },
  },
  {
    id: 'lever', label: 'Lever',
    // Lever runs a separate EU instance; its boards are found as "eu:<token>".
    url: t => t.startsWith('eu:') ? `https://api.eu.lever.co/v0/postings/${t.slice(3)}?mode=json` : `https://api.lever.co/v0/postings/${t}?mode=json`,
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
  {
    // Common with Gulf employers: Salla, Foodics, Lucidya and Mozn all hire through it.
    id: 'workable', label: 'Workable',
    url: t => `https://apply.workable.com/api/v1/widget/accounts/${t}`,
    name: j => j.name,
    parse: (j, company, token) => (j.jobs || []).map(x => {
      const locs = (x.locations && x.locations.length ? x.locations : [{ city: x.city, region: x.state, country: x.country }]).filter(l => !l.hidden);
      return posting({
        title: x.title, company: j.name || company, url: x.shortlink || x.url,
        postedAt: x.published_on || x.created_at,
        location: locs.map(l => [l.city, l.region, l.country].filter(Boolean).join(', ')).join(' / '),
        countries: locs.map(l => l.countryCode || l.country),
        // The list only says whether a role is remote; the posting says which of
        // on-site, hybrid or remote it is.
        workplace: x.telecommuting ? 'remote' : '',
        source: 'workable', sourceLabel: 'Workable', ref: { token, id: x.shortcode },
      });
    }),
    async detail(p) {
      const j = await getJSON(`https://apply.workable.com/api/v2/accounts/${p.ref.token}/jobs/${p.ref.id}`, 9000);
      if (j.state && j.state !== 'published') return false;
      p.desc = plain([j.description, j.requirements].join(' ')).slice(0, 12000);
      const w = { on_site: 'onsite', onsite: 'onsite', hybrid: 'hybrid', remote: 'remote' }[String(j.workplace || '').toLowerCase()];
      if (w) { p.workplace = w; p.workplaceStated = true; } else if (j.remote) { p.workplace = 'remote'; p.workplaceStated = true; }
      return true;
    },
  },
  {
    id: 'recruitee', label: 'Recruitee',
    url: t => `https://${t}.recruitee.com/api/offers/`,
    name: j => (j.offers || []).map(x => x.company_name).find(Boolean),
    parse: (j, company, token) => (j.offers || []).filter(x => !x.status || x.status === 'published').map(x => {
      const locs = x.locations || [];
      const w = x.remote ? 'remote' : x.hybrid ? 'hybrid' : x.on_site ? 'onsite' : '';
      const p = posting({
        title: x.title, company: x.company_name || company, url: x.careers_url,
        postedAt: x.published_at,
        desc: [x.description, x.requirements].join(' '),
        location: locs.length ? locs.map(l => [l.city, l.country].filter(Boolean).join(', ') || l.name).join(' / ') : x.location,
        // Location names are the employer's own words; the codes beside them are
        // sometimes wrong ("Turkey" filed as TC, the Turks and Caicos), so they are
        // not used.
        workplace: w, source: 'recruitee', sourceLabel: 'Recruitee', ref: { token, slug: x.slug },
      });
      p.workplaceStated = !!w;
      return p;
    }),
  },
  {
    id: 'smartrecruiters', label: 'SmartRecruiters',
    url: t => `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100`,
    name: j => (j.content || []).map(x => x.company && x.company.name).find(Boolean),
    parse: (j, company, token) => (j.content || []).map(x => {
      const l = x.location || {};
      const w = l.remote ? 'remote' : l.hybrid ? 'hybrid' : '';
      return posting({
        title: x.name, company: (x.company && x.company.name) || company,
        url: `https://jobs.smartrecruiters.com/${token}/${x.id}`,
        postedAt: x.releasedDate,
        location: [l.city, l.region, l.country && l.country.toUpperCase()].filter(Boolean).join(', '),
        countries: [l.country && l.country.toUpperCase()],
        workplace: w, source: 'smartrecruiters', sourceLabel: 'SmartRecruiters', ref: { token, id: x.id },
      });
    }),
    async detail(p) {
      const j = await getJSON(`https://api.smartrecruiters.com/v1/companies/${p.ref.token}/postings/${p.ref.id}`, 9000);
      if (j.active === false) return false;
      const s = (j.jobAd && j.jobAd.sections) || {};
      p.desc = plain(['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription'].map(k => s[k] && s[k].text).join(' ')).slice(0, 12000);
      if (j.postingUrl) p.url = j.postingUrl;
      const l = j.location || {};
      if (l.remote) { p.workplace = 'remote'; p.workplaceStated = true; } else if (l.hybrid) { p.workplace = 'hybrid'; p.workplaceStated = true; }
      return true;
    },
  },
  {
    id: 'breezy', label: 'Breezy',
    url: t => `https://${t}.breezy.hr/json`,
    parse: (j, company) => (Array.isArray(j) ? j : []).map(x => {
      const l = x.location || {};
      return posting({
        title: x.name, company, url: x.url, postedAt: x.published_date,
        location: l.name || [l.city, l.country && l.country.name].filter(Boolean).join(', '),
        countries: [l.country && (l.country.id || l.country.name)],
        workplace: l.is_remote ? 'remote' : workplaceOf({ location: l.name, title: x.name }),
        source: 'breezy', sourceLabel: 'Breezy',
      });
    }),
  },
];
// Workday, which most multinationals hire through, is searched rather than read
// whole: a large employer has thousands of postings. Its career site offers the
// search by keyword and a location filter; the postings are narrowed to the target
// country by the filter values that name it. A board is "<tenant>.<wdN>/<site>".
const WORKDAY_AGO = /posted\s+(today|yesterday|(\d+)\+?\s+days?\s+ago)/i;
function workdayPostedOn(s) {
  const m = String(s || '').match(WORKDAY_AGO);
  if (!m) return '';
  // "30+ Days Ago" is older than anything a posting window allows.
  const days = /today/i.test(m[1]) ? 0 : /yesterday/i.test(m[1]) ? 1 : /\+/.test(m[0]) ? 45 : Number(m[2]);
  return new Date(Date.now() - days * 86400000).toISOString();
}
function workdayParts(token) {
  const [host, site] = String(token).split('/');
  const tenant = host.split('.')[0];
  const base = `https://${host}.myworkdayjobs.com`;
  return { base, site, api: `${base}/wday/cxs/${tenant}/${site}` };
}
async function postJSON(url, body, timeout = REQ_TIMEOUT) {
  const key = url + '|' + JSON.stringify(body);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const r = await fetch(url, {
    method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json' },
  });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  const data = await r.json();
  cache.set(key, { at: Date.now(), data });
  return data;
}
function flatFacets(list, out = []) {
  for (const f of list || []) {
    if ((f.values || []).some(v => v.values)) flatFacets(f.values, out);
    else if (f.facetParameter) out.push(f);
  }
  return out;
}
ATS.push({
  id: 'workday', label: 'Workday', searched: true,
  async search(token, company, want) {
    if (!want.countryKey) return [];     // a worldwide remote search is not what these sites index well
    const { base, site, api } = workdayParts(token);
    const out = [];
    for (const q of want.queries.slice(0, 3)) {
      const first = await postJSON(api + '/jobs', { appliedFacets: {}, limit: 20, offset: 0, searchText: q });
      // The filter values that name the country ("Riyadh, Saudi Arabia", "KSA - Jeddah").
      let applied = null;
      for (const f of flatFacets(first.facets)) {
        if (!/location|country/i.test(f.facetParameter)) continue;
        const ids = (f.values || []).filter(v => places.resolve(v.descriptor).countries.has(want.countryKey)).map(v => v.id);
        if (ids.length && (!applied || /country|hierarchy/i.test(f.facetParameter))) applied = { [f.facetParameter]: ids };
      }
      if (!applied) continue;             // nothing for this search in that country
      const j = await postJSON(api + '/jobs', { appliedFacets: applied, limit: 20, offset: 0, searchText: q });
      for (const x of j.jobPostings || []) {
        if (!x.externalPath) continue;
        out.push(posting({
          title: x.title, company, url: `${base}/${site}${x.externalPath}`,
          postedAt: workdayPostedOn(x.postedOn), location: x.locationsText, countries: [want.countryKey],
          source: 'workday', sourceLabel: 'Workday', ref: { token, path: x.externalPath },
        }));
      }
    }
    return out;
  },
  // The posting's own record: its real publication date, every location, how the
  // work is arranged, and whether it can still be applied to.
  async detail(p) {
    const { api } = workdayParts(p.ref.token);
    const j = await getJSON(api + p.ref.path, 9000);
    const i = j.jobPostingInfo || {};
    if (i.canApply === false || i.posted === false) return false;
    if (i.startDate) p.postedAt = iso(i.startDate);
    p.location = [i.location, ...(i.additionalLocations || [])].filter(Boolean).join(' / ') || p.location;
    p.countries = [i.country && i.country.descriptor];
    p.desc = plain(i.jobDescription).slice(0, 12000);
    if (i.externalUrl) p.url = i.externalUrl;
    const rt = String(i.remoteType || '');
    const w = /remote/i.test(rt) ? 'remote' : /hybrid|flexible/i.test(rt) ? 'hybrid' : /on-?site|office/i.test(rt) ? 'onsite' : '';
    if (w) { p.workplace = w; p.workplaceStated = true; }
    return true;
  },
});
const ATS_BY_ID = Object.fromEntries(ATS.map(a => [a.id, a]));

// Companies do not publish their board's name, so it has to be found. Two ways:
//   their own careers page, which links to the board   (found, and certainly theirs)
//   the company name, guessed as a board name           (checked before it is used)
function tokensFor(company) {
  const base = String(company || '').toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|plc|group|technologies|technology|labs|software|pvt|private)\b/g, ' ')
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

// A board found by guessing the name is used only if it is provably this company's:
// the feed names the employer, or its postings do. "jobs.lever.co/nana" could be any
// company called Nana.
function boardIsTheirs(ats, j, jobs, company) {
  const said = ats.name && ats.name(j);
  if (said) return nameMatches(said, company);
  const re = new RegExp('(^|[^a-z0-9])' + String(company).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i');
  return jobs.some(p => re.test(p.desc) || re.test(p.url));
}

// Links to a job board, as they appear in a careers page.
const BOARD_LINKS = [
  ['greenhouse', /greenhouse\.io\/embed\/job_board(?:\/js)?\?(?:[^"'\s]*&)?for=([a-z0-9_-]+)/i],
  ['greenhouse', /(?:boards|job-boards)\.greenhouse\.io\/(?!embed\b)([a-z0-9_-]+)/i],
  ['lever', /jobs\.eu\.lever\.co\/([a-z0-9_.-]+)/i, t => 'eu:' + t],
  ['lever', /jobs\.lever\.co\/([a-z0-9_.-]+)/i],
  ['ashby', /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/i],
  ['workable', /apply\.workable\.com\/(?!api\b|j\b)([a-z0-9_-]+)/i],
  // Recruitee's own script hosts ("careers-analytics", "tagging-server") appear on
  // every careers page it powers and are not boards.
  ['recruitee', /\/\/(?!(?:www|app|careers|careers-analytics|tagging-server|api|cdn|static|assets)\.)([a-z0-9-]+)\.recruitee\.com/i],
  ['smartrecruiters', /(?:jobs|careers)\.smartrecruiters\.com\/(?!oneclick|sr-jobs|widgets)([a-z0-9_-]+)/i],
  ['breezy', /\/\/(?!www\.|app\.|assets\.)([a-z0-9-]+)\.breezy\.hr/i],
  ['workday', /\/\/([a-z0-9-]+\.wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?(?!wday\b)([A-Za-z0-9_-]+)/, (host, site) => host.toLowerCase() + '/' + site],
];
function boardsInPage(html, finalUrl) {
  const found = [];
  const hay = String(finalUrl || '') + ' ' + String(html || '');
  for (const [ats, re, map] of BOARD_LINKS) {
    const m = hay.match(re);
    if (!m) continue;
    const token = map ? map(m[1], m[2]) : m[1];
    if (!found.some(b => b.ats === ats && b.token.toLowerCase() === token.toLowerCase())) found.push({ ats, token });
  }
  return found;
}
// A company's website comes from the page (the recruiter's shortlist), so it is
// treated as untrusted: only a public name that resolves only to public addresses is
// fetched, and each redirect is checked the same way before it is followed. Without
// this, "domain" could point the server at its own network.
const dns = require('dns').promises;
function privateIp(ip) {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const m = v4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const h = ip.toLowerCase();
  return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
}
async function publicHost(host) {
  const h = String(host || '').toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) || /\.(internal|local|localhost|lan|home|corp|intranet|test|invalid|example)$/.test(h)) return false;
  try {
    const addrs = await dns.lookup(h, { all: true });
    return addrs.length > 0 && addrs.every(a => !privateIp(a.address));
  } catch (_) { return false; }
}
async function fetchPublic(url, opts) {
  let u = url;
  for (let hop = 0; hop < 4; hop++) {
    const p = new URL(u);
    if (!/^https?:$/.test(p.protocol) || !(await publicHost(p.hostname))) throw new Error('not a public address');
    const r = await fetch(u, { ...opts, redirect: 'manual' });
    const next = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!next) return { r, finalUrl: u };
    u = new URL(next, u).href;
  }
  throw new Error('too many redirects');
}
async function boardsFromSite(domain, budget) {
  const d = String(domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return [];
  for (const u of [`https://${d}/careers`, `https://careers.${d}`, `https://${d}/jobs`, `https://jobs.${d}`, `https://www.${d}/careers`]) {
    if (budget.left <= 0) return [];
    budget.left--;
    try {
      const { r, finalUrl } = await fetchPublic(u, {
        signal: AbortSignal.timeout(9000),
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36', accept: 'text/html' },
      });
      if (!r.ok) continue;
      const found = boardsInPage((await r.text()).slice(0, 800000), finalUrl);
      if (found.length) return found;
    } catch (_) { /* no such page, or not a public one */ }
  }
  return [];
}

// What was found for a company is remembered, so the next search goes straight to its
// board — or skips a company known to have none. Kept on disk next to the other local
// files when there is a disk; a hosted copy keeps it in memory only.
const BOARD_CACHE_FILE = require('path').join(__dirname, 'offerly.boards.json');
const FOUND_TTL = 14 * 86400000, NONE_TTL = 3 * 86400000;
let boardCache = null;
function boardMemo() {
  if (!boardCache) {
    boardCache = new Map();
    try { for (const [k, v] of Object.entries(JSON.parse(require('fs').readFileSync(BOARD_CACHE_FILE, 'utf8')))) boardCache.set(k, v); } catch (_) {}
  }
  return boardCache;
}
function rememberBoards(key, boards) {
  const m = boardMemo();
  m.set(key, { at: Date.now(), boards });
  try { require('fs').writeFileSync(BOARD_CACHE_FILE, JSON.stringify(Object.fromEntries(m))); } catch (_) {}
}

// A company's open postings from its own board(s). `budget.want` carries what the
// searched systems (Workday) need: the queries and the target country.
async function probeCompany(company, budget) {
  const name = typeof company === 'string' ? company : company.name;
  const domain = typeof company === 'string' ? '' : company.domain;
  const key = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const memo = boardMemo().get(key);
  const want = budget.want || { queries: [], countryKey: '' };
  const read = async ({ ats, token }) => {
    const a = ATS_BY_ID[ats];
    if (a.searched) return { a, j: null, jobs: (await a.search(token, name, want)).filter(p => p.url && p.title) };
    const j = await getJSON(a.url(token), 9000);
    // The employer's name as its own board states it, where the board does.
    const said = (a.name && a.name(j)) || '';
    return { a, j, jobs: a.parse(j, said && nameMatches(said, name) ? said : name, token).filter(p => p.url && p.title) };
  };
  const readAll = async boards => {
    const out = [];
    for (const b of boards) { if (ATS_BY_ID[b.ats]) { try { out.push(...(await read(b)).jobs); } catch (_) {} } }
    return out;
  };
  // A board already known for this company: a seed, or one found before.
  if (company.board && ATS_BY_ID[company.board.ats]) return readAll([company.board]);
  if (memo && Date.now() - memo.at < (memo.boards.length ? FOUND_TTL : NONE_TTL)) return readAll(memo.boards);
  // Its own careers page first: a board it links to is certainly its own, whether or
  // not it has anything open today.
  const linked = (domain ? await boardsFromSite(domain, budget) : []).filter(b => ATS_BY_ID[b.ats]);
  if (linked.length) {
    rememberBoards(key, linked);
    return readAll(linked);
  }
  // Then its name, as each system would spell it. Searched systems cannot be guessed.
  // "Not on this system" is remembered only when every system said so plainly; a
  // timeout or a rate limit is not an answer, and remembering it as one hid real
  // boards for days.
  let unsure = false;
  for (const token of tokensFor(name)) {
    for (const a of ATS.filter(x => !x.searched)) {
      if (budget.left <= 0) return [];
      budget.left--;
      try {
        const { j, jobs } = await read({ ats: a.id, token });
        if (!jobs.length || !boardIsTheirs(a, j, jobs, name)) continue;   // someone else's board
        rememberBoards(key, [{ ats: a.id, token }]);
        return jobs;
      } catch (e) {
        const plainNo = e.status === 404 || e.status === 400 || e.status === 410
          || (e.cause && e.cause.code === 'ENOTFOUND') || e instanceof SyntaxError;
        if (!plainNo) unsure = true;
      }
    }
  }
  if (!unsure) rememberBoards(key, []);
  return [];
}

// An employer's own careers feed, as opposed to a board's copy of the posting.
const DIRECT_SOURCES = new Set(ATS.map(a => a.id));

// What the posting's own text says about where the work is done. Only plain
// statements count: "hybrid cloud" is not a hybrid role, "remote teams" not a remote one.
const SAYS_HYBRID = /\bhybrid\s+(?:work|working|role|position|model|schedule|set-?up|arrangement|policy|environment|basis|mode)\b|\b(?:work|working|role|position|job)\s+(?:is\s+)?hybrid\b|\(hybrid\)|\bhybrid\s*[-–—|,)]/i;
const SAYS_REMOTE = /\b(?:fully|100%|completely)\s+remote\b|\bremote[- ]first\b|\bremote\s+(?:role|position|job|opportunity|contract)\b|\bwork\s+from\s+anywhere\b|\bthis\s+(?:is\s+a\s+)?(?:role|position|job)\s+is\s+remote\b|\(remote\)/i;
const SAYS_ONSITE = /\bon[- ]?site\s+(?:role|position|job|work|basis)\b|\b(?:role|position|job)\s+is\s+(?:based\s+)?on[- ]?site\b|\bin[- ]office\b|\boffice[- ]based\b|\bwork(?:ing)?\s+from\s+(?:our|the)\s+office\b|\b(?:5|five)\s+days\s+(?:a\s+week\s+)?(?:in|at)\s+(?:the|our)\s+office\b|\(on[- ]?site\)/i;
function workplaceFromText(text) {
  const t = String(text || '');
  if (SAYS_HYBRID.test(t)) return 'hybrid';
  if (SAYS_REMOTE.test(t)) return 'remote';
  if (SAYS_ONSITE.test(t)) return 'onsite';
  return '';
}

// --- relevance --------------------------------------------------------------
// A posting is shown for a position only when its title names the same job. Two
// things decide that:
//   the head   — the word that says what the job *is*: "QA Lead" is a lead, "Backend
//                Engineering Manager" is a manager, "Senior Software Engineer, Platform"
//                is an engineer. English puts it last in the main clause, except in
//                "Head of X" / "Director of X", and before a comma or a dash the rest
//                is only the team ("…, Payments", "- Remote").
//   the field  — every word of the position that says which kind of that job: "QA",
//                "Backend", "Automation". Short words count: "QA" is the whole point
//                of "QA Lead", and dropping it made "Sales Lead" a match.
// A position with no field word of its own ("Software Engineer") accepts engineers of
// any software speciality, and nothing from another family: not "Sales Engineer",
// not "Data Engineer", not "Software Engineer in Test".

// Several words, one meaning. Applied before the title is split into words.
const TITLE_PHRASES = [
  [/\bsoftware development engineers? in test\b/g, ' sdet '],
  [/\b(?:software )?(?:engineers?|developers?) in test\b/g, ' sdet '],
  [/\bquality assurance\b/g, ' qa '],
  [/\bsite reliability\b/g, ' sre '],
  [/\bmachine learning\b/g, ' ml '],
  [/\bartificial intelligence\b/g, ' ai '],
  [/\bbusiness intelligence\b/g, ' bi '],
  [/\buser experience\b/g, ' ux '],
  [/\buser interface\b/g, ' ui '],
  [/\bfull[ -]?stack\b/g, ' fullstack '],
  [/\bfront[ -]?end\b/g, ' frontend '],
  [/\bback[ -]?end\b/g, ' backend '],
  [/\bdev[ -]?sec[ -]?ops\b/g, ' devsecops '],
  [/\bdev[ -]?ops\b/g, ' devops '],
  [/\bpre[ -]?sales\b/g, ' presales '],
  [/\bhead of\b/g, ' headof '],
  [/\bvice president\b/g, ' vp '],
  [/\bteam lead(?:er)?\b/g, ' lead '],
  [/\bproduct owner\b/g, ' product owner '],
];
// One word, written many ways. A value can stand for several words: a "Tester" is a
// QA engineer, an "SDET" an automation QA engineer, an "SRE" a reliability engineer.
const TITLE_WORD = {
  engineer: 'eng', engineers: 'eng', engineering: 'eng', developer: 'eng', developers: 'eng',
  dev: 'eng', programmer: 'eng', programmers: 'eng', coder: 'eng',
  tester: ['qa', 'eng'], testers: ['qa', 'eng'], sdet: ['qa', 'automation', 'eng'], sdets: ['qa', 'automation', 'eng'],
  test: 'qa', tests: 'qa', testing: 'qa', sqa: 'qa', qe: 'qa', quality: 'qa',
  automated: 'automation', automations: 'automation',
  sre: ['sre', 'eng'], sres: ['sre', 'eng'],
  manager: 'mgr', managers: 'mgr', mgr: 'mgr',
  director: 'director', directors: 'director', vp: 'director', svp: 'director', evp: 'director',
  chief: 'director', cto: 'director', cio: 'director', ciso: 'director', cfo: 'director',
  analyst: 'analyst', analysts: 'analyst', designer: 'designer', designers: 'designer',
  scientist: 'scientist', scientists: 'scientist', architect: 'architect', architects: 'architect',
  consultant: 'consultant', consultants: 'consultant', specialist: 'specialist', specialists: 'specialist',
  administrator: 'admin', administrators: 'admin', admin: 'admin', sysadmin: ['systems', 'admin'],
  technical: 'tech', technology: 'tech', leader: 'lead', leads: 'lead',
  ml: 'ml', ai: 'ai', ui: 'ui', ux: 'ux',
};
// Words that can be the head of a title. Anything else at the end of the main clause
// ("Accountant", "Nurse") is taken as the head too; this list is for telling heads
// from field words in the middle of a title.
const HEAD_WORDS = new Set(['eng', 'mgr', 'director', 'headof', 'analyst', 'designer', 'scientist',
  'architect', 'consultant', 'specialist', 'admin', 'officer', 'coordinator', 'accountant', 'recruiter',
  'associate', 'intern', 'lead', 'writer', 'representative', 'executive', 'owner', 'master', 'agent',
  'advisor', 'adviser', 'strategist', 'researcher', 'technician', 'operator', 'assistant', 'partner',
  'auditor', 'controller', 'editor', 'marketer', 'planner', 'buyer', 'clerk', 'supervisor', 'president']);
const MANAGERIAL = new Set(['mgr', 'director', 'headof', 'president']);
const LEVEL_WORD = /^(senior|sr|snr|junior|jr|staff|principal|mid|middle|entry|level|graduate|trainee|expert|i|ii|iii|iv|v|vi|1|2|3|4|5)$/;
const STOP_WORD = new Set(['of', 'and', 'the', 'for', 'in', 'with', 'a', 'an', 'to', 'at', 'on', 'or', 'our', 'we']);
// "Software" says nothing a software engineer's title does not already say; the rest
// of these say nothing at all.
const FILLER = new Set(['software', 'new', 'general', 'team', 'm', 'w', 'd', 'f', 'x', 'h', 'all', 'genders']);
// Another line of work. A position with no field word of its own ("Software
// Engineer") must not accept a title whose main clause names one of these.
const OTHER_FAMILY = new Set(['qa', 'automation', 'data', 'ml', 'ai', 'analytics', 'bi', 'devops', 'devsecops',
  'sre', 'platform', 'infrastructure', 'infra', 'cloud', 'network', 'networking', 'security', 'cyber',
  'cybersecurity', 'it', 'systems', 'system', 'support', 'sales', 'presales', 'solutions', 'solution',
  'customer', 'field', 'success', 'account', 'hardware', 'electrical', 'electronics', 'electronic',
  'mechanical', 'civil', 'structural', 'chemical', 'process', 'manufacturing', 'industrial', 'production',
  'maintenance', 'facilities', 'construction', 'embedded', 'firmware', 'rf', 'design', 'research',
  'release', 'build', 'integration', 'integrations', 'implementation', 'reliability', 'robotics',
  'marketing', 'revenue', 'partner', 'partnerships', 'performance', 'validation', 'verification',
  'operations', 'ops', 'deployment', 'database', 'dba', 'erp', 'sap', 'support', 'test', 'hr',
  'recruiting', 'recruitment', 'talent', 'finance', 'legal', 'compliance', 'risk']);
// A different job even when every field word of the position is there too: "Mobile
// QA Engineer" is a QA job, not a mobile one.
const STRONG_OTHER = new Set(['qa', 'qc', 'sales', 'presales', 'support', 'solutions', 'customer', 'security',
  'hardware', 'mechanical', 'electrical', 'civil', 'chemical', 'manufacturing', 'recruiting', 'recruitment', 'talent']);

// Lower case, one space between words, phrases folded; ampersands and slashes split
// ("UI/UX" is two words), a lone dot is dropped.
function titleText(s) {
  let t = ' ' + String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9+#]+/g, ' ') + ' ';
  for (const [re, to] of TITLE_PHRASES) t = t.replace(re, to);
  return t.replace(/\s+/g, ' ').trim();
}
function titleWords(s) {
  const out = [];
  for (const w of titleText(s).split(' ').filter(Boolean)) {
    const m = TITLE_WORD[w];
    if (Array.isArray(m)) out.push(...m); else out.push(m || w);
  }
  return out;
}
// The part of a title before a comma, dash, pipe, colon, bracket or " / ": what the
// job is, as opposed to the team, place or arrangement after it.
function mainClause(title) {
  return String(title || '').split(/\s[-–—|:]\s|\s[-–—]|[,(\[|:]|\s\/\s/)[0] || String(title || '');
}
function headOf(words) {
  if (words.includes('headof')) return 'headof';
  if (words.includes('director')) return 'director';
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (w === 'lead') { if (i === words.length - 1) return 'lead'; continue; } // "Lead QA Engineer" is an engineer
    if (HEAD_WORDS.has(w)) return w;
  }
  return words[words.length - 1] || '';
}

// Everything the matcher needs to know about a title, worked out once.
function parseTitle(title) {
  const all = titleWords(title);
  const main = titleWords(mainClause(title));
  const head = headOf(main.length ? main : all);
  const has = new Set(all);
  // An iOS or Android role is a mobile role.
  if (has.has('ios') || has.has('android')) has.add('mobile');
  return { all, main, head, has, mainSet: new Set(main), level: levelOf(title) };
}

// A position becomes its head and the field words a matching title must carry.
// "Senior QA Automation Engineer" -> head eng, field [qa, automation].
function parseRole(role) {
  const t = parseTitle(role);
  const field = [];
  let head = t.head, skippedHead = false;
  for (const w of t.main) {
    if (w === head && !skippedHead) { skippedHead = true; continue; }
    if (w === 'lead' || w === 'associate' || w === 'intern' || LEVEL_WORD.test(w)) continue;
    if (STOP_WORD.has(w) || FILLER.has(w)) continue;
    field.push(w);
  }
  return { label: role, head, field: [...new Set(field)], generic: !field.length, words: t.has, level: t.level };
}

// Is the posting's head the same kind of job as the position's? "QA Lead" and "Lead
// QA Engineer" are one job written two ways; a lead and a manager are not.
function sameJob(role, post) {
  if (role.head === post.head) return true;
  const ic = h => !MANAGERIAL.has(h) && h !== 'lead';
  if (role.head === 'lead' && ic(post.head) && post.has.has('lead')) return true;
  if (post.head === 'lead' && ic(role.head) && role.words.has('lead')) return true;
  return false;
}

// 0 = not this position; higher = a closer match.
function matchRole(post, role) {
  if (!sameJob(role, post)) return 0;
  if (role.generic) {
    // Only this job, in any speciality of the same family.
    for (const w of post.mainSet) if (OTHER_FAMILY.has(w)) return 0;
    return 1;
  }
  if (!role.field.every(w => post.has.has(w))) return 0;
  for (const w of post.mainSet) if (STRONG_OTHER.has(w) && !role.field.includes(w)) return 0;
  return 2 + role.field.length;
}

const LEVELS = [
  [0, /\b(intern|internship|trainee|graduate|apprentice|working student|werkstudent)\b/i],
  [1, /\b(junior|jr|entry[- ]level|associate)\b/i],
  [3, /\b(senior|sr|snr)\b/i],
  [4, /\b(staff|principal|lead|leader|expert)\b/i],
  [5, /\b(manager|head of|engineering manager)\b/i],
  [6, /\b(director|vp|vice president|chief|cto|head of engineering)\b/i],
];
// 2 is the unmarked middle: a title with no level word is a mid-level role. The
// highest marker wins, so "Senior Data Engineering Manager" is a manager role and
// not a senior one — matching in listed order got that backwards.
function levelOf(text) {
  // A programme for people starting out, named after the job it trains for:
  // "Software Engineer - Himmah Program", "Associate Product Manager (Tamheer)".
  const tail = String(text).slice(mainClause(text).length);
  if (/\bprogra(?:m|mme)s?\b|\bbuilders\b/i.test(tail) || /\btamheer\b|\bgraduate program/i.test(text)) return 0;
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

// For tests: does this title match this position, ignoring seniority?
function titleMatches(title, role) {
  return matchRole(parseTitle(title), parseRole(role));
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

// Title and seniority. Returns 0 to reject; higher is a better match. The position
// it matched is kept on the posting, so the page can say why it is there.
function roleScore(p, roles, candidateLevel) {
  const post = parseTitle(p.title);
  let best = 0, label = '';
  for (const role of roles) {
    const m = matchRole(post, role);
    if (m > best) { best = m; label = role.label; }
  }
  if (!best) return 0;
  // Someone with seven years behind them does not want an internship, and is not
  // getting the VP role either.
  const lvl = post.level;
  if (Number.isFinite(candidateLevel)) {
    if (lvl === 0 && candidateLevel >= 2) return 0;
    // One step either way. A senior engineer is shown staff and mid roles, not an
    // internship and not an engineering director.
    if (Math.abs(lvl - candidateLevel) > 1) return 0;
  }
  p.matchedRole = label;
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
    // A careers page that draws itself in the browser has no job text to read. For a
    // posting the employer's own system listed moments ago, a page that loads, keeps
    // the posting's ID and does not say "closed" is that posting.
    if (p.direct) return { state: 'employer', url: finalUrl, why: 'page loads in the browser' };
    return { state: 'dead', why: 'page does not show this job' };
  }
  return { state: 'exact', url: finalUrl };
}

// The address on the applicant-tracking system itself, for when an employer's own
// careers site will not answer: it always shows the posting while it is open.
function hostedUrl(p) {
  if (!p.ref) return '';
  if (p.source === 'greenhouse') return `https://job-boards.greenhouse.io/${p.ref.token}/jobs/${p.ref.id}`;
  if (p.source === 'recruitee' && p.ref.slug) return `https://${p.ref.token}.recruitee.com/o/${p.ref.slug}`;
  return '';
}

// Shown only when the link is proven:
//   exact     opened, this posting, still open
//   employer  the employer's system listed it moments ago and its page loads with
//             the posting's ID (a page drawn in the browser, or one that will not
//             answer a server at all)
//   listed    a board that blocks automated visits, but whose own feed says the
//             posting is open until a date still to come
//   listed    the employer's own system listed it moments ago, but its page would
//             not answer a server (a bot wall); the address is the one the employer
//             publishes. A job board's copy that cannot be opened is never shown.
function linkAccepted(p) {
  if (p.linkState === 'exact' || p.linkState === 'employer') return true;
  if (p.linkState === 'listed') return !!p.direct;
  return false;
}

// The same job written by a board and by the employer: the same words, give or take
// punctuation and a stray word.
function sameTitle(a, b) {
  const x = titleText(a), y = titleText(b);
  if (x === y) return true;
  const A = new Set(titleWords(a).filter(w => !STOP_WORD.has(w))), B = new Set(titleWords(b).filter(w => !STOP_WORD.has(w)));
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both) >= 0.75;
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
      let v = await checkLink(p);
      // The employer's own site did not show it cleanly: try the tracking system's
      // page for the same posting, which does.
      const alt = v.state !== 'exact' && hostedUrl(p);
      if (alt && alt !== p.url) {
        const w = await checkLink({ ...p, url: alt });
        if (w.state === 'exact') v = { ...w, url: w.url || alt };
      }
      p.linkState = v.state;
      p.linkNote = v.why || '';
      // Follow the redirect once here so the person is not bounced again later.
      if (v.url && v.url !== p.url) p.url = v.url;
      if (linkAccepted(p)) good++;
      if (i < group.length - 1) await sleep(350);
    }
  }));
  return list.filter(linkAccepted);
}

// --- public entry point -----------------------------------------------------
// Every filter here is a requirement, not a preference. A posting is shown only if
// it passes all of them:
//   days       published within this many days, by the source's own date (0 = any age)
//   country    open to someone in this country (see places.js)
//   workSetup  '', 'remote', 'hybrid' or 'onsite' — an unknown arrangement is not a match
//   roles      its title is one of these positions (see matchRole)
//   level      its seniority is within one step of the candidate's
//   skills     its own description names at least one of them, and not only
//              generic ones like "Agile"
//   link       the link is proven (see linkAccepted)
// companies is the shortlist whose own careers feeds are read: names, or
// { name, domain } when the company's website is known, which finds its board.

// Skills every job ad mentions. A posting that matches only these matched nothing.
const GENERIC_SKILLS = new Set(['agile', 'scrum', 'kanban', 'jira', 'confluence', 'git', 'github', 'gitlab',
  'excel', 'microsoft excel', 'ms excel', 'microsoft office', 'ms office', 'office', 'communication',
  'teamwork', 'leadership', 'problem solving', 'sdlc', 'english', 'documentation', 'waterfall',
  'project management', 'time management', 'stakeholder management', 'slack', 'windows', 'linux']);

async function search({ roles = [], companies = [], country = '', workSetup = '',
                        days = 7, limit = 30, skills = [], level } = {}) {
  if (!String(country).trim()) throw new Error('Choose a target country.');
  const started = Date.now();
  const parsed = (roles || []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 12).map(parseRole)
    .filter(r => r.head);
  if (!parsed.length) throw new Error('Add at least one position to search for.');
  const skillList = [...new Set((skills || []).map(s => String(s).trim()).filter(Boolean))].slice(0, 40);
  const matchSkills = makeSkillMatcher(skillList);
  const candidateLevel = Number.isFinite(+level) && level !== '' && level != null ? +level
    : Math.round(parsed.reduce((a, r) => a + r.level, 0) / parsed.length);
  const globalRemote = /^remote/i.test(country);
  const wantSetup = globalRemote ? 'remote' : workSetup;
  const countryInfo = places.COUNTRY[places.countryKey(country)];
  const ctx = { iso: countryInfo ? countryInfo.iso : '', worldwide: globalRemote, countryName: globalRemote ? '' : String(country).trim() };
  // Each target title is searched on its own: one merged query returns whatever the
  // board thinks those words mean together, which is rarely any of the roles. A
  // board's search is loose and "Senior" narrows it to postings that say "Senior", so
  // titles are searched without their level; every posting is still matched strictly.
  const bare = r => r.label.split(/\s+/).filter(w => !LEVEL_WORD.test(w.toLowerCase().replace(/[^a-z0-9]/g, ''))).join(' ').trim() || r.label;
  const queries = [...new Set(parsed.map(bare).map(s => s.toLowerCase()))].slice(0, 6);
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
            got.push(...await b.fetch(q, ctx).catch(e => { errors.push(e.message); return []; }));
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
  const target = { queries, countryKey: globalRemote ? "" : places.countryKey(country) };
  const budget = { left: PROBE_BUDGET, want: target };
  const seenCo = new Set();
  const shortlist = [];
  const addCompany = c => {
    const name = String((c && typeof c === 'object' ? c.name : c) || '').trim();
    const k = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!k || seenCo.has(k)) return;
    seenCo.add(k);
    shortlist.push({ name, domain: c && typeof c === 'object' ? String(c.domain || '') : '', board: c && c.board });
  };
  // The recruiter's shortlist, then the employers known to hire in this market.
  (companies || []).slice(0, 24).forEach(addCompany);
  (SEEDS[places.countryKey(country)] || []).forEach(addCompany);
  // Then employers a web search finds with matching postings on their own boards,
  // when a search engine key is set (see websearch.js).
  if (websearch.engine()) {
    const key = places.countryKey(country);
    const names = (countryInfo ? countryInfo.names : []).filter(n => n.length > 3 && !n.includes(key.split(' ')[0]) && !/^(u\.|kingdom|great britain|britain|emirates)/.test(n));
    const where = globalRemote ? ['remote'] : [String(country).trim(), ...names.slice(0, 2).map(n => n.replace(/\b\w/g, c => c.toUpperCase()))];
    const web = await websearch.discoverBoards({ roles: queries, places: where, days }, boardsInPage).catch(() => ({ engine: websearch.engine(), boards: [], queries: 0, errors: 1 }));
    for (const b of web.boards) addCompany({ name: b.name || b.token.replace(/^eu:/, '').split('/')[0], board: { ats: b.ats, token: b.token } });
    sources.push({ id: 'web', label: web.engine === 'google' ? 'Google Programmable Search' : 'Brave Search', ok: !web.errors || web.boards.length > 0,
      count: web.boards.length, note: `${web.boards.length} employer boards found by ${web.queries} web searches`, error: web.errors ? `${web.errors} of ${web.queries} searches failed` : '' });
  }
  let atsHits = 0;
  const atsTasks = [];
  const queue = shortlist.slice();
  for (let i = 0; i < 6; i++) {
    atsTasks.push((async () => {
      while (queue.length) {
        const company = queue.shift();
        const got = await probeCompany(company, budget).catch(() => []);
        if (got.length) { atsHits++; jobs.push(...got); }
      }
    })());
  }

  await Promise.all([...boardTasks, ...atsTasks]);
  sources.push({ id: 'ats', label: 'Company careers feeds', ok: true, count: atsHits,
    note: `${atsHits} of ${shortlist.length} shortlisted companies publish a public feed` });

  // An employer's own copy of a posting comes before a board's copy of the same one,
  // so it is the one kept when the duplicate is dropped.
  for (const p of jobs) p.direct = DIRECT_SOURCES.has(p.source);
  jobs.sort((a, b) => Number(b.direct) - Number(a.direct));

  // The cheap filters first: date, position, seniority, place, and the arrangement
  // where the feed states it.
  const rejected = { date: 0, position: 0, country: 0, setup: 0, skills: 0, link: 0, duplicate: 0 };
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
  const future = Date.now() + 86400000;
  // Which filter a posting fails, or '' if it passes them all.
  const failsCheap = p => {
    if (!p.url || !p.title || !p.company) return 'link';
    const t = Date.parse(p.postedAt);
    // No date means we cannot vouch for it; a date in the future is a feed error.
    if (!t || t > future || (cutoff && t < cutoff)) return 'date';
    if (p.expires && Date.parse(p.expires) < Date.now()) return 'date';
    p.score = roleScore(p, parsed, candidateLevel);
    if (!p.score) return 'position';
    // An arrangement the feed does not state is settled from the posting's own text
    // below, once it has been fetched.
    if (wantSetup && p.workplace && p.workplace !== wantSetup) return 'setup';
    const inPlace = globalRemote
      ? places.openAnywhere(p.location, p.countries)
      : places.openTo(p.location, p.countries, country, p.workplace === 'remote');
    if (!inPlace) return 'country';
    return '';
  };
  const seen = new Set();
  let pool = [];
  for (const p of jobs) {
    const why = failsCheap(p);
    if (why) { rejected[why]++; continue; }
    const key = (p.company + '|' + p.title).toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) { rejected.duplicate++; continue; }
    seen.add(key);
    pool.push(p);
  }

  // A job board's copy is checked against the employer's own posting wherever the
  // employer has a public board. Boards copy postings and keep them after they close,
  // and they label a US-only role "worldwide"; the employer's word on where, when
  // and whether it is open replaces theirs. If the employer's board no longer has the
  // job, it has closed. If the employer's own posting fails a filter the board's
  // copy passed, the board was wrong.
  rejected.closed = 0;
  const copies = new Map();
  for (const p of pool) {
    if (p.direct) continue;
    const k = p.company.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!copies.has(k)) copies.set(k, []);
    copies.get(k).push(p);
  }
  const xbudget = { left: 520, want: target };
  // The copies most likely to be shown are checked first: the freshest, then the
  // closest match.
  const rank = list => Math.max(...list.map(p => Date.parse(p.postedAt) / 864e5 + p.score));
  const xQueue = [...copies.values()].sort((a, b) => rank(b) - rank(a)).slice(0, 45);
  const xDeadline = Date.now() + 40000;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (xQueue.length && Date.now() < xDeadline) {
      const list = xQueue.shift();
      const own = await probeCompany({ name: list[0].company }, xbudget).catch(() => []);
      if (!own.length) continue;
      for (const p of list) {
        const q = own.find(o => sameTitle(o.title, p.title));
        if (!q) { p.closedAtEmployer = true; continue; }
        q.direct = true;
        q.foundVia = p.sourceLabel;
        p.employerCopy = q;
      }
    }
  }));
  pool = pool.flatMap(p => {
    if (p.closedAtEmployer) { rejected.closed++; return []; }
    const q = p.employerCopy;
    if (!q) return [p];
    const why = failsCheap(q);
    if (why) { rejected[why]++; return []; }
    const key = (q.company + '|' + q.title).toLowerCase().replace(/\s+/g, ' ');
    if (pool.some(o => o !== p && o.direct && (o.company + '|' + o.title).toLowerCase().replace(/\s+/g, ' ') === key)) {
      rejected.duplicate++; return [];
    }
    return [q];
  });

  // Then the expensive ones. Postings whose feed has no description are fetched one
  // by one; that also proves the employer has not pulled them.
  const needDetail = pool.filter(p => ATS_BY_ID[p.source] && ATS_BY_ID[p.source].detail && p.ref).slice(0, 60);
  const detailQueue = needDetail.slice();
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (detailQueue.length) {
      const p = detailQueue.shift();
      try {
        if (await ATS_BY_ID[p.source].detail(p) === false) p.gone = true;
        else p.detailed = true;
      } catch (e) {
        if (e.status === 404 || e.status === 410) p.gone = true;
      }
    }
  }));

  const all = [];
  for (const p of pool) {
    const a = ATS_BY_ID[p.source];
    if (p.gone || (a && a.detail && p.ref && !p.detailed)) { rejected.link++; continue; }
    // A searched system's list gives only a rough date and "3 Locations"; the posting's
    // own record just replaced them, so the filters are applied again to the real ones.
    if (a && a.searched) { const why = failsCheap(p); if (why) { rejected[why]++; continue; } }
    // Where the feed did not say, the posting's own words decide the arrangement:
    // only a plain statement counts. For an on-site search, a posting at a named
    // place that offers no remote or hybrid option at all is on-site.
    if (!p.workplace) {
      const said = workplaceFromText([p.title, p.location, p.desc].join(' '));
      if (said) { p.workplace = said; p.workplaceStated = true; }
      else if (wantSetup === 'onsite' && places.resolve(p.location, p.countries).countries.size
        && !REMOTE_RE.test(p.title + ' ' + p.location) && !/\bhybrid\b|\bremote\b/i.test(p.desc || '')) {
        p.workplace = 'onsite'; p.workplaceInferred = true;
      }
    }
    if (wantSetup && p.workplace !== wantSetup) { rejected.setup++; continue; }
    const matched = matchSkills(p.title + ' ' + p.desc);
    // Skills are required whenever there are any: a title match alone let a Go role
    // through to a Java developer. A posting with no description to check is not
    // shown, because nothing backs it up. Nor is one that shares only "Agile".
    const specific = matched.filter(s => !GENERIC_SKILLS.has(s.toLowerCase()));
    const anySpecific = skillList.some(s => !GENERIC_SKILLS.has(s.toLowerCase()));
    if (skillList.length && (!matched.length || (anySpecific && !specific.length))) { rejected.skills++; continue; }
    p.matchedSkills = matched;
    p.score += Math.min(specific.length, 6);
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
  const candidates = all.slice(0, want + 25);
  const verified = await verifyLinks(candidates, want, started + 55000);
  rejected.link += candidates.filter(p => p.linkState && !linkAccepted(p)).length;
  // The same posting can arrive by two routes under slightly different company names;
  // its address is the same.
  const urls = new Set();
  const unique = verified.filter(p => {
    const u = p.url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    if (urls.has(u)) { rejected.duplicate++; return false; }
    urls.add(u);
    return true;
  });
  // Confirmed: the employer's own system lists it, so its date, place and link are the
  // employer's. The rest are a job board's copy of a posting whose employer has no
  // public board to check against; the page keeps them apart and says so.
  const shown = unique.slice(0, want).map(({ desc, ref, gone, countries, detailed, score, employerCopy, closedAtEmployer, ...rest }) =>
    ({ ...rest, confirmed: !!rest.direct }));
  return {
    jobs: shown, sources, checked: shortlist.length, scanned: jobs.length,
    matched: all.length, rejected,
    // What happened to every posting that reached the link check, for diagnosing a
    // short list. Not shown on the page.
    checkedLinks: candidates.map(p => ({ title: p.title, company: p.company, source: p.source, via: p.foundVia || '', url: p.url, state: p.linkState || 'not checked', why: p.linkNote || '' })),
    filters: { country, workSetup: wantSetup, days, roles: parsed.map(r => r.label), skills: skillList, level: candidateLevel },
  };
}

module.exports = { search, BOARDS, ATS, _test: { skillForms, makeSkillMatcher, postingId, checkLink, normalise, roleScore, parseRole, parseTitle, titleMatches, workplaceFromText, boardsInPage, boardsFromSite, probeCompany, tokensFor, boardIsTheirs, ATS_BY_ID, iso } };
