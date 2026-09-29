# Offerly — *Engineered to get you offers*

Offerly is a single-page AI job-search copilot. Upload your resume, pick a target country and career stage, and it acts like a top-1% tech recruiter:

- **Deep resume analysis** — seniority, experience, strengths, and market-specific gaps
- **ATS compatibility score** /100 with a six-area breakdown and quick fixes
- **Verified live openings** — real postings pulled from public job feeds, each with the date its source published it and a link straight to that posting. Filter by **posted within** (24 hours → a month) and **work setup** (remote / hybrid / on-site), the way you would on LinkedIn.
- **Plus a recruiter shortlist** of real companies that hire this profile, split into **High / Medium / Stretch** with a **fit score** — every link pre-filtered to the dates and work setup you chose
- **Channel-aware Apply** — for each role the recruiter picks the most realistic application route and the button matches it: LinkedIn Easy Apply, Indeed, Glassdoor, Bayt, NaukriGulf, GulfTalent, TASC, Hays, the company career page, or email — with a regional bias (Gulf boards for Gulf markets, LinkedIn/Indeed for global)
- **Apply by Email** — generates a cover letter *tailored to that exact role* and opens Gmail compose pre-filled (recipient + subject + letter + your signature). Drag in your resume and send.
- **Resume improvement suggestions** — prioritized and actionable
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

| Provider | Sign in | API key |
|----------|:-------:|:-------:|
| **Claude** · Anthropic | ✅ your Claude Pro / Max plan | ✅ |
| **ChatGPT** · OpenAI | ✅ your Plus / Pro plan | ✅ |
| **Gemini** · Google | ✅ your Google account | ✅ |
| **Cursor** | ✅ your Cursor subscription | — |
| **Ollama** — on your machine | neither: free and offline | — |
| **OpenRouter** — most models behind one key | — | ✅ |
| **Groq** · **DeepSeek** · **Mistral** · **Together AI** · **xAI Grok** · **Perplexity** | — | ✅ |
| **LM Studio / vLLM** — a server you run | — | optional |
| **Any other OpenAI-compatible API** | — | ✅ |
| **Any other agent** — a CLI that reads stdin | — | — |

The sign-in column needs that vendor's CLI installed, since the login runs through it; the panel shows the one-line install command when it is missing. Every API-key provider already knows its own endpoint — you supply a key and a model name, nothing else.

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

Two different things, kept clearly apart on the page, because they are not equally trustworthy.

**✅ Live openings** are fetched while you wait, from public feeds that publish a date and a permanent link:

| Source | Covers |
|--------|--------|
| Remotive, Jobicy, RemoteOK | remote roles across the whole market |
| Arbeitnow | remote and on-site, strongest in Europe |
| Greenhouse, Lever, Ashby | each shortlisted company's own careers feed — how on-site roles are found |

Postings from a company's own feed are marked **direct** and sort above a board's copy of the same job on the same day: it is the source, its link outlives the aggregator's, and it is the one that stays accurate. Company tokens are guessed from the name, so where the feed says whose board it is, that is checked before its jobs are trusted.

A posting is only shown if it clears all of these:

- **Published inside your window**, per the source's own date.
- **The link is followed and proved to be that posting.** Not just a status code: the page is opened, any redirect is followed and stored so you are not bounced again, a landing on the board's front page or search results counts as gone, and most of the title's distinctive words have to appear on the page that answers. A link that cannot be proved is kept but labelled, never dressed up as confirmed.
- **The old check, for contrast.** A status code is not enough: most boards answer 200 with a "this job is no longer available" page, so the page text is read too. Phrases are matched on word boundaries, because a substring test reads "Salary Undisclosed" as closed and throws away live postings. A rate limit or an outage is treated as our problem, not the posting's, so those links are kept.
- **The title matches one of your target roles as a phrase.** Each role is matched on its own rather than pooled into a bag of words — pooling was why "Data Engineer" in your list let "Data Entry Clerk" through on the word "data". A role's identifying words must all be present, and the head word has to agree, with `engineer`/`developer`/`programmer` treated as the same thing and `full stack`/`fullstack` spelled either way.
- **The seniority is within one step of yours.** No internships for a senior engineer, and no engineering-director posts either.
- **Your skills appear in the job description** where the title alone is too vague to judge. Descriptions also rank the survivors, so a posting naming your actual stack sorts above one that does not.
- **Its stated location is in your country** and its work setup matches. Postings with no location or no stated arrangement are dropped rather than guessed at, and every link is checked before the page shows it, so a vacancy the employer has already pulled does not reach you.

