// Where is a posting open to? Feed locations are free text — "Dubai, UAE",
// "SEA, SF, NY, Toronto", "Remote - EMEA", "Columbus, IN", "Anywhere in the US" —
// and a wrong answer here is what put a US-only remote role in front of someone in
// Pakistan. So a location is resolved into the countries and regions it names, and a
// posting is only accepted for a country it actually names (or a region that
// contains it, or an explicit "worldwide").
//
// Three traps this is written around:
//   - Two-letter codes are words too: "in", "at", "no", "it", "us". Codes only count
//     in capitals ("IN", "US"), never in lower case.
//   - US states share codes with countries: "San Francisco, CA" is California, not
//     Canada; "Columbus, IN" is Indiana, not India. A code after a comma is read as a
//     state unless the city before it belongs to another country ("Berlin, DE").
//   - Names nest: "New Mexico" is a US state, not Mexico. The longest name wins.

const COUNTRY = {
  'united states': {
    names: ['united states', 'united states of america', 'usa', 'u.s.', 'u.s.a.',
      'new york', 'nyc', 'san francisco', 'bay area', 'silicon valley', 'seattle', 'austin', 'boston', 'chicago',
      'los angeles', 'denver', 'atlanta', 'miami', 'dallas', 'houston', 'phoenix', 'philadelphia', 'portland',
      'san diego', 'san jose', 'palo alto', 'mountain view', 'sunnyvale', 'menlo park', 'redwood city',
      'santa clara', 'cupertino', 'oakland', 'minneapolis', 'detroit', 'pittsburgh', 'salt lake city',
      'raleigh', 'durham', 'nashville', 'columbus', 'cincinnati', 'cleveland', 'washington dc', 'washington, d.c.',
      'baltimore', 'st. louis', 'kansas city', 'charlotte', 'orlando', 'tampa', 'boulder', 'irvine',
      'jersey city', 'brooklyn', 'cambridge, ma', 'somerville', 'arlington', 'reston', 'plano', 'scottsdale'],
    codes: ['US', 'USA', 'SF', 'NYC', 'NY'], iso: 'US',
  },
  'united kingdom': {
    names: ['united kingdom', 'uk', 'u.k.', 'great britain', 'britain', 'england', 'scotland', 'wales',
      'northern ireland', 'london', 'manchester', 'edinburgh', 'bristol', 'cambridge', 'oxford', 'leeds',
      'glasgow', 'birmingham', 'belfast', 'reading', 'cardiff', 'newcastle', 'sheffield', 'nottingham', 'liverpool'],
    codes: ['UK', 'GB', 'GBR'], iso: 'GB',
  },
  canada: {
    names: ['canada', 'toronto', 'vancouver', 'montreal', 'montréal', 'ottawa', 'calgary', 'waterloo',
      'edmonton', 'winnipeg', 'halifax', 'quebec', 'québec', 'ontario', 'british columbia', 'alberta', 'kitchener'],
    codes: ['CAN'], iso: 'CA', // "CA" alone is California far more often than Canada
  },
  germany: {
    names: ['germany', 'deutschland', 'berlin', 'munich', 'münchen', 'muenchen', 'hamburg', 'frankfurt',
      'cologne', 'köln', 'koeln', 'stuttgart', 'düsseldorf', 'duesseldorf', 'leipzig', 'dresden', 'hannover',
      'nuremberg', 'nürnberg', 'karlsruhe', 'bonn', 'essen', 'dortmund', 'mannheim', 'heidelberg'],
    codes: ['DE', 'DEU'], iso: 'DE',
  },
  netherlands: {
    names: ['netherlands', 'the netherlands', 'holland', 'nederland', 'amsterdam', 'rotterdam', 'utrecht',
      'eindhoven', 'the hague', 'den haag', 'groningen', 'delft', 'leiden'],
    codes: ['NL', 'NLD'], iso: 'NL',
  },
  ireland: { names: ['ireland', 'dublin', 'cork', 'galway', 'limerick'], codes: ['IE', 'IRL'], iso: 'IE' },
  france: {
    names: ['france', 'paris', 'lyon', 'toulouse', 'marseille', 'bordeaux', 'lille', 'nantes', 'nice',
      'montpellier', 'strasbourg', 'rennes', 'grenoble', 'sophia antipolis'],
    codes: ['FR', 'FRA'], iso: 'FR',
  },
  switzerland: {
    names: ['switzerland', 'suisse', 'schweiz', 'zurich', 'zürich', 'geneva', 'genève', 'lausanne', 'basel',
      'bern', 'zug', 'lugano'],
    codes: ['CH', 'CHE'], iso: 'CH',
  },
  sweden: { names: ['sweden', 'sverige', 'stockholm', 'gothenburg', 'göteborg', 'malmö', 'malmo', 'uppsala', 'lund'], codes: ['SE', 'SWE'], iso: 'SE' },
  spain: {
    names: ['spain', 'españa', 'espana', 'madrid', 'barcelona', 'valencia', 'seville', 'sevilla', 'malaga',
      'málaga', 'bilbao'],
    codes: ['ES', 'ESP'], iso: 'ES',
  },
  poland: {
    names: ['poland', 'polska', 'warsaw', 'warszawa', 'krakow', 'kraków', 'wroclaw', 'wrocław', 'gdansk',
      'gdańsk', 'poznan', 'poznań', 'lodz', 'łódź', 'katowice'],
    codes: ['PL', 'POL'], iso: 'PL',
  },
  'united arab emirates': {
    names: ['united arab emirates', 'uae', 'u.a.e.', 'emirates', 'dubai', 'abu dhabi', 'sharjah', 'ajman',
      'ras al khaimah'],
    codes: ['AE', 'ARE', 'DXB'], iso: 'AE',
  },
  'saudi arabia': {
    names: ['saudi arabia', 'saudi', 'ksa', 'kingdom of saudi arabia', 'riyadh', 'jeddah', 'dammam', 'khobar',
      'al khobar', 'dhahran', 'neom', 'mecca', 'makkah', 'medina'],
    codes: ['SA', 'SAU', 'KSA'], iso: 'SA',
  },
  qatar: { names: ['qatar', 'doha'], codes: ['QA', 'QAT'], iso: 'QA' },
  pakistan: {
    names: ['pakistan', 'karachi', 'lahore', 'islamabad', 'rawalpindi', 'faisalabad', 'peshawar', 'multan'],
    codes: ['PK', 'PAK'], iso: 'PK',
  },
  india: {
    names: ['india', 'bangalore', 'bengaluru', 'hyderabad', 'mumbai', 'delhi', 'new delhi', 'ncr', 'gurgaon',
      'gurugram', 'noida', 'pune', 'chennai', 'kolkata', 'ahmedabad', 'kochi', 'jaipur', 'chandigarh'],
    codes: ['IN', 'IND'], iso: 'IN',
  },
  singapore: { names: ['singapore'], codes: ['SG', 'SGP'], iso: 'SG' },
  australia: {
    names: ['australia', 'sydney', 'melbourne', 'brisbane', 'perth', 'canberra', 'adelaide', 'new south wales', 'queensland'],
    codes: ['AU', 'AUS'], iso: 'AU',
  },
  'new zealand': { names: ['new zealand', 'auckland', 'wellington', 'christchurch'], codes: ['NZ', 'NZL'], iso: 'NZ' },
  japan: { names: ['japan', 'tokyo', 'osaka', 'kyoto', 'yokohama', 'fukuoka'], codes: ['JP', 'JPN'], iso: 'JP' },
  'hong kong': { names: ['hong kong', 'hongkong'], codes: ['HK', 'HKG'], iso: 'HK' },
  malaysia: { names: ['malaysia', 'kuala lumpur', 'penang', 'johor', 'cyberjaya', 'petaling jaya'], codes: ['MY', 'MYS'], iso: 'MY' },
  turkey: { names: ['turkey', 'türkiye', 'turkiye', 'istanbul', 'ankara', 'izmir'], codes: ['TR', 'TUR'], iso: 'TR' },
  portugal: { names: ['portugal', 'lisbon', 'lisboa', 'porto', 'braga', 'coimbra'], codes: ['PT', 'PRT'], iso: 'PT' },
  italy: {
    names: ['italy', 'italia', 'milan', 'milano', 'rome', 'roma', 'turin', 'torino', 'bologna', 'naples',
      'napoli', 'florence', 'firenze'],
    codes: ['IT', 'ITA'], iso: 'IT',
  },
  norway: { names: ['norway', 'norge', 'oslo', 'bergen', 'trondheim', 'stavanger'], codes: ['NO', 'NOR'], iso: 'NO' },
  denmark: { names: ['denmark', 'danmark', 'copenhagen', 'københavn', 'aarhus', 'odense'], codes: ['DK', 'DNK'], iso: 'DK' },
  finland: { names: ['finland', 'suomi', 'helsinki', 'espoo', 'tampere', 'oulu'], codes: ['FI', 'FIN'], iso: 'FI' },
  belgium: { names: ['belgium', 'belgië', 'belgique', 'brussels', 'bruxelles', 'antwerp', 'ghent', 'gent', 'leuven'], codes: ['BE', 'BEL'], iso: 'BE' },
  austria: { names: ['austria', 'österreich', 'vienna', 'wien', 'graz', 'linz', 'salzburg', 'innsbruck'], codes: ['AT', 'AUT'], iso: 'AT' },
  'czech republic': { names: ['czech republic', 'czechia', 'prague', 'praha', 'brno', 'ostrava'], codes: ['CZ', 'CZE'], iso: 'CZ' },
  romania: { names: ['romania', 'bucharest', 'bucuresti', 'bucurești', 'cluj', 'cluj-napoca', 'timisoara', 'iasi'], codes: ['RO', 'ROU'], iso: 'RO' },
  estonia: { names: ['estonia', 'tallinn', 'tartu'], codes: ['EE', 'EST'], iso: 'EE' },
  israel: { names: ['israel', 'tel aviv', 'tel aviv-yafo', 'jerusalem', 'haifa', 'herzliya', 'petah tikva'], codes: ['IL', 'ISR'], iso: 'IL' },
  'south africa': { names: ['south africa', 'cape town', 'johannesburg', 'joburg', 'durban', 'pretoria'], codes: ['ZA', 'ZAF'], iso: 'ZA' },
  egypt: { names: ['egypt', 'cairo', 'alexandria', 'giza'], codes: ['EG', 'EGY'], iso: 'EG' },
  nigeria: { names: ['nigeria', 'lagos', 'abuja', 'ibadan'], codes: ['NG', 'NGA'], iso: 'NG' },
  kenya: { names: ['kenya', 'nairobi', 'mombasa'], codes: ['KE', 'KEN'], iso: 'KE' },
  brazil: {
    names: ['brazil', 'brasil', 'sao paulo', 'são paulo', 'rio de janeiro', 'belo horizonte', 'curitiba',
      'porto alegre', 'florianopolis', 'florianópolis', 'recife'],
    codes: ['BR', 'BRA'], iso: 'BR',
  },
  mexico: { names: ['mexico', 'méxico', 'mexico city', 'ciudad de méxico', 'cdmx', 'guadalajara', 'monterrey'], codes: ['MX', 'MEX'], iso: 'MX' },
  argentina: { names: ['argentina', 'buenos aires', 'cordoba', 'córdoba', 'rosario', 'mendoza'], codes: ['AR', 'ARG'], iso: 'AR' },
};

