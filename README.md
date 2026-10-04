# Offerly — *Engineered to get you offers*

Offerly is a single-page AI job-search copilot. Upload your resume, pick a target country and career stage, and it acts like a top-1% tech recruiter:

- **Deep resume analysis** — seniority, experience, strengths, and market-specific gaps
- **A live ATS score** /100 the moment you upload — fixed, explainable checks, each lost point with its fix — plus an AI recruiter's review
- **Confirmed live openings** — postings listed right now on employers' own hiring systems (Greenhouse, Lever, Ashby, Workable, Workday and more), with the employer's own date, place and link, each link opened and checked; job-board copies are checked against the employer's own posting. Filter by **posted within** (24 hours → a month), **country** and **work setup** (remote / hybrid / on-site), the way you would on LinkedIn.
- **An editable search profile** — the positions and skills read off your resume, as tags you can remove or add to. Every live opening must match your positions, at least one skill, your seniority, country, work setup and posting window.
- **Plus a recruiter shortlist** of real companies that hire this profile, split into **High / Medium / Stretch** with a **fit score** — every link pre-filtered to the dates and work setup you chose
- **Channel-aware Apply** — for each role the recruiter picks the most realistic application route and the button matches it: LinkedIn Easy Apply, Indeed, Glassdoor, Bayt, NaukriGulf, GulfTalent, TASC, Hays, the company career page, or email — with a regional bias (Gulf boards for Gulf markets, LinkedIn/Indeed for global)
- **Apply by Email** — generates a cover letter *tailored to that exact role* and opens Gmail compose pre-filled (recipient + subject + letter + your signature). Drag in your resume and send.
- **Resume improvement suggestions** — prioritized and actionable
- **Fix my resume, in your own format and fonts** — the fixes are applied to your uploaded PDF or Word file as it is laid out, in plain human wording, with no number, tool or claim your resume does not already state; you review the result with its before/after ATS score and get back a PDF with clean page breaks
- **The big job sites, one click each** — LinkedIn, Indeed, Bayt, GulfTalent, Rozee, Naukri, Reed, SEEK and more, opened on their own search for your position, country and dates
- **Bulk apply** (`/apply`) — add any number of jobs as **links, screenshots or pasted text**, upload your latest resume, and generate a formal, tailored application email for each one. Review and edit every draft, then press **Send** to email it from your own account **with your resume attached**.

By default it runs **entirely on your machine**, through an **AI agent you already pay for** — no Offerly account, no shared API key, and your resume never leaves your computer.

---

## Choose your AI engine

Offerly is not tied to one provider. Open **⚙ Engine**, pick your provider, then choose one of **two ways to connect it**:

| | What it is | What it costs |
|---|---|---|
| 🔐 **Sign in** | Your own account, through that vendor's official CLI login | Runs on the plan you already pay for — Claude Pro/Max, ChatGPT Plus/Pro, Google, Cursor |
| 🔑 **API key** | A key you paste in | Pay-per-token, billed separately from any chat subscription |

Claude, ChatGPT and Gemini each offer both. Cursor is sign-in only, Ollama needs neither, and an OpenAI-compatible endpoint is key only.

Fill in whatever the chosen path asks for and press **Connect** — Offerly sends one short prompt to prove the engine really answers before you wait on a full analysis. A bad key or a missing CLI fails there, with the provider's own message.

Each engine declares what it needs, so the form changes with your choice: an API key for a provider, a base URL and model for a custom endpoint, an optional binary path for a CLI that is not on `PATH`, or the command line for any other agent.

| Provider | What you need |
|----------|---------------|
| **Claude** · Anthropic | an Anthropic API key |
| **ChatGPT** · OpenAI | an OpenAI API key |
| **Gemini** · Google | a Google AI Studio key (has a free tier) |
| **OpenRouter** | one key, most models behind it |
| **Groq** · **DeepSeek** · **Mistral** · **Together AI** · **xAI Grok** · **Perplexity** | that provider's key |
| **LM Studio / vLLM** | a server you run yourself; key usually blank |
| **Any other OpenAI-compatible API** | base URL, key and model |

