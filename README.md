# Offerly — *Engineered to get you offers*

Offerly is a single-page AI job-search copilot. Upload your resume, pick a target country and career stage, and it acts like a top-1% tech recruiter:

- **Deep resume analysis** — seniority, experience, strengths, and market-specific gaps
- **ATS compatibility score** /100 with a six-area breakdown and quick fixes
- **20+ real-company opportunities** (startups, scale-ups, MNCs, consulting, agencies) split into **High / Medium / Stretch** with a **fit score** per role
- **Channel-aware Apply** — for each role the recruiter picks the most realistic application route and the button matches it: LinkedIn Easy Apply, Indeed, Glassdoor, Bayt, NaukriGulf, GulfTalent, TASC, Hays, the company career page, or email — with a regional bias (Gulf boards for Gulf markets, LinkedIn/Indeed for global)
- **Apply by Email** — generates a cover letter *tailored to that exact role* and opens Gmail compose pre-filled (recipient + subject + letter + your signature). Drag in your resume and send.
- **Resume improvement suggestions** — prioritized and actionable

It runs **entirely on your machine** and is powered by your **Claude Code subscription** — no Anthropic API key and no API credits required.

---

## How it works

```
Browser (index.html)  ──HTTP──►  bridge.js (localhost:8787)  ──spawn──►  Claude Code CLI  ──►  your subscription
```

A tiny local Node server (`bridge.js`) runs the bundled Claude Code binary headless (`claude -p`). The web page calls `localhost` instead of the Anthropic API, so everything is billed to your existing Claude Code/Claude subscription.

## Requirements

- **Node.js** (v18+)
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

## Notes & honest limits

- **Job links are live searches, not fabricated URLs.** Apply buttons open real, current postings — nothing is invented. **Recruiter emails are never guessed** — "Apply by Email" drafts the cover letter and opens Gmail with the **recipient left blank**, because `careers@<domain>`-style guesses bounce for most companies. Find the real application address on the company's careers page (the "Careers ↗" link) and paste it in.
- **Gmail can't auto-attach files** (browser security). The compose window opens pre-filled; you drag your resume in and send.
- Because it runs through the local CLI (not the paid API), a full analysis takes ~1.5–2.5 minutes.
- Your resume and data never leave your machine except in the local call to your own Claude subscription.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The entire web app (UI + logic) |
| `bridge.js` | Local server bridging the page to your Claude Code subscription |
| `start.cmd` | One-click launcher (Windows) |