**Honest limits.** Coverage is excellent for remote roles and for companies on Greenhouse, Lever or Ashby. It is thin for on-site roles in markets served mainly by regional boards — Bayt, GulfTalent and NaukriGulf publish no open API, and LinkedIn and Indeed do not allow this kind of access. When nothing is verified the page says so, tells you how many companies and postings it checked, and falls back to the shortlist.

**Only a link that goes to the posting says so.** A live opening's button reads *Open this posting* and lands on that exact job. A suggestion's button reads *Search LinkedIn* — because that is what it does. No button promises to apply somewhere it cannot take you; a search that says "Apply on LinkedIn" and lands on an empty results page is indistinguishable from a broken link, which is why the wording matters.

**🔍 Suggestions** are the recruiter model's judgement about which companies hire your profile. The model is asked for *employers*, never for a specific vacancy — anything it remembers about a particular posting is as old as its training data, which is what made earlier results look stale. Each suggestion links to a search already filtered to your choices:

| Board | Date filter | Work setup |
|-------|-------------|------------|
| LinkedIn | `f_TPR` + `sortBy=DD` | `f_WT` (on-site / remote / hybrid) |
| Indeed | `fromage` + `sort=date` | in the query |
| Glassdoor | `fromAge` | in the query |
| Bayt, GulfTalent, TASC, Hays | `tbs=qdr` on a site-scoped search | in the query |

Google only exposes day, week and month reliably, so a 3-day or 2-week filter is widened to the nearest range it supports rather than quietly dropped.

Your **work setup** choice also reaches the resume analysis: pick Remote and the improvements cover async written communication, self-direction and time-zone overlap; pick On-site and they cover work authorisation, relocation and local presence.

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
- **Run the bridge on your own machine** and the hosted page will use it, which is the way to keep using a Claude Code / Gemini / Codex / Cursor subscription rather than a paid API. Start it with
  `OFFERLY_ALLOWED_ORIGINS="https://your-app.vercel.app" node bridge.js`.

The page picks between these by itself: it uses the deployment when the deployment can answer — on its own key or on yours — and only looks for a local bridge when neither can.

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

A hosted backend deliberately ignores `offerly.mail.json` and `offerly.engines.json` even if a copy reaches the server, so a credential file left in a build can never be used or shown to visitors. Its `/api` endpoint also answers only pages served by that same deployment, so another website cannot spend your key. (The local bridge stays open on purpose — that is how a page hosted elsewhere reaches the agent on your machine.)

Serverless limits worth knowing:

- **Function timeout** is 60s on Vercel's Hobby plan. A full analysis through a fast API model fits; a slow one may not. On Pro, raise `maxDuration` in `vercel.json` to 300 and set `OFFERLY_TIMEOUT_MS` to match.
- **Request bodies** are capped at ~4.5 MB, so large screenshot batches should go through the local bridge.
- **Agent CLIs cannot run** on serverless. They are shown as unavailable there, and the page says the prompt will run on your machine instead.

### Email & security notes

- The email and URL-fetching endpoints only accept requests from `http://localhost:8787`, from the deployment's own pages, or from an origin you list in `OFFERLY_ALLOWED_ORIGINS`. The local bridge listens on `127.0.0.1` only, so other devices on your network can't use it.
- To use bulk apply from a hosted copy (e.g. Vercel), start the bridge with
  `OFFERLY_ALLOWED_ORIGINS="https://your-app.vercel.app" node bridge.js`.
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
| `bridge.js` | Local server on `localhost:8787` |
| `api/` | Vercel functions — thin wrappers around `app.js` |
| `vercel.json` | Deployment config (routing, function limits) |
| `package.json` | Node dependency (`nodemailer`) |
| `start.cmd` | One-click launcher (Windows) |