Each one already knows its own endpoint: you supply a key and, where the provider needs it, a model name. Press **Connect** and Offerly sends one short prompt to prove the key works before you wait on a full analysis.

### Why there is no “sign in with Claude”

Because none of them sell that. A chat subscription — Claude Pro, ChatGPT Plus, Gemini Advanced, SuperGrok — licenses **their** app, not API access, and there is no OAuth scope anywhere that lets another program spend it:

- **Anthropic** restricts Free, Pro and Max OAuth tokens to Claude Code and claude.ai, and enforces it server-side.
- **“Sign in with ChatGPT”** exists but grants identity only — who you are, not the right to run a model on your plan.
- **Google** sign-in likewise: Gemini inference needs an API key, or a Vertex project you pay for yourself.
- **xAI** has no consumer sign-in for inference at all.

Earlier versions offered a sign-in that worked by launching each vendor's own CLI, the one client they do license for subscription use. It only worked if you had that CLI installed, so it was never available to everyone, and a hosted copy could never offer it. The adapters are still in `engines.js`: `start.cmd` turns them on (it sets `OFFERLY_ENABLE_SSO=1`), so a Claude Code, Gemini CLI or Codex install signed in on your machine shows up as an engine. Starting with `node bridge.js` leaves them off unless you set that variable yourself.

### Where your keys are kept

A key you enter is saved to **`offerly.engines.json`** in the project folder, readable only by you and gitignored — the same arrangement as the SMTP password in `offerly.mail.json`. It is never sent back to the page: the form only reports that a key is set.

Untick **"Save this key on my computer"** and it stays in that browser's local storage instead, travelling with each request. That is the option for a shared machine, or for a hosted copy that has no disk of its own. **Clear** removes both copies.

### Environment variables

Everything above can also come from the environment, which is how a serverless deployment is configured. A saved value wins over an environment variable, and the ⚙ panel says which one is in force.