// State names are read as the United States, and read *first*, so "New Mexico" and
// "Georgia" never reach the country list.
const US_STATES = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado',
  CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho',
  IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine',
  MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri',
  MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico',
  NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon',
  PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee',
  TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia',
  WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia',
};
// Canadian provinces written as a code after a city: "Toronto, ON".
const CA_PROVINCES = new Set(['ON', 'BC', 'QC', 'AB', 'MB', 'NS', 'NB', 'SK', 'NL', 'PE']);

// Regions a posting may be open to, and which of our countries each one covers.
const EUROPE = ['united kingdom', 'germany', 'netherlands', 'ireland', 'france', 'switzerland', 'sweden',
  'spain', 'poland', 'portugal', 'italy', 'norway', 'denmark', 'finland', 'belgium', 'austria',
  'czech republic', 'romania', 'estonia'];
const EU = EUROPE.filter(c => !['united kingdom', 'switzerland', 'norway'].includes(c));
const GCC = ['united arab emirates', 'saudi arabia', 'qatar'];
const MIDDLE_EAST = [...GCC, 'israel', 'egypt', 'turkey'];
const AFRICA = ['south africa', 'egypt', 'nigeria', 'kenya'];
const APAC = ['india', 'pakistan', 'singapore', 'australia', 'new zealand', 'japan', 'hong kong', 'malaysia'];
const LATAM = ['brazil', 'mexico', 'argentina'];
const REGION = {
  europe: EUROPE, 'european union': EU, eu: EU, eea: [...EU, 'norway'], emea: [...EUROPE, ...MIDDLE_EAST, ...AFRICA],
  dach: ['germany', 'austria', 'switzerland'], benelux: ['netherlands', 'belgium'],
  nordics: ['sweden', 'norway', 'denmark', 'finland'], nordic: ['sweden', 'norway', 'denmark', 'finland'],
  scandinavia: ['sweden', 'norway', 'denmark'], cee: ['poland', 'czech republic', 'romania', 'estonia'],
  'eastern europe': ['poland', 'czech republic', 'romania', 'estonia'],
  'western europe': ['united kingdom', 'germany', 'netherlands', 'ireland', 'france', 'switzerland', 'spain', 'portugal', 'italy', 'belgium', 'austria'],
  apac: APAC, 'asia pacific': APAC, 'asia-pacific': APAC, asia: ['india', 'pakistan', 'singapore', 'japan', 'hong kong', 'malaysia'],
  'south asia': ['india', 'pakistan'], 'southeast asia': ['singapore', 'malaysia'],
  oceania: ['australia', 'new zealand'], anz: ['australia', 'new zealand'],
  latam: LATAM, 'latin america': LATAM, 'south america': ['brazil', 'argentina'],
  'north america': ['united states', 'canada', 'mexico'], americas: ['united states', 'canada', 'mexico', 'brazil', 'argentina'],
  mena: MIDDLE_EAST.concat(['egypt']), 'middle east': MIDDLE_EAST, gcc: GCC, gulf: GCC, africa: AFRICA,
};
const REGION_CODES = { EU: 'eu', EEA: 'eea', EMEA: 'emea', APAC: 'apac', LATAM: 'latam', MENA: 'mena', GCC: 'gcc', CEE: 'cee', DACH: 'dach', ANZ: 'anz', NA: 'north america', AMER: 'americas' };

