# Offerly — *Engineered to get you offers*

Offerly is a single-page AI job-search copilot. Upload your resume, pick a target country and career stage, and it acts like a top-1% tech recruiter:

- **Deep resume analysis** — seniority, experience, strengths, and market-specific gaps
- **ATS compatibility score** /100 with a six-area breakdown and quick fixes
- **20+ real-company opportunities** (startups, scale-ups, MNCs, consulting, agencies) split into **High / Medium / Stretch** with a **fit score** per role
- **Channel-aware Apply** — for each role the recruiter picks the most realistic application route and the button matches it: LinkedIn Easy Apply, Indeed, Glassdoor, Bayt, NaukriGulf, GulfTalent, TASC, Hays, the company career page, or email — with a regional bias (Gulf boards for Gulf markets, LinkedIn/Indeed for global)
- **Apply by Email** — generates a cover letter *tailored to that exact role* and opens Gmail compose pre-filled (recipient + subject + letter + your signature). Drag in your resume and send.
- **Resume improvement suggestions** — prioritized and actionable
- **Bulk apply** (`/apply`) — add any number of jobs as **links, screenshots or pasted text**, upload your latest resume, and generate a formal, tailored application email for each one. Review and edit every draft, then press **Send** to email it from your own account **with your resume attached**.

It runs **entirely on your machine** and is powered by your **Claude Code subscription** — no Anthropic API key and no API credits required.

---

## How it works

```
Browser (index.html)  ──HTTP──►  bridge.js (localhost:8787)  ──spawn──►  Claude Code CLI  ──►  your subscription
```

A tiny local Node server (`bridge.js`) runs the bundled Claude Code binary headless (`claude -p`). The web page calls `localhost` instead of the Anthropic API, so everything is billed to your existing Claude Code/Claude subscription.

## Requirements

- **Node.js** (v18+) — run `npm install` once (needed for sending email; `start.cmd` does this for you)
- **Claude Code** installed (the VS Code extension or CLI) and signed in — the bridge auto-detects the bundled `claude.exe`

## Run it

```bash
# Windows: just double-click start.cmd, or:
node bridge.js
```

Then open **http://localhost:8787/**.

1. Pick your **model** in ⚙ (Sonnet = balanced, Opus = deepest, Haiku = fastest)
2. **Upload** your resume (PDF / DOCX / TXT)
3. Select **target country** and **career stage**
4. Hit **Analyze & Find My Jobs**

> Tip: if the bridge can't find Claude automatically, set the path manually:
> `CLAUDE_BIN="C:\path\to\claude.exe" node bridge.js`

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

### Email & security notes

- The email and URL-fetching endpoints only accept requests from `http://localhost:8787`. The bridge also listens on `127.0.0.1` only, so other devices on your network can't use it.
- To use bulk apply from a hosted copy (e.g. Vercel), start the bridge with
  `OFFERLY_ALLOWED_ORIGINS="https://your-app.vercel.app" node bridge.js`.
- Many sites (LinkedIn especially) require a login or JavaScript to show a job. If a link fails, use a screenshot or paste the text instead.
- Screenshots are written to a temporary folder for Claude Code to read and deleted right after.

## Notes & honest limits

- **Job links are live searches, not fabricated URLs.** Apply buttons open real, current postings — nothing is invented. **Recruiter emails are never guessed** — "Apply by Email" drafts the cover letter and opens Gmail with the **recipient left blank**, because `careers@<domain>`-style guesses bounce for most companies. Find the real application address on the company's careers page (the "Careers ↗" link) and paste it in.
- **Gmail can't auto-attach files** from the job finder's "Apply by Email" (browser security). The compose window opens pre-filled; you drag your resume in and send. Bulk apply sends through SMTP instead, so it attaches the resume for you.
- Because it runs through the local CLI (not the paid API), a full analysis takes ~1.5–2.5 minutes.
- Your resume and data never leave your machine except in the local call to your own Claude subscription.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Job finder (resume analysis, ATS score, matched roles) |
| `apply.html` | Bulk apply — generate, review and send application emails |
| `bridge.js` | Local server: Claude Code bridge, job-page fetching, email sending |
| `package.json` | Node dependency (`nodemailer`) |
| `start.cmd` | One-click launcher (Windows) |