| Engine | Variables |
|--------|-----------|
| OpenAI / Anthropic / Gemini API | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` |
| OpenAI-compatible | `OFFERLY_OPENAI_BASE_URL`, `OFFERLY_OPENAI_KEY`, `OFFERLY_OPENAI_MODEL` |
| CLI binaries | `CLAUDE_BIN`, `GEMINI_BIN`, `CODEX_BIN`, `CURSOR_BIN`, `OLLAMA_BIN` |
| Custom agent | `OFFERLY_AGENT_CMD`, `OFFERLY_AGENT_ARGS` |

Other useful overrides:

```bash
OFFERLY_ENGINE=gemini node bridge.js                   # default engine at startup
OFFERLY_GEMINI_ARGS="-m gemini-2.5-pro" node bridge.js # replace an engine's CLI flags outright
OFFERLY_TIMEOUT_MS=360000 node bridge.js               # give a slow local model more time
```

Every CLI engine receives its prompt on **stdin**, because a resume plus a job post is far longer than a Windows command line allows. If your CLI version wants different flags, set `OFFERLY_<ENGINE>_ARGS` rather than editing `engines.js`.

Only **Ollama** and a custom command cannot read screenshots; for those, paste the job text instead.

## Where the jobs come from

Three different things, kept clearly apart on the page, because they are not equally trustworthy.

**✅ Confirmed openings** are listed right now on the employer's own hiring system, with the employer's own date, place and link:

| Source | How it is found |
|--------|-----------------|
| Greenhouse, Lever, Ashby, Workable, Recruitee, SmartRecruiters, Breezy | each company's own job board — found from its careers page (a board it links to is certainly its own) or from its name, with the board's ownership checked |
| Workday | the career sites most multinationals use, searched by title and narrowed to your country |
| Workable's search across all its employers | Gulf employers in particular hire through Workable, so this finds companies nobody shortlisted |
| Employers known to hire in Saudi Arabia, the UAE, Qatar and Pakistan (`seeds.js`) | read on every search, so those markets do not depend on the model naming the right companies |
| A web search engine (optional, see below) | employers with matching postings on their own boards, found through Google Programmable Search or Brave Search |

**🟡 Job-board listings** come from Remotive, Jobicy, RemoteOK, Himalayas, We Work Remotely, Working Nomads and Arbeitnow. Boards copy postings, keep them after they close, re-date old ones and call a US-only role "worldwide", so each board posting is **checked against the employer's own board** wherever the employer has one: the employer's date, place and link replace the board's; if the employer's board no longer has the job, it has closed and is dropped; if the employer's posting fails a filter the board's copy passed, the board was wrong. Only a board posting whose employer has no public board to check against stays in this group, and its card says so.

**🔍 Suggestions** are the recruiter model's judgement about which companies hire your profile — never openings. Their links open a search filtered to your country and dates.

### Your search profile

As soon as you upload your resume, the **positions** you fit and the **skills** you have actually used appear as tags under the upload box — a quick read at once, then the AI's reading a few seconds later. Check them before anything is searched: remove a tag with ×, type or paste new ones (commas split them), set the country, posting window, work setup and career stage, and press **Analyze**. The analysis, the recruiter shortlist and the live search all use exactly those tags. To change the search later, edit the profile on the results page and press **Update results** — only the live search runs again.

Every part of the profile is a requirement. A posting is only shown if it clears **all** of these:

- **Published inside your window**, by the employer's own *first-published* date where there is one. Edits do not count as new; a board's re-dated copy is replaced by the employer's date. A posting with no date is dropped.
- **Open to someone in your country.** Each alternative in the location is read on its own: "Remote – EMEA / Remote – US" is open to Saudi Arabia, "EMEA, Portugal" is Portugal only, "Columbus, IN" is Indiana, not India. A bare "Remote" with no region is not taken to mean worldwide. **Remote (Global)** shows only roles open from anywhere.
- **Your work setup**, as the posting states it. For an on-site search, a posting at a named place that offers no remote or hybrid option at all counts as on-site, and its card marks it.
- **One of your positions.** The title must name the same job — the head word decides what a title *is*: "QA Lead" is a lead, "Backend Engineering Manager" is a manager, "Senior Software Engineer, Platform" is an engineer — and every identifying word of the position, short ones included ("QA", "UI", "ML"). "QA Lead" matches "Test Lead" and "Lead QA Engineer", not "Sales Lead"; "Software Engineer" matches backend, frontend and full-stack engineers, not Sales, Data, DevOps or "Software Engineer in Test"; "QA Engineer" is not construction "QA/QC Engineer". Each card says which of your positions it matched.
- **The seniority is within one step of yours.** Graduate and Tamheer programmes count as entry level.
- **Your skills in the job description** — at least one, and not only generic ones like "Agile" or "Jira".
- **The link is proven.** Opened just now, still that posting after any redirect, showing its title and not saying it is closed — or, for an employer's own system whose page builds itself in the browser, listed by that system moments ago at a page that loads. A board's page that cannot be opened is never shown.

The summary above the list says how many postings were checked and how many were left out for each reason (including "closed at the employer"), so a short list reads as a strict one rather than a broken one.

### Search the big job sites too

LinkedIn, Indeed, Glassdoor, ZipRecruiter, Bayt, GulfTalent, NaukriGulf, Rozee, Mustakbil, Naukri, Totaljobs, Reed, StepStone, Jobstreet, SEEK and the rest publish no feed and do not allow other apps to read their listings, so none of them is in the checked list. Under the results, a panel opens each one's own search for your position, in your country, filtered by date and work setup where the site's address can say so — the sites that matter for the chosen country first. Sites whose own search cannot be opened with the position filled in are searched through Google, restricted to the site, and the button says *via Google*. Three more buttons search the web for employers' own job pages: postings on the hiring systems companies use (on Google and on Bing), and companies' careers pages with the big boards left out.

### Finding employers through a web search engine (optional)

With a key for a search engine's official API, the search also asks the web which employers have matching postings on their own boards, and reads those boards like any other — every posting still goes through the filters and the link check.

```bash
GOOGLE_CSE_KEY=…  GOOGLE_CSE_CX=…  node bridge.js      # Google Programmable Search, 100 searches a day free
BRAVE_SEARCH_KEY=…  node bridge.js                    # or Brave Search
```

Without a key nothing is scraped: search results pages are against the engines' terms, which is why the panel opens those searches in your browser instead.

## How it works

```
Browser (index.html)  ──HTTP──►  app.js routes  ──spawn──►  agent CLI  ──►  your subscription
                                      ▲                └──HTTPS──►  provider API  ──►  your API key
                                      │
                   bridge.js (localhost:8787)  or  api/ (Vercel functions)