const ANYWHERE = /(^|[^a-z])(worldwide|anywhere|any location|global|globally|international|all countries|no location restriction)([^a-z]|$)/i;

// --- the lookup tables ------------------------------------------------------
const NAME_TO = new Map();   // lower-case name → country key (or 'region:<name>')
const CODE_TO = new Map();   // capital code → country key (or 'region:<name>')
const CITY_OF = new Map();   // lower-case city → country key, for "City, XX"
const ISO_TO = new Map();
for (const [key, c] of Object.entries(COUNTRY)) {
  for (const n of c.names) { NAME_TO.set(n, key); if (n !== key) CITY_OF.set(n, key); }
  for (const code of c.codes) CODE_TO.set(code, key);
  ISO_TO.set(c.iso, key);
}
for (const n of Object.values(US_STATES)) NAME_TO.set(n, 'united states');
for (const r of Object.keys(REGION)) if (r.length > 3) NAME_TO.set(r, 'region:' + r);
for (const [code, r] of Object.entries(REGION_CODES)) CODE_TO.set(code, 'region:' + r);

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest first, so "new mexico" is consumed before "mexico" can match.
const NAME_RE = new RegExp('(?<![\\p{L}\\p{N}])(' + [...NAME_TO.keys()].sort((a, b) => b.length - a.length).map(esc).join('|') + ')(?![\\p{L}\\p{N}])', 'giu');
const CODE_RE = new RegExp('(?<![A-Za-z0-9])(' + [...CODE_TO.keys()].sort((a, b) => b.length - a.length).map(esc).join('|') + ')(?![A-Za-z0-9])', 'g');
// "City, XX" where XX is a US state or a Canadian province.
const CITY_STATE_RE = /([\p{L} .'-]{2,40}),\s*([A-Z]{2})(?![A-Za-z])/gu;

// The countries and regions a piece of location text names, and whether it says
// "anywhere". `extra` are structured country values some feeds provide (ISO codes
// or names), which are more reliable than the free text and are added to it.
function resolve(text, extra = []) {
  const countries = new Set(), regions = new Set();
  let s = String(text || '');

  // "Columbus, IN" is Indiana; "Berlin, DE" is Germany. Decide by the city.
  s = s.replace(CITY_STATE_RE, (m, city, code) => {
    const c = city.trim().toLowerCase();
    const foreign = [...CITY_OF.entries()].find(([n]) => c === n || c.endsWith(' ' + n) || c.endsWith('-' + n));
    if (foreign && foreign[1] !== 'united states') return m;           // the code is that country's
    if (US_STATES[code]) { countries.add('united states'); return city + ' '; }
    if (CA_PROVINCES.has(code)) { countries.add('canada'); return city + ' '; }
    return m;
  });

  s = s.replace(NAME_RE, m => {
    const k = NAME_TO.get(m.toLowerCase());
    if (!k) return m;
    if (k.startsWith('region:')) regions.add(k.slice(7)); else countries.add(k);
    return ' ';
  });
  s.replace(CODE_RE, m => {
    const k = CODE_TO.get(m);
    if (k && k.startsWith('region:')) regions.add(k.slice(7)); else if (k) countries.add(k);
    return ' ';
  });

  for (const v of extra) {
    const raw = String(v || '').trim();
    if (!raw) continue;
    if (ISO_TO.has(raw.toUpperCase()) && raw.length === 2) { countries.add(ISO_TO.get(raw.toUpperCase())); continue; }
    const sub = resolve(raw);
    sub.countries.forEach(c => countries.add(c));
    sub.regions.forEach(r => regions.add(r));
  }
  return { countries, regions, anywhere: ANYWHERE.test(String(text || '')) };
}

function countryKey(country) {
  return String(country || '').toLowerCase().replace(/\s*\(.*\)$/, '').trim();
}

// Is a posting at `place` open to someone looking in `country`?
//   - it names that country, or
//   - it names a region that contains it, or
//   - it names no country or region at all but says "worldwide / anywhere" and is remote.
// Anything else — no location, a location we cannot place, another country — is no.
function placeMatches(place, country, remote) {
  const key = countryKey(country);
  if (place.countries.has(key)) return true;
  for (const r of place.regions) if ((REGION[r] || []).includes(key)) return true;
  if (!place.countries.size && !place.regions.size && place.anywhere && remote) return true;
  return false;
}

// "Remote (Global)" is not a place: it asks for roles open from anywhere, so a
// US-only remote role does not qualify.
function openWorldwide(place) {
  return place.anywhere && !place.countries.size && !place.regions.size;
}

module.exports = { resolve, placeMatches, openWorldwide, countryKey, COUNTRY, REGION };
