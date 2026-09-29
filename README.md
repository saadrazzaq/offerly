# Offerly — *Engineered to get you offers*

Offerly is a single-page AI job-search copilot. Upload your resume, pick a target country and career stage, and it acts like a top-1% tech recruiter:

- **Deep resume analysis** — seniority, experience, strengths, and market-specific gaps
- **ATS compatibility score** /100 with a six-area breakdown and quick fixes
- **20+ real-company opportunities** (startups, scale-ups, MNCs, consulting, agencies) split into **High / Medium / Stretch** with a **fit score** per role
- **Channel-aware Apply** — for each role the recruiter picks the most realistic application route and the button matches it: LinkedIn Easy Apply, Indeed, Glassdoor, Bayt, NaukriGulf, GulfTalent, TASC, Hays, the company career page, or email — with a regional bias (Gulf boards for Gulf markets, LinkedIn/Indeed for global)
- **Apply by Email** — generates a cover letter *tailored to that exact role* and opens Gmail compose pre-filled (recipient + subject + letter + your signature). Drag in your resume and send.
- **Resume improvement suggestions** — prioritized and actionable
- **Bulk apply** (`/apply`) — add any number of jobs as **links, screenshots or pasted text**, upload your latest resume, and generate a formal, tailored application email for each one. Review and edit every draft, then press **Send** to email it from your own account **with your resume attached**.

By default it runs **entirely on your machine**, through an **AI agent you already pay for** — no Offerly account, no shared API key, and your resume never leaves your computer.

---

## Choose your AI engine

Offerly is not tied to one provider. The bridge detects every agent installed on your machine and lists them under **⚙ Engine**; pick one and it is remembered per browser. Anything not installed is shown greyed out with the command that enables it.

| Engine | How it bills | What you need |
|--------|--------------|---------------|
| **Claude Code** | your Claude subscription | the VS Code extension or CLI, signed in (auto-detected) |
| **Gemini CLI** | your Google account | `npm i -g @google/gemini-cli`, then run `gemini` once |
| **OpenAI Codex CLI** | your ChatGPT plan | `npm i -g @openai/codex`, then run `codex` once |
| **Cursor CLI** | your Cursor subscription | Cursor installed, `cursor-agent login` |
| **Ollama** | free, fully offline | Ollama + a pulled model (`ollama pull llama3.1`) |
| **Other agent** | whatever it uses | any CLI that reads a prompt on stdin: `OFFERLY_AGENT_CMD` |
| **OpenAI / Anthropic / Gemini API** | pay-per-token | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` |
| **Any OpenAI-compatible API** | pay-per-token | OpenRouter, Groq, Together, DeepSeek, LM Studio, vLLM — see below |

Useful overrides:

```bash
OFFERLY_ENGINE=gemini node bridge.js          # default engine at startup
CLAUDE_BIN="C:\path\to\claude.exe" node bridge.js   # also GEMINI_BIN, CODEX_BIN, CURSOR_BIN, OLLAMA_BIN
OFFERLY_GEMINI_ARGS="-m gemini-2.5-pro" node bridge.js # replace an engine's CLI flags outright
OFFERLY_TIMEOUT_MS=360000 node bridge.js               # give a slow local model more time

# any OpenAI-compatible endpoint
OFFERLY_OPENAI_BASE_URL="https://openrouter.ai/api/v1" \
OFFERLY_OPENAI_KEY=sk-... OFFERLY_OPENAI_MODEL="anthropic/claude-sonnet-4.5" node bridge.js
```

Every CLI engine receives its prompt on **stdin**, because a resume plus a job post is far longer than a Windows command line allows. If your CLI version wants different flags, set `OFFERLY_<ENGINE>_ARGS` rather than editing `engines.js`.

Only **Ollama** and a custom command cannot read screenshots; for those, paste the job text instead.

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

1. Pick your **engine and model** in ⚙
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

How the hosted copy gets its AI depends on what you configure:

- **Set an API key** in the Vercel project's environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or the `OFFERLY_OPENAI_*` trio) and the deployment answers on its own — anyone you share the link with can use it, billed to that key.
- **Set nothing** and the page automatically falls back to a bridge on the visitor's own machine, exactly as before. Start it with
  `OFFERLY_ALLOWED_ORIGINS="https://your-app.vercel.app" node bridge.js`.

To send email from the hosted copy, set the SMTP login as environment variables — a serverless deployment has no writable disk, so `offerly.mail.json` is not available there:

| Variable | Example |
|----------|---------|
| `OFFERLY_SMTP_HOST` | `smtp.gmail.com` |
| `OFFERLY_SMTP_PORT` | `587` |
| `OFFERLY_SMTP_USER` | `you@gmail.com` |
| `OFFERLY_SMTP_PASS` | your app password |
| `OFFERLY_SMTP_FROM` / `OFFERLY_SMTP_FROM_NAME` | optional display address and name |

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
| `engines.js` | Engine registry: finds each agent, builds its command line, calls the APIs |
| `bridge.js` | Local server on `localhost:8787` |
| `api/` | Vercel functions — thin wrappers around `app.js` |
| `vercel.json` | Deployment config (routing, function limits) |
| `package.json` | Node dependency (`nodemailer`) |
| `start.cmd` | One-click launcher (Windows) |