```

`app.js` holds every route and is shared by both front ends, so a local bridge and a Vercel deployment behave identically. The only difference is which engines are reachable: locally, the agent CLIs; on a serverless deployment, whichever API key is configured.

## Requirements

- **Node.js** (v18+) — run `npm install` once (needed for sending email; `start.cmd` does this for you)
- **At least one engine** from the table above

## Run it

```bash
# Windows: just double-click start.cmd, or:
node bridge.js
```

Then open **http://localhost:8787/**. The startup banner lists the agents it found.

1. Pick your **engine and model** in ⚙ and press **Connect**
2. **Upload** your resume (PDF / DOCX / TXT)
3. Select **target country** and **career stage**
4. Hit **Analyze & Find My Jobs**

## The live ATS check

The moment a resume is read, a score out of 100 appears under the upload box, and it changes whenever the resume or your tags change. It is not a model's opinion: it is a fixed set of checks (`atsscore.js`), the ones ATS parsers and recruiters' screening tools apply, each worth set points — so the same resume always gets the same score, and every lost point comes with the fix that wins it back:

| Area | Checks |
|------|--------|
| Parsing & format (20) | readable text · name and contact read first in the file's own text layer · one column · no unreadable symbols · length · file type |
| Sections (15) | experience · education · skills · summary · dates on every job |
| Contact (10) | email · phone · LinkedIn · location |
| Keywords (20) | a target position near the top · how many of your search skills appear · skills shown in jobs, not only listed |
| Impact (20) | bullets with a result and a number · strong opening verbs · bullet length · bullets per job |
| Language (15) | no "I"/"my" · no clichés · no machine-sounding words · active voice · dates written one way |

Each fix says who can make it: **✨ Fix my resume** (on its own, or in its rewrite) or **✍️ only you** — a number, a tool you used or a job's detail is a fact only you know, so it is never written for you. Under the checks, an AI recruiter reviews the resume the way they would before deciding whether to call you.

## Fix my resume

**✨ Fix my resume** applies the fixes to your resume *as you designed it*, not to a plain-text copy.

- **PDF** — the layout is rebuilt from the file: each line's font, size, weight and colour, indents and alignment, bullets, rules under headings, right-aligned dates, sidebar layouts and links, in the **fonts embedded in your PDF** (so a resume set in DejaVu Sans or Lato stays in it even where that font is not installed). Header banners, photos and logos above the text are kept exactly as drawn, with your text laid back over them. Lines that wrapped become one paragraph, so rewritten text reflows instead of spilling over.
- **Word (.docx)** — rendered from the document's own styles, numbering and tab stops.
- **Text** — laid out as a clean page.

The AI rewrites paragraphs only — in parts side by side, each seeing the whole resume — and is told which check each paragraph failed. It is asked to write like you, not like an AI: plain verbs, no "spearheaded" or "leveraged", no stock phrases, varied openings, your own spelling. Every rewritten paragraph is then checked before it is used:

- a **number** your resume does not contain → the paragraph is kept as you wrote it;
- a **tool, skill or name** your resume never mentions, or one said to be used in a job whose own text does not say so → kept as you wrote it (even when the recruiter review calls a keyword "missing": adding it is your call);
- a machine-sounding word, a cliché, an em dash or an overlong paragraph → one more try, then plain words.

Dates are written one way automatically, and the rebuilt page puts your name and contact details first in the text an ATS reads. The popup shows the ATS score before and after and updates it as you edit; changed text is highlighted. **✓ Reviewed — download PDF & use** prints it through Edge or Chrome on your machine (set `OFFERLY_BROWSER` if yours is elsewhere): real, selectable text in reading order, headings kept with what follows, no line or bullet split across pages. That PDF is then the resume that is scored, searched with and attached to your applications.

A hosted copy has no browser to print with, so it opens the print dialog (**Save as PDF**) instead. A scanned PDF has no text layer to rebuild, so it falls back to a plain-text rewrite.

## Bulk apply

Open **http://localhost:8787/apply**.

1. **Email setup** (once) — pick your provider and enter your SMTP login.
   - **Gmail:** turn on 2-Step Verification, create an [App password](https://myaccount.google.com/apppasswords), and use `smtp.gmail.com`, port `587`.
   - **Outlook / Microsoft 365:** `smtp.office365.com`, port `587` (your admin may need to allow SMTP AUTH).
   - Settings are saved to `offerly.mail.json` in the project folder (gitignored). Use **Save and test** to check the connection.
2. **Upload your resume** — it's attached to every email and used to tailor each letter.
3. **Add jobs**
   - **Link** — paste one link, or paste several at once and they become separate jobs.
   - **Screenshot** — click, drop, or press **Ctrl+V** anywhere on the page (up to 5 per job).
   - **Text** — paste the job post.
   - **Send to** is optional; leave it blank to use the email address written in the post.
4. **Generate emails** — two jobs are processed at a time.
5. **Review** each draft (To, Subject, Message), then press **Send** and **Confirm send**.

Offerly never guesses a recipient. If the post has no application email, the draft asks you to add one before it can be sent.

## Deploy to Vercel

The repo deploys as-is: the two pages are served as static files and `api/` exposes the same routes as the local bridge.

```bash
npm i -g vercel
vercel          # preview
vercel --prod
```

**Deploy it and it works — no environment variables required.** Open the site, go to **⚙ Engine**, pick a provider, paste your API key and press **Connect**. The key is kept in your own browser and travels only with your own requests; the deployment stores nothing. Each visitor connects their own, and nobody sees anyone else's.

The other two arrangements still work:

- **Put a key in the project's environment variables** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or the `OFFERLY_OPENAI_*` trio) and the deployment answers for everyone, billed to that one key. Share the link only with people you mean to pay for.
- **Anything that runs on your own computer stays on your own computer.** Claude Code, Gemini CLI, Codex, Cursor, Ollama and LM Studio are offered only by a copy opened from `http://localhost:8787` — a hosted page lists API keys only and never reaches into the visitor's machine. To use your Claude Pro plan or a local model, run Offerly locally.

