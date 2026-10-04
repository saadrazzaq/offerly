// Finding employers' own postings through a web search engine, so an employer the
// recruiter's shortlist did not name is not missed.
//
// Only through an engine's official API, with your own key:
//   Google Programmable Search   GOOGLE_CSE_KEY and GOOGLE_CSE_CX (100 searches a day free)
//   Brave Search                 BRAVE_SEARCH_KEY
// Without a key this does nothing: scraping a search results page is against the
// engines' terms, and the page links to the same searches for you to open instead.
//
// A search result is never shown as a job. It only says which employer boards carry
// matching postings; those boards are then read and every posting goes through the
// same filters and link check as any other.

// Where employers' own postings live.
const ATS_SITES = ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com',
  'apply.workable.com', 'myworkdayjobs.com', 'jobs.smartrecruiters.com', 'recruitee.com', 'breezy.hr'];

function engine() {
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX) return 'google';
  if (process.env.BRAVE_SEARCH_KEY) return 'brave';
  return '';
}

const quote = s => '"' + String(s).replace(/"/g, '') + '"';
// One search per position: the title, the place (the country or one of its main
// cities), and the employer systems. Engines cap a query's length, so the places are
// few and the systems are split over two searches.
function buildQueries(roles, places) {
  const where = places.length ? ' (' + places.slice(0, 3).map(quote).join(' OR ') + ')' : '';
  const halves = [ATS_SITES.slice(0, 5), ATS_SITES.slice(5)];
  const out = [];
  for (const r of roles.slice(0, 2)) for (const h of halves) out.push(quote(r) + where + ' (' + h.map(s => 'site:' + s).join(' OR ') + ')');
  return out;
}

function freshness(days) {
  if (!days) return { google: '', brave: '' };
  return { google: 'd' + Math.max(1, Math.min(365, days)), brave: days <= 1 ? 'pd' : days <= 7 ? 'pw' : days <= 31 ? 'pm' : 'py' };
}

async function runQuery(q, days, fetchImpl = fetch) {
  const f = freshness(days);
  if (engine() === 'google') {
    const u = 'https://www.googleapis.com/customsearch/v1?key=' + encodeURIComponent(process.env.GOOGLE_CSE_KEY)
      + '&cx=' + encodeURIComponent(process.env.GOOGLE_CSE_CX) + '&num=10&q=' + encodeURIComponent(q)
      + (f.google ? '&dateRestrict=' + f.google : '');
    const r = await fetchImpl(u, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('Google search HTTP ' + r.status);
    const j = await r.json();
    return (j.items || []).map(i => ({ url: i.link, title: i.title || '' }));
  }
  if (engine() === 'brave') {
    const u = 'https://api.search.brave.com/res/v1/web/search?count=20&q=' + encodeURIComponent(q) + (f.brave ? '&freshness=' + f.brave : '');
    const r = await fetchImpl(u, { headers: { accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_KEY }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('Brave search HTTP ' + r.status);
    const j = await r.json();
    return ((j.web && j.web.results) || []).map(i => ({ url: i.url, title: i.title || '' }));
  }
  return [];
}

// The employer's name as the result's title gives it, when it does. Each system
// writes it its own way: Greenhouse "Job Application for QA Lead at Tamara", Lever
// "Tamara - QA Lead", Workable "QA Lead - Salla", Ashby "QA Lead @ Lean".
function employerFromTitle(title, ats = '') {
  const t = String(title || '').trim();
  const at = t.match(/\s(?:at|@)\s+([^|–—@]{2,60})$/i);
  if (at) return at[1].trim();
  const parts = t.split(/\s[-–—|]\s/);
  if (parts.length < 2) return '';
  if (ats === 'lever') return parts[0].trim();
  if (ats === 'workable' || ats === 'recruitee' || ats === 'smartrecruiters') return parts[parts.length - 1].trim();
  return '';
}

// The boards behind the results. `boardsInPage` is jobfeeds' reader for board links.
async function discoverBoards({ roles, places, days }, boardsInPage, fetchImpl = fetch) {
  if (!engine()) return { engine: '', boards: [], queries: 0 };
  const found = new Map();
  const qs = buildQueries(roles, places);
  let errors = 0;
  for (const q of qs) {
    let results = [];
    try { results = await runQuery(q, days, fetchImpl); } catch (_) { errors++; continue; }
    for (const r of results) {
      for (const b of boardsInPage('', r.url)) {
        const k = b.ats + ':' + b.token.toLowerCase();
        if (!found.has(k)) found.set(k, { ...b, name: employerFromTitle(r.title, b.ats) });
      }
    }
  }
  return { engine: engine(), boards: [...found.values()], queries: qs.length, errors };
}

module.exports = { engine, buildQueries, discoverBoards, employerFromTitle, ATS_SITES };
