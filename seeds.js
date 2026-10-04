// Employers known to hire in markets the remote job boards barely cover, with the
// public job board each one publishes its openings through. Every entry was found
// from the employer's own careers page (or its name, with the board's ownership
// checked), and each is an employer that hires in that market.
//
// They are read on every search alongside the recruiter's shortlist, so a Gulf or
// Pakistan search does not depend on the model naming the right companies. A board
// that closes or moves just returns nothing; nothing here is shown without passing
// every filter and the link check like any other posting.
module.exports = {
  'saudi arabia': [
    { name: 'Accenture', domain: 'accenture.com', board: { ats: 'workday', token: 'accenture.wd103/AccentureCareers' } },
    { name: 'Lucid Motors', domain: 'lucidmotors.com', board: { ats: 'greenhouse', token: 'lucidmotors' } },
    { name: 'Salla', domain: 'salla.com', board: { ats: 'workable', token: 'salla' } },
    { name: 'Lucidya', domain: 'lucidya.com', board: { ats: 'workable', token: 'lucidya' } },
    { name: 'Foodics', domain: 'foodics.com', board: { ats: 'workable', token: 'foodics' } },
    { name: 'Hala', domain: 'hala.com', board: { ats: 'greenhouse', token: 'hala' } },
    { name: 'Mozn', domain: 'mozn.ai', board: { ats: 'workable', token: 'mozn-ai' } },
    { name: 'Tamara', domain: 'tamara.co', board: { ats: 'greenhouse', token: 'tamara' } },
    { name: 'Unifonic', domain: 'unifonic.com', board: { ats: 'recruitee', token: 'unifonic' } },
    { name: 'Lean Technologies', domain: 'leantech.me', board: { ats: 'ashby', token: 'LeanTech' } },
    { name: 'Rewaa', domain: 'rewaa.com', board: { ats: 'lever', token: 'rewaatech' } },
    { name: 'Careem', domain: 'careem.com', board: { ats: 'greenhouse', token: 'careem' } },
  ],
  'united arab emirates': [
    { name: 'Careem', domain: 'careem.com', board: { ats: 'greenhouse', token: 'careem' } },
    { name: 'Deliveroo', domain: 'deliveroo.co.uk', board: { ats: 'greenhouse', token: 'deliveroo' } },
    { name: 'Ziina', domain: 'ziina.com', board: { ats: 'ashby', token: 'ziina' } },
    { name: 'Fresha', domain: 'fresha.com', board: { ats: 'lever', token: 'fresha' } },
    { name: 'Accenture', domain: 'accenture.com', board: { ats: 'workday', token: 'accenture.wd103/AccentureCareers' } },
    { name: 'Tamara', domain: 'tamara.co', board: { ats: 'greenhouse', token: 'tamara' } },
  ],
  qatar: [
    { name: 'Accenture', domain: 'accenture.com', board: { ats: 'workday', token: 'accenture.wd103/AccentureCareers' } },
  ],
  pakistan: [
    { name: 'Creative Chaos', domain: 'creativechaos.co', board: { ats: 'workable', token: 'creativechaos' } },
    { name: 'Zameen', domain: 'zameen.com', board: { ats: 'breezy', token: 'zameen' } },
    { name: 'Devsinc', domain: 'devsinc.com', board: { ats: 'workable', token: 'devsinc-17' } },
    { name: 'Educative', domain: 'educative.io', board: { ats: 'lever', token: 'educative' } },
    { name: 'Careem', domain: 'careem.com', board: { ats: 'greenhouse', token: 'careem' } },
  ],
};