A hosted page always uses the deployment it came from: on the deployment's key if it has one, otherwise on the key you paste, kept in your browser.

### Sending email from the hosted copy

Same rule. Enter your SMTP login under **✉ Email setup** and it is kept in your browser and sent with the message it is needed for. To have the deployment send for everyone instead, set the `OFFERLY_SMTP_*` variables below.

The `OFFERLY_SMTP_*` variables, if you want the deployment itself to send:

| Variable | Example |
|----------|---------|
| `OFFERLY_SMTP_HOST` | `smtp.gmail.com` |
| `OFFERLY_SMTP_PORT` | `587` |
| `OFFERLY_SMTP_USER` | `you@gmail.com` |
| `OFFERLY_SMTP_PASS` | your app password |
| `OFFERLY_SMTP_FROM` / `OFFERLY_SMTP_FROM_NAME` | optional display address and name |

A hosted backend deliberately ignores `offerly.mail.json` and `offerly.engines.json` even if a copy reaches the server, so a credential file left in a build can never be used or shown to visitors. Its `/api` endpoint also answers only pages served by that same deployment, so another website cannot spend your key. The local bridge is locked the same way: it answers only pages it served itself, plus any origin you list in `OFFERLY_ALLOWED_ORIGINS`.

Serverless limits worth knowing:

- **Function timeout** is 60s on Vercel's Hobby plan. A full analysis through a fast API model fits; a slow one may not. On Pro, raise `maxDuration` in `vercel.json` to 300 and set `OFFERLY_TIMEOUT_MS` to match.
- **Request bodies** are capped at ~4.5 MB, so large screenshot batches should go through the local bridge.
- **Agent CLIs and local model servers cannot run** on serverless, so a hosted copy does not list them.

### Email & security notes

- The email and URL-fetching endpoints only accept requests from `http://localhost:8787`, from the deployment's own pages, or from an origin you list in `OFFERLY_ALLOWED_ORIGINS`. The local bridge listens on `127.0.0.1` only, so other devices on your network can't use it.
- Bulk apply works the same on a hosted copy: enter your SMTP login under **✉ Email setup** and it is kept in your browser.
- Many sites (LinkedIn especially) require a login or JavaScript to show a job. If a link fails, use a screenshot or paste the text instead.
- Screenshots are written to a temporary folder for Claude Code to read and deleted right after.

## Notes & honest limits

- **A "live opening" really is one.** It came from a feed, with that feed's own date and link, and the link was checked before you saw it. A "suggestion" is explicitly labelled as one and links to a filtered search, not to a vacancy.
- **Job links are live searches, not fabricated URLs.** Apply buttons open real, current postings — nothing is invented. **Recruiter emails are never guessed** — "Apply by Email" drafts the cover letter and opens Gmail with the **recipient left blank**, because `careers@<domain>`-style guesses bounce for most companies. Find the real application address on the company's careers page (the "Careers ↗" link) and paste it in.
- **Gmail can't auto-attach files** from the job finder's "Apply by Email" (browser security). The compose window opens pre-filled; you drag your resume in and send. Bulk apply sends through SMTP instead, so it attaches the resume for you.
- Through a local agent CLI a full analysis takes ~1.5–2.5 minutes; a direct API engine is faster but billed per token.
- Running locally, your resume never leaves your machine except in the call to your own AI subscription. If you deploy to Vercel **with an API key**, prompts go to that provider instead — worth knowing before you share the link.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Job finder (resume analysis, ATS score, matched roles) |
| `apply.html` | Bulk apply — generate, review and send application emails |
| `app.js` | Every route: AI calls, job-page fetching, email — shared by the bridge and Vercel |
| `engines.js` | Engine registry: what each agent needs, how to find it, how to call it |
| `jobfeeds.js` | Live job feeds: the public sources, the filters, and the link check |
| `places.js` | Reads a posting's location into the countries and regions it is open to |
| `resumeformat.js` | Rebuilds an uploaded resume in its own layout, so a fix keeps its format |
| `pdfrender.js` | Prints the fixed resume to PDF with the local Edge or Chrome |
| `atsscore.js` | The ATS checks and their points |
| `seeds.js` | Employers known to hire in the Gulf and Pakistan, with their job boards |
| `websearch.js` | Optional employer discovery through Google Programmable Search or Brave Search |
| `bridge.js` | Local server on `localhost:8787` |
| `api/` | Vercel functions — thin wrappers around `app.js` |
| `vercel.json` | Deployment config (routing, function limits) |
| `package.json` | Node dependency (`nodemailer`) |
| `start.cmd` | One-click launcher (Windows) |
